import { EditorState } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { languages } from "@codemirror/language-data";
const MERMAID_LANGS = ["mermaid", "mermaid-chart"];
const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.definitionKeyword], class: "cm-keyword" },
  { tag: [t.string, t.special(t.string), t.regexp], class: "cm-string" },
  { tag: [t.number, t.bool, t.null], class: "cm-number" },
  { tag: [t.comment, t.lineComment, t.blockComment], class: "cm-comment" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "cm-variable-2" },
  { tag: [t.variableName, t.propertyName], class: "cm-variable" },
  { tag: [t.typeName, t.className, t.namespace], class: "cm-variable-3" },
  { tag: [t.tagName], class: "cm-tag" },
  { tag: [t.attributeName], class: "cm-attribute" },
  { tag: [t.operator, t.operatorKeyword, t.punctuation, t.bracket, t.paren, t.brace], class: "cm-operator" },
  { tag: [t.definition(t.variableName)], class: "cm-def" },
  { tag: [t.meta], class: "cm-meta" },
  { tag: [t.atom], class: "cm-atom" },
  { tag: [t.heading], class: "cm-header" },
  { tag: [t.link, t.url], class: "cm-link" }
]);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const loadedLanguages = /* @__PURE__ */ new Map();
async function resolveLanguage(info) {
  const key = info.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!key) return null;
  if (loadedLanguages.has(key)) return loadedLanguages.get(key);
  const desc = languages.find((l) => key === l.name || (l.alias ?? []).includes(key));
  if (!desc) {
    loadedLanguages.set(key, null);
    return null;
  }
  try {
    const support = await desc.load();
    loadedLanguages.set(key, support);
    return support;
  } catch {
    loadedLanguages.set(key, null);
    return null;
  }
}
const NODE_CLASS = {
  Keyword: "cm-keyword",
  String: "cm-string",
  Number: "cm-number",
  Comment: "cm-comment",
  VariableName: "cm-variable",
  PropertyName: "cm-variable",
  TypeName: "cm-variable-3",
  TagName: "cm-tag",
  AttributeName: "cm-attribute",
  Operator: "cm-operator",
  Atom: "cm-atom",
  Meta: "cm-meta",
  Regexp: "cm-string",
  Bool: "cm-number",
  Null: "cm-number"
};
function treeToHtml(state, code) {
  let html = "";
  let pos = 0;
  syntaxTree(state).iterate({
    enter(node) {
      const className = NODE_CLASS[node.name] ?? "";
      if (!className || node.to <= node.from) return void 0;
      if (node.from > pos) html += esc(code.slice(pos, node.from));
      html += `<span class="${className}">${esc(code.slice(node.from, node.to))}</span>`;
      pos = node.to;
      return false;
    }
  });
  if (!html) return null;
  if (pos < code.length) html += esc(code.slice(pos));
  return html;
}
function highlightFence(code, info) {
  return { html: `<pre class="cm-static-lines">${esc(code)}</pre>` };
}
/**
 * 异步补语法高亮：`highlightFence` 先给纯文本保证首帧立刻可读，
 * 语言包按需加载成功后再替换成带 token 的 HTML。
 * 实际结构是 `.CodeMirror[data-lang] > pre.cm-static-lines`（data-lang 在容器上）。
 */
async function hydrateFence(container) {
  const nodes = Array.from(container.querySelectorAll(".CodeMirror[data-lang] > pre.cm-static-lines"));
  for (const pre of nodes) {
    const holder = pre.parentElement;
    const lang = holder?.getAttribute("data-lang") || "";
    if (!lang || pre.dataset.hydrated === "1") continue;
    const code = pre.textContent ?? "";
    pre.dataset.hydrated = "1";
    try {
      const support = await resolveLanguage(lang);
      if (!support) continue;
      if (!pre.isConnected) continue;
      const state = EditorState.create({ doc: code, extensions: [support, syntaxHighlighting(highlightStyle)] });
      const html = treeToHtml(state, code);
      if (html) pre.innerHTML = html;
    } catch {
      /* 语言包加载失败：保留纯文本 */
    }
  }
}
let mermaidModule = null;
let mermaidLoading = null;
let mermaidSeq = 0;
/* SVG 结果缓存：同一图（code+look+dark）重建 widget 时不重跑 mermaid（渲染运行时是内存大户） */
const svgCache = /* @__PURE__ */ new Map();
const SVG_CACHE_MAX = 24;
async function loadMermaid() {
  if (mermaidModule) return mermaidModule;
  if (!mermaidLoading) {
    mermaidLoading = import("mermaid").then((mod) => {
      mermaidModule = mod.default ?? mod;
      return mermaidModule;
    });
  }
  return mermaidLoading;
}
function mermaidConfig(dark, look) {
  const lightVars = {
    background: "#ffffff",
    primaryColor: "#f5f2ec",
    primaryTextColor: "#2f3437",
    primaryBorderColor: "#b8b2a6",
    lineColor: "#8a8578",
    secondaryColor: "#eee9df",
    tertiaryColor: "#f7f6f3",
    fontFamily: "inherit"
  };
  const darkVars = {
    background: "#1e2126",
    primaryColor: "#2a2f36",
    primaryTextColor: "#e6e3dc",
    primaryBorderColor: "#5c6672",
    lineColor: "#8a94a0",
    secondaryColor: "#313842",
    tertiaryColor: "#262b31",
    fontFamily: "inherit"
  };
  return {
    startOnLoad: false,
    securityLevel: "strict",
    look: look === "classic" ? "classic" : look,
    handDrawnSeed: 7,
    fontFamily: "inherit",
    theme: "base",
    themeVariables: dark ? darkVars : lightVars
  };
}
async function renderMermaidBlock(code, holder, look = "handDrawn", dark = false) {
  try {
    const cacheKey = `${look}|${dark ? 1 : 0}|${code}`;
    let svg = svgCache.get(cacheKey);
    if (!svg) {
      const mermaid = await loadMermaid();
      const id = `md-mermaid-svg-${++mermaidSeq}`;
      mermaid.initialize(mermaidConfig(dark, look));
      const rendered = await mermaid.render(id, code);
      svg = rendered.svg;
      if (svgCache.size >= SVG_CACHE_MAX) svgCache.delete(svgCache.keys().next().value);
      svgCache.set(cacheKey, svg);
    }
    holder.innerHTML = svg;
    holder.classList.add("md-mermaid-done");
    const svgEl = holder.querySelector("svg");
    if (svgEl) {
      svgEl.removeAttribute("height");
      svgEl.style.maxWidth = "100%";
    }
  } catch (error) {
    holder.classList.add("md-mermaid-error");
    const msg = error instanceof Error ? error.message : String(error);
    holder.innerHTML = `<div class="md-mermaid-error-card"><span class="md-mermaid-error-title">Mermaid \u56FE\u5F62\u6E32\u67D3\u5931\u8D25</span><pre>${esc(msg)}</pre></div>`;
  }
}
export {
  MERMAID_LANGS,
  highlightFence,
  hydrateFence,
  renderMermaidBlock
};
