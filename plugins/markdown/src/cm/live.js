/**
 * markdown v2 —— Typora 式即时渲染（混合架构，与 Typora 实际机制一致）。
 *
 * 两类块，两种处理：
 *  A. 文本块（标题/段落/列表/引用）：文本始终是编辑器里的真实字符，可编辑、可点进任意位置。
 *     只做两件事：① 行级 class 套渲染样式（字号/左线/缩进）② 隐藏语法标记
 *     （## ** ` ~~ [ ](url) - 1. >）。光标进入某个标记的范围时该标记临时显形，
 *     离开立即隐藏 —— 这就是 Typora 唯一会「露源码」的时刻，删掉标记字符才会去掉语法。
 *  B. 原子块（代码块/表格/公式/mermaid/HTML）：整体 replace 为渲染结果；
 *     光标进入该块范围时才展开成源码文本编辑。这是 Typora 对代码块与表格的真实行为。
 *
 * 光标定位：
 *  - 渲染态原子块是不可编辑 widget，CM 的 posAtCoords 只能给出块首/块尾。点块内
 *    任意位置时，用渲染结果的 DOM 几何（caretRangeFromPoint / 表格单元格 / 等宽列宽）
 *    换算成块内字符偏移，落到「块起点 + 偏移」。这是「点 java 后面光标到对应位置」的实现。
 *  - widget 的 eq 不比较 from：上方增删字符会让块起点平移，若 from 参与比较，每次输入
 *    都会重建整个块（mermaid 重绘、图片重解析、焦点抖动）。当前位置在点击时用
 *    view.posAtDOM 实时反查。
 */
import { EditorView, Decoration, WidgetType, ViewPlugin, keymap, drawSelection } from "@codemirror/view";
import { EditorState, StateField, StateEffect, RangeSet } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage, insertNewlineContinueMarkup, deleteMarkupBackward } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxTree } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { render } from "../render/render.js";
import { wireTable } from "./tableUI.js";
import { parseBlocks } from "./blocks.js";
import { clampToBlock, offsetOfLine, cellSourceOffset, codeSourceOffset, needsScrollIntoView } from "./clickMap.js";
import { wrapSelection, toggleLinePrefix, insertBlock, FENCE_TEXT, TABLE_TEXT, LINK_TEXT, IMAGE_TEXT } from "./formatOps.js";

const setLiveEnabled = StateEffect.define();
const setLiveOpts = StateEffect.define();
const setTypewriterEffect = StateEffect.define();
const setComposingEffect = StateEffect.define();

/* ---------------- 原子块：整体替换为渲染结果 ---------------- */

const ATOMIC_TYPES = new Set(["fence", "table", "math", "html"]);

/* ---------------- 点击坐标 → 块内字符偏移 ---------------- */

/** 渲染元素内某点的文本偏移；不支持或点在元素外返回 null */
function textOffsetAtPoint(el, x, y) {
  if (!el) return null;
  const doc = el.ownerDocument;
  let range = null;
  try {
    if (doc.caretRangeFromPoint) range = doc.caretRangeFromPoint(x, y);
    else if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(x, y);
      if (pos) range = { startContainer: pos.offsetNode, startOffset: pos.offset };
    }
  } catch {
    return null;
  }
  if (!range || !range.startContainer) return null;
  const node = range.startContainer;
  if (node !== el && !el.contains(node)) return null;
  if (node.nodeType === 3) {
    let total = 0;
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const current = walker.currentNode;
      if (current === node) return total + range.startOffset;
      total += current.nodeValue ? current.nodeValue.length : 0;
    }
    return null;
  }
  return 0;
}

/** 等宽字体下测单个字符宽度（caretRangeFromPoint 不可用时按列推算） */
function monoCharWidth(el) {
  const style = getComputedStyle(el);
  const probe = el.ownerDocument.createElement("span");
  probe.textContent = "M".repeat(10);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;pointer-events:none";
  probe.style.font = style.font;
  probe.style.fontFamily = style.fontFamily;
  probe.style.fontSize = style.fontSize;
  probe.style.letterSpacing = style.letterSpacing;
  el.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return width > 0 ? width : 8;
}

/** 代码块：渲染态文本偏移 → 块内源码偏移（跳过 ```lang 围栏行） */
function fenceOffsetFromPoint(wrap, blockText, x, y) {
  const pre = wrap.querySelector("pre.md-fences") || wrap.querySelector("pre");
  if (!pre) return 0;
  const textEl = pre.querySelector(".CodeMirror") || pre;
  const rendered = textEl.textContent ?? "";
  const direct = textOffsetAtPoint(textEl, x, y);
  if (direct !== null && direct <= rendered.length) return codeSourceOffset(blockText, direct);

  // 回退：按等宽列/行推算（点落在行尾右侧或空白区域时）
  const rect = textEl.getBoundingClientRect();
  const style = getComputedStyle(textEl);
  const padTop = parseFloat(style.paddingTop) || 0;
  const padLeft = parseFloat(style.paddingLeft) || 0;
  const lineHeight = parseFloat(style.lineHeight) || 20;
  const charW = monoCharWidth(textEl);
  const codeLines = rendered.split("\n");
  const row = Math.min(Math.max(0, Math.floor((y - rect.top - padTop) / lineHeight)), Math.max(0, codeLines.length - 1));
  const col = Math.min(Math.max(0, Math.round((x - rect.left - padLeft) / charW)), (codeLines[row] ?? "").length);
  return codeSourceOffset(blockText, offsetOfLine(rendered, row) + col);
}

/** 表格：点击单元格 → 源码行 + 列偏移 */
function tableOffsetFromPoint(target, blockText) {
  const cell = target?.closest?.("th,td");
  if (!cell) return null;
  const row = cell.closest("tr");
  if (!row) return null;
  const colIndex = Array.from(row.children).indexOf(cell);
  const parent = row.parentElement;
  const lines = blockText.split("\n");
  let lineIndex;
  if (parent?.tagName === "THEAD") lineIndex = 0;
  else if (parent?.tagName === "TBODY") lineIndex = 2 + Array.from(parent.children).indexOf(row);
  else lineIndex = 0;
  if (lineIndex >= lines.length) lineIndex = Math.max(0, lines.length - 1);
  return offsetOfLine(blockText, lineIndex) + cellSourceOffset(lines[lineIndex] ?? "", colIndex);
}

/** 无结构可依赖的块（公式/HTML/mermaid）：按纵向比例落到对应源码行 */
function proportionalOffsetFromPoint(wrap, blockText, y) {
  const rect = wrap.getBoundingClientRect();
  const lines = blockText.split("\n");
  if (!lines.length || rect.height <= 0) return 0;
  const ratio = Math.min(0.999, Math.max(0, (y - rect.top) / rect.height));
  const lineIndex = Math.min(lines.length - 1, Math.floor(ratio * lines.length));
  return offsetOfLine(blockText, lineIndex);
}

function blockOffsetFromPoint(wrap, blockType, blockText, target, x, y) {
  if (blockType === "table") {
    const tableOffset = tableOffsetFromPoint(target, blockText);
    if (tableOffset !== null) return tableOffset;
    return proportionalOffsetFromPoint(wrap, blockText, y);
  }
  if (blockType === "fence") return fenceOffsetFromPoint(wrap, blockText, x, y);
  const direct = textOffsetAtPoint(wrap, x, y);
  if (direct !== null) return Math.min(direct, blockText.length);
  return proportionalOffsetFromPoint(wrap, blockText, y);
}

/* ---------------- 行内图片：渲染态预览（尺寸跟随设置 / 单张覆盖） ---------------- */

/** 从图片源码里解析尺寸后缀：`![alt](url){width=300 height=180}` */
function imageSizeFromSource(source) {
  const match = /\{\s*([^}]*)\}\s*$/.exec(source)
  if (!match) return { width: "", height: "", align: "" }
  const attrs = {}
  const re = /(width|height|align)\s*=\s*([^}\s]+)/gi
  let m
  while ((m = re.exec(match[1]))) {
    const key = m[1].toLowerCase()
    const value = m[2].replace(/^['"]|['"]$/g, "")
    if (key === "align" && /^(left|center|right)$/i.test(value)) attrs.align = value.toLowerCase()
    else if (key !== "align" && /^\d+(?:\.\d+)?(?:px|%)?$/.test(value)) attrs[key] = /^\d+(?:\.\d+)?$/.test(value) ? `${value}px` : value
  }
  return { width: attrs.width || "", height: attrs.height || "", align: attrs.align || "" }
}

/** 从 `![alt](url "title")` 里取出 url 与 alt（容忍括号内的转义） */
function imageParts(source) {
  const match = /^!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+["'(][^)]*)?\s*\)/.exec(source.trim())
  if (!match) return null
  let src = match[2]
  if (src.startsWith("<") && src.endsWith(">")) src = src.slice(1, -1)
  return { alt: match[1], src }
}

class InlineImageWidget extends WidgetType {
  constructor(source, opts) {
    super()
    this.source = source
    this.opts = opts
  }
  source
  opts
  eq(other) {
    return other.source === this.source && other.opts?.renderHtml === this.opts?.renderHtml
  }
  get estimatedHeight() { return -1 }
  toDOM(view) {
    const parts = imageParts(this.source)
    const size = imageSizeFromSource(this.source)
    const wrap = document.createElement("span")
    wrap.className = "md-image-widget"
    if (size.align) wrap.dataset.align = size.align
    const img = document.createElement("img")
    img.alt = parts?.alt || ""
    img.loading = "lazy"
    img.draggable = false
    if (parts?.src) img.dataset.src = parts.src
    if (size.width) { img.style.width = size.width; img.style.maxWidth = "none" }
    if (size.height) img.style.height = size.height
    if (!parts?.src) {
      wrap.textContent = this.source
      wrap.classList.add("is-broken")
      return wrap
    }
    wrap.appendChild(img)
    const resolve = this.opts?.resolveImage
    if (resolve) {
      Promise.resolve()
        .then(() => resolve(parts.src))
        .then((url) => { if (url && wrap.isConnected) img.src = url })
        .catch(() => { /* 保留占位 */ })
    } else {
      img.src = parts.src
    }
    // 点击图片：把光标放进图片源码（露出原始语法，便于改尺寸/换图）
    wrap.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      let from = 0
      try {
        const pos = view.posAtDOM(wrap, 0)
        if (Number.isFinite(pos)) from = pos
      } catch { /* 落到 0 */ }
      view.dispatch({ selection: { anchor: from }, scrollIntoView: true })
      view.focus()
    })
    return wrap
  }
  ignoreEvent() { return true }
}

/* ---------------- 原子块 widget ---------------- */

class AtomicBlockWidget extends WidgetType {
  constructor(blockText, blockType, opts, initialFrom) {
    super();
    this.blockText = blockText;
    this.blockType = blockType;
    this.opts = opts;
    this.initialFrom = initialFrom;
  }
  blockText;
  blockType;
  opts;
  initialFrom;
  /** 只比较内容与渲染选项：块起点平移不触发重建（否则每次输入都重建整个块） */
  eq(other) {
    return other.blockText === this.blockText
      && other.blockType === this.blockType
      && other.opts?.renderHtml === this.opts?.renderHtml;
  }
  /** 块在当前文档里的起点：优先 DOM 反查（widget 里存的 from 可能已因编辑而过期） */
  currentFrom(view, dom) {
    try {
      const pos = view.posAtDOM(dom, 0);
      if (Number.isFinite(pos)) return pos;
    } catch { /* 落到创建时位置 */ }
    return Math.min(this.initialFrom ?? 0, view.state.doc.length);
  }
  toDOM(view) {
    const wrap = document.createElement("div");
    wrap.className = `md-atomic md-atomic-${this.blockType}`;
    const inner = render(this.blockText, {
      mode: this.blockType,
      renderHtml: this.opts.renderHtml,
      resolveImage: this.opts.resolveImage,
    });
    wrap.appendChild(inner.dom);
    if (this.blockType === "table") {
      // 表格：列宽拖拽 + 右键增删行列（写回源码）；块起点实时反查，避免拖动后偏移错位
      wireTable(wrap, view, () => this.currentFrom(view, wrap), this.blockText);
    }
    // 单击原子块 → 定位到点击处的字符并展开成源码态（Typora 行为）
    wrap.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".md-table-col-handle")) return;
      if (e.target.closest("a")) return;
      // 图片：交给上层点击工具（设置单张宽高），不展开成源码
      if (e.target.closest("img")) return;
      e.preventDefault();
      const from = this.currentFrom(view, wrap);
      const to = Math.min(from + this.blockText.length, view.state.doc.length);
      const offset = blockOffsetFromPoint(wrap, this.blockType, this.blockText, e.target, e.clientX, e.clientY);
      const anchor = clampToBlock(from + offset, from, to);
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
      view.focus();
      // 块展开成源码后高度会变，再确认一次光标可见（关闭打字机模式也能跟随）
      requestAnimationFrame(() => {
        const caret = view.coordsAtPos(anchor);
        if (needsScrollIntoView(caret, view.scrollDOM.getBoundingClientRect(), 24)) {
          view.dispatch({ effects: EditorView.scrollIntoView(anchor, { y: "nearest", yMargin: 32 }) });
        }
      });
    });
    return wrap;
  }
  ignoreEvent() { return true; }
  get lineBreaks() { return Math.max(0, this.blockText.split("\n").length - 1); }
}

/* ---------------- 语法标记：光标不在场时隐藏 ---------------- */

/** lezer-markdown 的纯语法标记节点 */
const HIDDEN_MARK_NODES = new Set([
  "HeaderMark",        // #
  "EmphasisMark",      // * _
  "CodeMark",          // ` ``` ~~~
  "LinkMark",          // [ ] ( )
  "QuoteMark",         // >
  "ListMark",          // - * + 1.
  "StrikethroughMark",
  "LinkTitle",
])

/* ---------------- 行级块样式 class ---------------- */

function lineClass(blockType, level) {
  switch (blockType) {
    case "heading": return `md-line md-h${level ?? 1}`;
    case "quote": return "md-line md-quote";
    case "list": return "md-line md-list";
    case "meta": return "md-line md-meta";
    case "hr": return "md-line md-hrline";
    case "fence": return "md-line md-fence-src";
    case "table": return "md-line md-table-src";
    case "math": return "md-line md-math-src";
    case "html": return "md-line md-html-src";
    default: return "md-line md-p";
  }
}

/* ---------------- 装饰构建 ---------------- */

/* parseBlocks 结果缓存：选择变化（selectionSet）时文档未变，直接复用上次块解析 */
let blockCache = { doc: null, blocks: [] };
function cachedBlocks(doc) {
  if (blockCache.doc === doc) return blockCache.blocks;
  const blocks = parseBlocks(doc.toString());
  blockCache = { doc, blocks };
  return blocks;
}

/** 块级装饰：原子块替换 + 行样式 + 空行折叠（选择只决定原子块是否展开、空行是否折叠） */
let blockDecoCache = { doc: null, key: null, deco: null };
function buildBlockDecorations(state, config) {
  const doc = state.doc;
  if (!config.enabled) return Decoration.none;
  const sel = state.selection.asSingle().main;
  const selFromLine = doc.lineAt(sel.from).number;
  const selToLine = doc.lineAt(sel.to).number;
  // 同一文档 + 同一选区 + 同一配置 → 复用上次结果（避免重复构建 widget）
  const key = `${sel.from}:${sel.to}:${config.opts?.renderHtml}:${config.opts?.motion ?? ""}`;
  if (blockDecoCache.doc === doc && blockDecoCache.key === key) return blockDecoCache.deco;
  const ranges = [];

  const blocks = cachedBlocks(doc);

  /* 1. 原子块：光标不在块内 → 整体渲染；在块内 → 保留源码（行样式标出它是代码/表格） */
  for (const block of blocks) {
    if (!ATOMIC_TYPES.has(block.type)) continue;
    const from = Math.min(block.from, doc.length);
    const to = Math.min(block.to, doc.length);
    const inside = sel.from <= to && sel.to >= from;
    if (inside) continue; // 源码态，保留文本可编辑
    ranges.push({
      from, to,
      deco: Decoration.replace({
        widget: new AtomicBlockWidget(block.text, block.type, config.opts, from),
        block: true,
      }),
      order: 2,
    });
  }

  /* 2. 文本块行样式 */
  for (const block of blocks) {
    if (ATOMIC_TYPES.has(block.type)) continue;
    const startLine = doc.lineAt(Math.min(block.from, doc.length)).number;
    const endLine = doc.lineAt(block.to >= doc.length ? doc.length : block.to).number;
    for (let n = startLine; n <= endLine; n++) {
      const line = doc.line(n);
      let cls = lineClass(block.type, block.level);
      if (block.type === "list") {
        // 无序列表补圆点占位；有序列表/任务项不补（数字与勾选框由文本自身呈现）
        if (/^\s{0,3}[-*+]\s+/.test(line.text) && !/^\s{0,3}[-*+]\s+\[[ xX]\]\s+/.test(line.text)) {
          cls += " md-list-bullet";
        }
      }
      ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: cls }), order: 0 });
    }
  }

  /* 3. 空行折叠（光标不在该行） */
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (line.text.trim()) continue;
    if (n >= selFromLine && n <= selToLine) continue;
    ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: "cm-blank-line" }), order: 0 });
  }

  ranges.sort((a, b) => a.from - b.from || a.order - b.order || a.to - b.to);
  const deco = RangeSet.of(ranges.map((r) => r.deco.range(r.from, r.to)), true);
  blockDecoCache = { doc, key, deco };
  return deco;
}

/**
 * 行内装饰（隐藏语法标记 + 语义样式）：只遍历可视范围 + 缓冲区。
 * 长文档每次移动光标全量遍历语法树是主要卡顿来源，这里改成视口驱动。
 */
function buildInlineDecorations(view) {
  const state = view.state;
  const sel = state.selection.asSingle().main;
  const doc = state.doc;
  const ranges = [];
  const atomicRanges = [];
  for (const block of cachedBlocks(doc)) {
    if (!ATOMIC_TYPES.has(block.type)) continue;
    atomicRanges.push({ from: Math.min(block.from, doc.length), to: Math.min(block.to, doc.length) });
  }
  const inAtomic = (pos) => atomicRanges.some((r) => pos >= r.from && pos <= r.to);

  for (const visible of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        const name = node.name;
        const from = node.from, to = node.to;
        if (to <= from) return undefined;
        if (inAtomic(from)) return undefined; // 原子块源码态里不隐藏标记

        /* 光标"碰到"这个标记 → 显形（Typora 唯一露源码的时机）。
           pad 取 1：光标停在标记前后一个字符内也显形，方便直接删改。 */
        const touched = sel.from <= to + 1 && sel.to >= from - 1;

        /* 独立成段的图片（粘贴图片的常见形态）：渲染成图片预览，尺寸可被
           `{width=..}` 覆盖；光标进入该行时退回源码，便于改链接。 */
        if (name === "Image") {
          if (touched) return false;
          const line = doc.lineAt(from);
          const source = state.sliceDoc(from, to);
          const bare = line.text.trim().replace(/\{\s*[^}]*\}\s*$/, "").trim();
          if (bare === source.trim() && line.text.trim().length) {
            ranges.push(Decoration.replace({
              widget: new InlineImageWidget(line.text.trim(), config.opts),
            }).range(line.from, line.to));
          }
          return false;
        }

        if (HIDDEN_MARK_NODES.has(name)) {
          if (!touched) ranges.push(Decoration.replace({}).range(from, to));
          return false;
        }
        if (name === "URL") {
          if (!touched) ranges.push(Decoration.replace({}).range(from, to));
          return false;
        }
        // 行内语义样式：光标在元素内时保持纯文本（便于编辑），否则套样式
        if (touched) return undefined;
        if (name === "StrongEmphasis") ranges.push(Decoration.mark({ class: "md-strong" }).range(from, to));
        else if (name === "Emphasis") ranges.push(Decoration.mark({ class: "md-em" }).range(from, to));
        else if (name === "InlineCode") ranges.push(Decoration.mark({ class: "md-code" }).range(from, to));
        else if (name === "Strikethrough") ranges.push(Decoration.mark({ class: "md-strike" }).range(from, to));
        else if (name === "Link") ranges.push(Decoration.mark({ class: "md-link" }).range(from, to));
        return undefined;
      },
    });
  }
  return Decoration.set(ranges, true);
}

/* ---------------- StateField：块级装饰 ---------------- */

const liveField = StateField.define({
  create(state) {
    const config = { opts: { renderHtml: true }, enabled: true, composing: false };
    return { decorations: buildBlockDecorations(state, config), config };
  },
  update(value, tr) {
    let config = value.config;
    for (const eff of tr.effects) {
      if (eff.is(setLiveEnabled)) config = { ...config, enabled: eff.value };
      if (eff.is(setLiveOpts)) config = { ...config, opts: eff.value };
      if (eff.is(setComposingEffect)) config = { ...config, composing: eff.value };
    }
    // 输入法组合期间只平移已有装饰，不重建：避免替换装饰打断 IME 组合
    if (config.composing && tr.docChanged && config === value.config) {
      return { decorations: value.decorations.map(tr.changes), config };
    }
    if (!tr.docChanged && !tr.selectionSet && config === value.config) return value;
    return { decorations: buildBlockDecorations(tr.state, config), config };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

/* ---------------- ViewPlugin：行内装饰（视口驱动） ---------------- */

const inlinePlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = buildInlineDecorations(view);
  }
  update(update) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = buildInlineDecorations(update.view);
    }
  }
}, { decorations: (v) => v.decorations });

export const updateLiveOpts = (view, opts) => {
  view.dispatch({ effects: setLiveOpts.of(opts) });
};
export const toggleLive = (view, enabled) => {
  view.dispatch({ effects: setLiveEnabled.of(enabled) });
  return true;
};

/* ---------------- 打字机 ---------------- */

const typewriterField = StateField.define({
  create: () => false,
  update(v, tr) {
    for (const eff of tr.effects) if (eff.is(setTypewriterEffect)) return eff.value;
    return v;
  },
  provide: (f) => EditorView.contentAttributes.from(f, (on) => ({ "data-typewriter": on ? "on" : "off" })),
});
export function setTypewriter(view, enabled) {
  view.dispatch({ effects: setTypewriterEffect.of(enabled) });
}
const typewriterScroll = EditorView.updateListener.of((update) => {
  if (!update.selectionSet && !update.docChanged) return;
  const view = update.view;
  if (view.contentDOM.getAttribute("data-typewriter") !== "on") return;
  const coords = view.coordsAtPos(view.state.selection.main.head);
  if (!coords) return;
  const scroller = view.scrollDOM;
  const rect = scroller.getBoundingClientRect();
  const target = rect.height / 2;
  const delta = (coords.top + coords.bottom) / 2 - rect.top - target;
  if (Math.abs(delta) > 8) scroller.scrollTop += delta;
});

/* ---------------- 格式快捷键 ---------------- */

const mdFormatKeymap = [
  { key: "Mod-b", run: (v) => wrapSelection(v, "**"), preventDefault: true },
  { key: "Mod-i", run: (v) => wrapSelection(v, "*"), preventDefault: true },
  { key: "Mod-e", run: (v) => wrapSelection(v, "`"), preventDefault: true },
  { key: "Mod-k", run: (v) => insertBlock(v, LINK_TEXT, 1), preventDefault: true },
  { key: "Mod-S-k", run: (v) => insertBlock(v, IMAGE_TEXT, 2), preventDefault: true },
  { key: "Mod-S-l", run: (v) => insertBlock(v, FENCE_TEXT, 3), preventDefault: true },
  { key: "Mod-S-g", run: (v) => insertBlock(v, TABLE_TEXT, 2), preventDefault: true },
  { key: "Mod-S-7", run: (v) => toggleLinePrefix(v, "- [ ] "), preventDefault: true },
  { key: "Mod-S-8", run: (v) => toggleLinePrefix(v, "- "), preventDefault: true },
  { key: "Mod-S-9", run: (v) => toggleLinePrefix(v, "1. "), preventDefault: true },
  { key: "Mod-S-u", run: (v) => toggleLinePrefix(v, "> "), preventDefault: true },
  { key: "Mod-1", run: (v) => toggleLinePrefix(v, "# "), preventDefault: true },
  { key: "Mod-2", run: (v) => toggleLinePrefix(v, "## "), preventDefault: true },
  { key: "Mod-3", run: (v) => toggleLinePrefix(v, "### "), preventDefault: true },
];

/* 列表回车续行 / 退格删标记：复用 lang-markdown 标准实现（不另写一套缩进规则） */
const mdListKeymap = [
  { key: "Enter", run: insertNewlineContinueMarkup },
  { key: "Backspace", run: deleteMarkupBackward },
];

/* ---------------- 搜索面板样式 ---------------- */

const searchPanelTheme = EditorView.baseTheme({
  ".cm-panel.cm-search": {
    padding: "8px 10px", background: "var(--surface, #fff)",
    borderTop: "1px solid var(--border, #e0e0e0)", fontFamily: "var(--font, inherit)",
    fontSize: "12.5px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 8px",
  },
  ".cm-panel.cm-search input[type=text]": {
    padding: "4px 8px", border: "1px solid var(--border, #ddd)", borderRadius: "7px",
    background: "var(--bg, #fafafa)", color: "var(--text, #222)", outlineColor: "var(--accent, #3b82f6)", minWidth: "140px",
  },
  ".cm-panel.cm-search button": {
    padding: "3.5px 10px", border: "1px solid var(--border, #ddd)", borderRadius: "7px",
    background: "var(--surface, #fff)", color: "var(--text, #333)", cursor: "pointer", fontSize: "12px",
  },
  ".cm-panel.cm-search button:hover": { background: "var(--surface-2, #f0f0f0)" },
  ".cm-searchMatch": { background: "color-mix(in srgb, var(--accent, #3b82f6) 25%, transparent)", outline: "1px solid color-mix(in srgb, var(--accent, #3b82f6) 45%, transparent)" },
  ".cm-searchMatch-selected": { background: "color-mix(in srgb, var(--accent, #3b82f6) 45%, transparent)" },
});

/* ---------------- 编辑器创建 ---------------- */

export function createEditor({ parent, initialText, opts, onChange, onSelection, typewriter = false, focus = true }) {
  const state = EditorState.create({
    doc: initialText,
    extensions: [
      history(),
      /* 自绘选区：原生 ::selection 在行 padding / 折叠空行上会画出一块块错位矩形，
         全选时与文字行高亮重叠。drawSelection 用矩形标记贴合真实文本盒。 */
      drawSelection(),
      highlightSelectionMatches(),
      keymap.of([...mdFormatKeymap, ...mdListKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      searchPanelTheme,
      liveField.init((s) => ({
        decorations: buildBlockDecorations(s, { opts, enabled: true }),
        config: { opts, enabled: true, composing: false },
      })),
      inlinePlugin,
      typewriterField.init(() => typewriter),
      typewriterScroll,
      /* 输入法组合期间冻结块级装饰重建（只平移），避免替换装饰打断中文输入 */
      EditorView.domEventHandlers({
        compositionstart(event, view) { view.dispatch({ effects: setComposingEffect.of(true) }); return false; },
        compositionend(event, view) { view.dispatch({ effects: setComposingEffect.of(false) }); return false; },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange(update.state.doc.toString());
        if (update.selectionSet && onSelection) onSelection(update.state.selection.main.head);
      }),
      EditorView.contentAttributes.of({ spellcheck: "false", id: "write" }),
      EditorView.theme({
        "&": { height: "100%" },
        ".cm-scroller": { fontFamily: "inherit" },
        ".cm-content": { padding: "0" },
        ".cm-line": { padding: "0" },
      }),
    ],
  });
  const view = new EditorView({ state, parent });
  if (focus) view.focus();
  return view;
}

/* ---------------- 大纲 / 统计 ---------------- */

export function extractOutline(text) {
  const nodes = [];
  for (const block of parseBlocks(text)) {
    if (block.type === "heading") {
      nodes.push({ level: block.level ?? 1, text: block.text.replace(/^#{1,6}\s+/, ""), from: block.from });
    }
  }
  return nodes;
}

export function computeStats(text) {
  const chars = text.length;
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const words = cjk + (text.replace(/[\u4e00-\u9fa5]/g, " ").match(/[A-Za-z0-9_'-]+/g) || []).length;
  const lines = text.split("\n").length;
  return { chars, words, lines, readMinutes: Math.max(1, Math.round(words / 300)) };
}

export function replaceRange(view, from, to, insert) {
  view.dispatch({ changes: { from, to, insert } });
}

export { parseBlocks, EditorView, EditorState, markdown };
