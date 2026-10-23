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
 */
import { EditorView, Decoration, WidgetType, keymap } from "@codemirror/view";
import { EditorState, StateField, StateEffect, RangeSet } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxTree } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { render } from "../render/render.js";
import { wireTable } from "./tableUI.js";
import { parseBlocks } from "./blocks.js";
import { wrapSelection, toggleLinePrefix, insertBlock, FENCE_TEXT, TABLE_TEXT, LINK_TEXT, IMAGE_TEXT } from "./formatOps.js";

const setLiveEnabled = StateEffect.define();
const setLiveOpts = StateEffect.define();
const setTypewriterEffect = StateEffect.define();

/* ---------------- 原子块：整体替换为渲染结果 ---------------- */

const ATOMIC_TYPES = new Set(["fence", "table", "math", "html"]);

class AtomicBlockWidget extends WidgetType {
  constructor(blockText, blockType, opts, from) {
    super();
    this.blockText = blockText;
    this.blockType = blockType;
    this.opts = opts;
    this.from = from;
  }
  blockText;
  blockType;
  opts;
  from;
  eq(other) {
    return other.blockText === this.blockText && other.blockType === this.blockType && other.from === this.from;
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
      // 表格：列宽拖拽 + 右键增删行列（写回源码）
      wireTable(wrap, view, this.from, this.blockText);
    }
    // 单击原子块 → 进入源码态编辑（Typora 行为）
    wrap.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".md-table-col-handle")) return;
      if (e.target.closest("a")) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: Math.min(this.from, view.state.doc.length) }, scrollIntoView: true });
      view.focus();
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

function buildDecorations(state, config) {
  const doc = state.doc;
  if (!config.enabled) return Decoration.none;
  const sel = state.selection.asSingle().main;
  const ranges = [];

  const blocks = cachedBlocks(doc);

  /* 1. 原子块：光标不在块内 → 整体渲染；在块内 → 保留源码（行样式标出它是代码/表格） */
  const atomicRanges = [];
  for (const block of blocks) {
    if (!ATOMIC_TYPES.has(block.type)) continue;
    const from = Math.min(block.from, doc.length);
    const to = Math.min(block.to, doc.length);
    atomicRanges.push({ from, to });
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
  const selLineFrom = doc.lineAt(sel.from).number;
  const selLineTo = doc.lineAt(sel.to).number;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (line.text.trim()) continue;
    if (n >= selLineFrom && n <= selLineTo) continue;
    ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: "cm-blank-line" }), order: 0 });
  }

  const inAtomic = (pos) => atomicRanges.some((r) => pos >= r.from && pos <= r.to);

  /* 4. 隐藏语法标记 + 行内样式 */
  syntaxTree(state).iterate({
    enter(node) {
      const name = node.name;
      const from = node.from, to = node.to;
      if (to <= from) return undefined;
      if (inAtomic(from)) return undefined; // 原子块源码态里不隐藏标记

      /* 光标"碰到"这个标记 → 显形（Typora 唯一露源码的时机）。
         pad 取 1：光标停在标记前后一个字符内也显形，方便直接删改。 */
      const touched = sel.from <= to + 1 && sel.to >= from - 1;

      if (HIDDEN_MARK_NODES.has(name)) {
        if (!touched) ranges.push({ from, to, deco: Decoration.replace({}), order: 1 });
        return false;
      }
      if (name === "URL") {
        if (!touched) ranges.push({ from, to, deco: Decoration.replace({}), order: 1 });
        return false;
      }
      // 行内语义样式：光标在元素内时保持纯文本（便于编辑），否则套样式
      if (touched) return undefined;
      if (name === "StrongEmphasis") ranges.push({ from, to, deco: Decoration.mark({ class: "md-strong" }), order: 1 });
      else if (name === "Emphasis") ranges.push({ from, to, deco: Decoration.mark({ class: "md-em" }), order: 1 });
      else if (name === "InlineCode") ranges.push({ from, to, deco: Decoration.mark({ class: "md-code" }), order: 1 });
      else if (name === "Strikethrough") ranges.push({ from, to, deco: Decoration.mark({ class: "md-strike" }), order: 1 });
      else if (name === "Link") ranges.push({ from, to, deco: Decoration.mark({ class: "md-link" }), order: 1 });
      return undefined;
    },
  });

  ranges.sort((a, b) => a.from - b.from || a.order - b.order || a.to - b.to);
  return RangeSet.of(ranges.map((r) => r.deco.range(r.from, r.to)), true);
}

/* ---------------- StateField ---------------- */

const liveField = StateField.define({
  create(state) {
    const config = { opts: { renderHtml: true }, enabled: true };
    return { decorations: buildDecorations(state, config), config };
  },
  update(value, tr) {
    let config = value.config;
    for (const eff of tr.effects) {
      if (eff.is(setLiveEnabled)) config = { ...config, enabled: eff.value };
      if (eff.is(setLiveOpts)) config = { ...config, opts: eff.value };
    }
    if (!tr.docChanged && !tr.selectionSet && config === value.config) return value;
    return { decorations: buildDecorations(tr.state, config), config };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

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
  const target = scroller.getBoundingClientRect().height / 2;
  const delta = (coords.top + coords.bottom) / 2 - scroller.getBoundingClientRect().top - target;
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
      highlightSelectionMatches(),
      keymap.of([...mdFormatKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      searchPanelTheme,
      liveField.init((s) => ({
        decorations: buildDecorations(s, { opts, enabled: true }),
        config: { opts, enabled: true },
      })),
      typewriterField.init(() => typewriter),
      typewriterScroll,
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
