import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import katex from "katex";
import DOMPurify from "dompurify";
import { highlightFence, hydrateFence, renderMermaidBlock, MERMAID_LANGS } from "./mermaid.js";
import { inlineMarkupEnd, renderTaskLists } from "./inlineSyntax.js";
import { fenceContentRange } from "../cm/clickMap.js";

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

function createMd(allowHtml) {
  const md2 = new MarkdownIt({ html: allowHtml, linkify: true, breaks: true, typographer: false });
  md2.use(footnote);
  md2.use(imageSizePlugin);
  md2.use(renderTaskLists);
  md2.inline.ruler.after("emphasis", "mark", (state, silent) => {
    const end = inlineMarkupEnd(state.src, state.pos, "==", state.posMax);
    if (end < 0) return false;
    if (!silent) {
      const savedMax = state.posMax;
      state.pos += 2;
      state.posMax = end - 2;
      state.push("mark_open", "mark", 1);
      md2.inline.tokenize(state);
      state.push("mark_close", "mark", -1);
      state.posMax = savedMax;
    }
    state.pos = end;
    return true;
  });
  md2.inline.ruler.after("mark", "math_inline", (state, silent) => {
    const end = inlineMarkupEnd(state.src, state.pos, "$", state.posMax);
    if (end < 0) return false;
    if (!silent) {
      const formula = state.src.slice(state.pos + 1, end - 1);
      const token = state.push("html_inline", "", 0);
      token.content = katex.renderToString(formula, { throwOnError: false, output: "html" }).replace('class="katex"', 'class="katex md-inline-math"');
    }
    state.pos = end;
    return true;
  });
  md2.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const info = (token.info || "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const code = token.content;
    if (MERMAID_LANGS.includes(info)) {
      return `<div class="md-mermaid" data-diagram="${md2.utils.escapeHtml(code)}"></div>`;
    }
    const { html } = highlightFence(code);
    return `<pre class="md-fences md-end-block ty-contain-cm modeLoaded"><div class="CodeMirror cm-s-inner" data-lang="${md2.utils.escapeHtml(info)}">${html}</div></pre>`;
  };
  md2.renderer.rules.table_open = () => '<figure class="md-table-figures"><div class="md-table-block"><table class="md-table">';
  md2.renderer.rules.table_close = () => "</table></div></figure>";
  return md2;
}
const markdownWithHtml = createMd(true);
const markdownWithoutHtml = createMd(false);
const parserFor = options => options.renderHtml === false ? markdownWithoutHtml : markdownWithHtml;
const cleanMarkdown = html => DOMPurify.sanitize(html, { ADD_ATTR: ["target"], FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"] });
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
const imageRequests = new WeakMap();
async function hydrateImages(root, { resolveImage, signal }) {
  for (const img of root.querySelectorAll("img")) {
    if (signal?.aborted) return;
    const url = img.getAttribute("src") || "";
    if (url) img.dataset.src = url;
    if (!resolveImage) continue;
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) continue;
    let requests = imageRequests.get(resolveImage);
    if (!requests) imageRequests.set(resolveImage, requests = new Map());
    let task = requests.get(url);
    if (!task) {
      task = Promise.resolve().then(() => resolveImage(url)).catch(() => null);
      requests.set(url, task);
      task.then(() => requests.delete(url));
    }
    const dataUrl = await task;
    if (signal?.aborted) return;
    if (dataUrl) img.src = dataUrl;
    else img.dataset.unresolved = url;
  }
}
let mermaidLook = "handDrawn";
function setMermaidLook(look) {
  mermaidLook = look;
}
async function hydrateMermaid(root, options) {
  for (const holder of root.querySelectorAll(".md-mermaid")) {
    if (options.signal?.aborted) return;
    const code = holder.getAttribute("data-diagram") || "";
    if (holder.dataset.done) continue;
    holder.dataset.done = "1";
    await renderMermaidBlock(code, holder, options.diagramLook ?? options.mermaidLook ?? mermaidLook, options.dark ?? mathDark, options.signal);
  }
}
function renderBlockToDom(text, options = {}) {
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
    const { from, to, info } = fenceContentRange(text) ?? { from: 0, to: text.length, info: "" };
    const code = text.slice(from, to);
    if (MERMAID_LANGS.includes(info)) {
      const holder2 = dom("div", "md-mermaid");
      holder2.setAttribute("data-diagram", code);
      root.appendChild(holder2);
    } else {
      const pre = dom("pre", "md-fences md-end-block ty-contain-cm modeLoaded");
      pre.setAttribute("data-lang", info);
      const inner = dom("div", "CodeMirror cm-s-inner");
      inner.setAttribute("data-lang", info);
      inner.innerHTML = highlightFence(code).html;
      pre.appendChild(inner);
      root.appendChild(pre);
    }
    return { dom: root };
  }
  if (mode === "html") {
    if (options.renderHtml !== false) {
      const clean = DOMPurify.sanitize(text, { FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button"], FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"] });
      const holder2 = dom("div", "md-html-block");
      holder2.innerHTML = clean;
      root.appendChild(holder2);
    } else {
      root.appendChild(dom("pre", "md-fences md-html-raw", text));
    }
    return { dom: root };
  }
  const holder = dom("div", "md-inline-render");
  holder.innerHTML = cleanMarkdown(parserFor(options).render(text));
  root.appendChild(holder);
  return { dom: root };
}
function hydrate(root, options) {
  void hydrateImages(root, options);
  void hydrateFence(root, options.signal);
  void hydrateMermaid(root, options);
}
function render(text, options = {}) {
  const { dom: root } = renderBlockToDom(text, options);
  hydrate(root, options);
  return { dom: root };
}
function renderTableCell(source, options = {}) {
  const cell = dom("span");
  cell.innerHTML = cleanMarkdown(parserFor(options).renderInline(source));
  hydrate(cell, options);
  return cell;
}
function renderDocument(text, options = {}) {
  const write = dom("div");
  write.id = "write";
  write.innerHTML = cleanMarkdown(parserFor(options).render(text));
  hydrate(write, options);
  return write;
}
export {
  render,
  renderBlockToDom,
  renderDocument,
  renderTableCell,
  setMathDark,
  setMermaidLook
};
