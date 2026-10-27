import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import katex from "katex";
import DOMPurify from "dompurify";
import { highlightFence, hydrateFence, renderMermaidBlock, MERMAID_LANGS } from "./mermaid.js";

/** `![](url){width=300 height=180}` 的尺寸后缀：把键值写进 img 属性 */
const SIZE_SUFFIX = /^\{\s*((?:(?:width|height|align)\s*=\s*[^}\s]+\s*)+)\}/i;

function parseSizeAttrs(body) {
  const attrs = {};
  const re = /(width|height|align)\s*=\s*([^}\s]+)/gi;
  let m;
  while ((m = re.exec(body))) {
    const key = m[1].toLowerCase();
    const value = m[2].replace(/^['"]|['"]$/g, "");
    if (key === "align") {
      if (/^(left|center|right)$/i.test(value)) attrs.align = value.toLowerCase();
      continue;
    }
    // 只接受数字 px 或百分比，避免把任意字符串塞进属性
    if (/^\d+(?:\.\d+)?(?:px|%)?$/.test(value)) attrs[key] = /^\d+(?:\.\d+)?$/.test(value) ? `${value}px` : value;
  }
  return attrs;
}

/**
 * 核心规则：把图片后的 `{width=.. height=.. align=..}` 后缀转成 img 属性。
 * 不写进 HTML 字符串，避免和 DOMPurify 的属性清洗顺序打架。
 */
function imageSizePlugin(md2) {
  md2.core.ruler.after("inline", "image_size_suffix", (state) => {
    for (const blockToken of state.tokens) {
      if (blockToken.type !== "inline" || !blockToken.children) continue;
      const children = blockToken.children;
      for (let i = 0; i < children.length; i++) {
        const token = children[i];
        if (token.type !== "image") continue;
        const next = children[i + 1];
        if (!next || next.type !== "text" || !next.content.startsWith("{")) continue;
        const match = SIZE_SUFFIX.exec(next.content);
        if (!match) continue;
        const attrs = parseSizeAttrs(match[1]);
        for (const [key, value] of Object.entries(attrs)) token.attrSet(key, value);
        next.content = next.content.slice(match[0].length);
        if (!next.content) children.splice(i + 1, 1);
      }
    }
  });
}

function createMd() {
  const md2 = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: false });
  md2.use(footnote);
  md2.use(imageSizePlugin);
  md2.inline.ruler.after("emphasis", "mark", (state, silent) => {
    const src = state.src.slice(state.pos, state.pos + 2);
    if (src !== "==") return false;
    const end = state.src.indexOf("==", state.pos + 2);
    if (end < 0) return false;
    if (!silent) {
      const token = state.push("html_inline", "", 0);
      token.content = `<mark>${md2.utils.escapeHtml(state.src.slice(state.pos + 2, end))}</mark>`;
    }
    state.pos = end + 2;
    return true;
  });
  md2.inline.ruler.after("mark", "math_inline", (state, silent) => {
    const start = state.src[state.pos];
    if (start !== "$") return false;
    const end = state.src.indexOf("$", state.pos + 1);
    if (end <= state.pos + 1) return false;
    const formula = state.src.slice(state.pos + 1, end);
    if (/[\s\n]/.test(formula[0] ?? " ")) return false;
    if (!silent) {
      const token = state.push("html_inline", "", 0);
      token.content = katex.renderToString(formula, { throwOnError: false, output: "html" }).replace('class="katex"', 'class="katex md-inline-math"');
    }
    state.pos = end + 1;
    return true;
  });
  md2.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const info = (token.info || "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const code = token.content;
    if (MERMAID_LANGS.includes(info)) {
      return `<div class="md-mermaid" data-diagram="${md2.utils.escapeHtml(code)}"></div>`;
    }
    const { html } = highlightFence(code, info);
    const langClass = info ? `cm-s-inner ${info}` : "cm-s-inner";
    return `<pre class="md-fences md-end-block ty-contain-cm modeLoaded"><div class="CodeMirror cm-s-inner" data-lang="${info}">${html}</div></pre>`;
  };
  md2.renderer.rules.table_open = () => '<figure class="md-table-figures"><div class="md-table-block"><table class="md-table">';
  md2.renderer.rules.table_close = () => "</table></div></figure>";
  md2.renderer.rules.bullet_list_open = (tokens, idx) => {
    const tokens2 = tokens[idx];
    return '<ul class="task-list contains-task-list">';
  };
  return md2;
}
const md = createMd();
const esc = (s) => md.utils.escapeHtml(s);
function dom(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== void 0) el.textContent = text;
  return el;
}
function setMathDark(dark) {
  mathDark = dark;
}
let mathDark = false;
/* 图片缓存统一走 rpc.js 的字节 LRU 层；render 层只做 in-flight 去重，避免 widget 重建时重复请求 */
const resolving = /* @__PURE__ */ new Map();
async function hydrateImages(root, resolveImage) {
  if (!resolveImage) return;
  const imgs = Array.from(root.querySelectorAll("img"));
  for (const img of imgs) {
    const url = img.getAttribute("src") || "";
    // 保留原始 URL：单张尺寸工具与资源面板都靠 data-src 定位源码
    if (!img.dataset.src && url && !url.startsWith("data:") && !url.startsWith("blob:")) img.dataset.src = url;
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) continue;
    let task = resolving.get(url);
    if (!task) {
      task = Promise.resolve().then(() => resolveImage(url)).catch(() => null);
      resolving.set(url, task);
      task.finally(() => resolving.delete(url)).catch(() => {});
    }
    const dataUrl = await task;
    if (dataUrl) img.src = dataUrl;
    else img.dataset.unresolved = url;
  }
}
let mermaidLook = "handDrawn";
function setMermaidLook(look) {
  mermaidLook = look;
}
async function hydrateMermaid(root) {
  const holders = Array.from(root.querySelectorAll(".md-mermaid"));
  if (!holders.length) return;
  for (const holder of holders) {
    const code = holder.getAttribute("data-diagram") || "";
    const el = holder;
    if (el.dataset.done) continue;
    el.dataset.done = "1";
    void renderMermaidBlock(code, el, mermaidLook, mathDark);
  }
}
function renderBlockToDom(text, options) {
  const root = dom("div");
  root.className = "md-block-render";
  const mode = options.mode;
  if (mode === "meta") {
    const pre = dom("pre", "md-meta-block", text);
    root.appendChild(pre);
    return { dom: root };
  }
  if (mode === "hr") {
    root.appendChild(dom("hr"));
    return { dom: root };
  }
  if (mode === "math") {
    const body = text.replace(/^\s*\$\$/, "").replace(/\$\$\s*$/, "");
    const p = dom("p", "md-math-block md-end-block");
    try {
      p.innerHTML = katex.renderToString(body, { displayMode: true, throwOnError: false, output: "html" });
    } catch {
      p.textContent = text;
    }
    root.appendChild(p);
    return { dom: root };
  }
  if (mode === "fence") {
    /* 注意 m 标志：块文本是多行，缺 m 时 $ 只匹配串尾，info 会永远取空 → mermaid 识别失败 */
    const info = (text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/m) || [])[2]?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const code = text.replace(/^ {0,3}(`{3,}|~{3,}).*\n?/, "").replace(/\n? {0,3}(`{3,}|~{3,})\s*$/, "");
    const { html: html2 } = highlightFence(code, info);
    if (MERMAID_LANGS.includes(info)) {
      const holder2 = dom("div", "md-mermaid");
      holder2.setAttribute("data-diagram", code);
      holder2.setAttribute("data-md-line", "0");
      root.appendChild(holder2);
    } else {
      const pre = dom("pre", "md-fences md-end-block ty-contain-cm modeLoaded");
      pre.setAttribute("data-md-line", "0");
      pre.setAttribute("data-lang", info);
      pre.innerHTML = `<div class="CodeMirror cm-s-inner" data-lang="${esc(info)}">${html2}</div>`;
      root.appendChild(pre);
    }
    return { dom: root };
  }
  if (mode === "html") {
    if (options.renderHtml) {
      const clean = DOMPurify.sanitize(text, { FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button"], FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"] });
      const holder2 = dom("div", "md-html-block");
      holder2.innerHTML = clean;
      root.appendChild(holder2);
    } else {
      root.appendChild(dom("pre", "md-fences md-html-raw", text));
    }
    return { dom: root };
  }
  const html = md.render(text);
  const holder = dom("div", "md-inline-render");
  holder.innerHTML = options.renderHtml ? DOMPurify.sanitize(html, { ADD_ATTR: ["target"], FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"] }) : DOMPurify.sanitize(esc(text).replace(/\n/g, "<br>"));
  holder.querySelectorAll("ul").forEach((ul) => {
    const hasTask = !!ul.querySelector('li > input[type="checkbox"], li > .task-list-item-checkbox');
    ul.className = hasTask ? "contains-task-list" : "";
    ul.querySelectorAll("li").forEach((li) => {
      if (li.querySelector(':scope > input[type="checkbox"], :scope > .task-list-item-checkbox')) li.classList.add("md-task-list-item", "task-list-item");
    });
  });
  holder.querySelectorAll("img").forEach((img) => {
    img.dataset.src = img.getAttribute("src") || "";
  });
  /* 点击定位：给顶层块元素标注源码行号（相对块内），供 sourcePosAt 映射 */
  annotateSourceLines(holder, text);
  root.appendChild(holder);
  return { dom: root };
}

/**
 * 给渲染结果标注 data-md-line：把顶层块元素按源码顺序对齐到源码行。
 * 段落/标题 = 单行；列表/引用 = 每行一个 li/段落；fence/table 由各自渲染路径处理。
 */
function annotateSourceLines(holder, text) {
  const sourceLines = text.split("\n")
  // 只取非空行的源码索引；渲染块按顺序与之对齐
  const contentLineIdxs = []
  sourceLines.forEach((line, idx) => { if (line.trim()) contentLineIdxs.push(idx) })
  const nextLine = () => (linePtr < contentLineIdxs.length ? contentLineIdxs[linePtr++] : 0)
  let linePtr = 0
  const blocks = Array.from(holder.children)
  for (const block of blocks) {
    const tag = block.tagName.toLowerCase()
    if (tag === "ul" || tag === "ol") {
      for (const li of Array.from(block.children)) li.setAttribute("data-md-line", String(nextLine()))
      continue
    }
    if (tag === "blockquote") {
      for (const el of block.querySelectorAll("p, li")) el.setAttribute("data-md-line", String(nextLine()))
      continue
    }
    if (tag === "figure") {
      /* 表格：figure 包裹；表格每行对应源码一行，逐行标注便于点到具体行 */
      const rows = block.querySelectorAll("thead tr, tbody tr")
      if (rows.length) {
        for (const tr of Array.from(rows)) tr.setAttribute("data-md-line", String(nextLine()))
      } else {
        block.setAttribute("data-md-line", String(nextLine()))
      }
      continue
    }
    block.setAttribute("data-md-line", String(nextLine()))
  }
}
function render(text, options) {
  const { dom: root } = renderBlockToDom(text, options);
  void hydrateImages(root, options.resolveImage);
  void hydrateFence(root);
  void hydrateMermaid(root);
  return { dom: root };
}
function renderDocument(text, options) {
  const write = dom("div");
  write.id = "write";
  const lines = text.split("\n");
  const html = md.render(text);
  write.innerHTML = options.renderHtml ? DOMPurify.sanitize(html, { FORBID_TAGS: ["script", "style"] }) : esc(text).replace(/\n/g, "<br>");
  write.querySelectorAll("ul").forEach((ul) => {
    const hasTask = !!ul.querySelector('li > input[type="checkbox"], li > .task-list-item-checkbox');
    ul.className = hasTask ? "contains-task-list" : "";
    ul.querySelectorAll("li").forEach((li) => {
      if (li.querySelector(':scope > input[type="checkbox"], :scope > .task-list-item-checkbox')) li.classList.add("md-task-list-item", "task-list-item");
    });
  });
  void lines;
  void hydrateImages(write, options.resolveImage);
  void hydrateFence(write);
  void hydrateMermaid(write);
  return write;
}
export {
  render,
  renderBlockToDom,
  renderDocument,
  setMathDark,
  setMermaidLook
};
