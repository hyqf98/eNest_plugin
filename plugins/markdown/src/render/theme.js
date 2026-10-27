const BUILTIN_THEMES = [
  { id: "enest-minimal", name: "eNest Minimal\uFF08\u6D45\u8272\uFF09", source: "builtin" },
  { id: "enest-minimal-dark", name: "eNest Minimal\uFF08\u6DF1\u8272\uFF09", source: "builtin" }
];
const THEME_STYLE_ID = "md-theme-style";
const THEME_LINK_ID = "md-theme-link";
const THEME_CONTAINER_ATTR = "data-md-theme";
let activeThemeId = "";
function applyTheme(themeId, css) {
  activeThemeId = themeId;
  let style = document.getElementById(THEME_STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = THEME_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = css;
  document.documentElement.setAttribute(THEME_CONTAINER_ATTR, themeId);
}
function getActiveTheme() {
  return activeThemeId;
}
const MINIMAL_LIGHT_CSS = `
/* eNest Minimal \u2014\u2014 \u6696\u767D\u7EB8\u9762 \xB7 1px \u8FB9\u7EBF \xB7 \u5706\u89D2\u5757 \xB7 \u886C\u7EBF\u6807\u9898\uFF08taste-skills \u6781\u7B80\u9884\u8BBE\uFF09 */
.md-scope {
  --md-canvas: #f7f6f3;
  --md-surface: #ffffff;
  --md-text: #2f3437;
  --md-text-2: #787774;
  --md-border: #eaeaea;
  --md-accent-ink: #1f6c9f;
  --md-code-bg: #e1f3fe;
  --md-code-ink: #1f6c9f;
  --md-quote-bg: #f9f9f8;
  --md-mark-bg: #fbf3db;
  --md-link: #1f6c9f;
  --md-radius: 10px;
  --md-radius-lg: 12px;
  --md-font-ui: var(--font, -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif);
  --md-font-body: var(--font, -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif);
  --md-font-serif: "New York", "Songti SC", Georgia, "Noto Serif SC", serif;
  --md-font-mono: var(--mono, "SF Mono", "JetBrains Mono", Menlo, monospace);
}
`;
const MINIMAL_DARK_CSS = `
/* eNest Minimal Dark \u2014\u2014 \u70AD\u7EB8\u9762 */
.md-scope {
  --md-canvas: #1e2126;
  --md-surface: #262b31;
  --md-text: #e6e3dc;
  --md-text-2: #9aa0a6;
  --md-border: #3a4048;
  --md-accent-ink: #7fb8df;
  --md-code-bg: #2a3138;
  --md-code-ink: #8fc7ee;
  --md-quote-bg: #22262b;
  --md-mark-bg: #3d3627;
  --md-link: #7fb8df;
  --md-radius: 10px;
  --md-radius-lg: 12px;
}
`;
const CONTENT_CSS = `
.md-scope {
  background: var(--md-canvas);
  color: var(--md-text);
  font-family: var(--md-font-body);
  font-size: 15px;
  line-height: 1.75;
  transition: background .3s cubic-bezier(.16,1,.3,1), color .3s cubic-bezier(.16,1,.3,1);
}
.md-scope .cm-editor { background: transparent; }
/* 滚动容器全宽：滚动条贴窗口边缘，不被内容栏限宽裹窄 */
.md-scope .cm-scroller { overflow: auto; }
/* Typora 惯例：内容根 #write 居中限宽（挂在 CM 的 .cm-content 上，不是滚动容器） */
.md-scope #write, .md-scope .md-doc {
  max-width: 860px;
  margin: 0 auto;
  padding: 20px 20px 96px;
  box-sizing: content-box;
}
/* 空行折叠：CM 空行默认整行高 → 收成细缝（回车不再"多一行"） */
.md-scope .cm-blank-line {
  line-height: 0.45em;
  min-height: 0.45em;
}
.md-scope .cm-blank-line::after { content: ''; display: block; height: 0; }
/* 导出/预览用的独立 #write 容器（非 CM 内）同样限宽 */
.md-scope > #write { box-sizing: border-box; }

/* ================= 编辑态（行 class 驱动，Typora 混合架构） ================= */
/* 文本块的行样式：文字始终可编辑，语法标记由 CM 装饰隐藏，外观全在这里定义 */
.md-scope .md-line { padding: 0 0; }
.md-scope .md-p { margin: 0 0 0.62em; }
.md-scope .md-h1, .md-scope .md-h2, .md-scope .md-h3,
.md-scope .md-h4, .md-scope .md-h5, .md-scope .md-h6 {
  font-family: var(--md-font-serif);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--md-text);
  line-height: 1.3;
}
.md-scope .md-h1 { font-size: 1.72em; letter-spacing: -0.02em; margin: 0.35em 0 0.3em; }
.md-scope .md-h2 { font-size: 1.4em; margin: 0.75em 0 0.28em; }
.md-scope .md-h3 { font-size: 1.18em; margin: 0.7em 0 0.24em; }
.md-scope .md-h4 { font-size: 1.04em; margin: 0.65em 0 0.2em; }
.md-scope .md-h5, .md-scope .md-h6 { font-size: 0.95em; color: var(--md-text-2); margin: 0.6em 0 0.18em; }
/* 引用：左线 + 微底（整行 class，多行连续自然连成一块） */
.md-scope .md-quote {
  border-left: 3px solid var(--md-border);
  background: var(--md-quote-bg);
  color: var(--md-text-2);
  padding-left: 14px;
  margin: 0;
}
.md-scope .md-quote:first-of-type { border-top-left-radius: 4px; border-top-right-radius: var(--md-radius); }
/* 列表：标记隐藏后靠 padding 保持缩进（圆点由 .md-bullet 伪元素补） */
.md-scope .md-list { padding-left: 1.15em; margin: 0; }
/* 无序列表项：补一个圆点占位（与隐藏的 "- " 视觉等宽） */
.md-scope .md-list.md-list-bullet::before {
  content: '•';
  display: inline-block;
  width: 0.62em;
  margin-right: 0.36em;
  margin-left: -0.98em;
  color: var(--md-text-2);
  opacity: 0.7;
}
/* front matter / 源码态块 */
.md-scope .md-meta {
  font-family: var(--md-font-mono); font-size: 0.82em; color: var(--md-text-2);
  background: var(--md-quote-bg); border-radius: var(--md-radius);
}
.md-scope .md-fence-src, .md-scope .md-table-src, .md-scope .md-math-src, .md-scope .md-html-src {
  font-family: var(--md-font-mono); font-size: 0.86em;
  background: var(--md-surface); border: 1px solid var(--md-border);
  border-radius: var(--md-radius); padding-left: 12px; padding-right: 12px;
}
.md-scope .md-hrline { color: var(--md-text-2); }
/* 行内语义样式（mark decoration） */
.md-scope .md-strong { font-weight: 650; color: var(--md-text); }
.md-scope .md-em { font-style: italic; }
.md-scope .md-strike { text-decoration: line-through; color: var(--md-text-2); }
.md-scope .md-code {
  font-family: var(--md-font-mono); font-size: 0.88em;
  background: var(--md-code-bg); color: var(--md-code-ink);
  border-radius: 5px; padding: 1px 4px;
}
.md-scope .md-link { color: var(--md-link); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--md-link) 30%, transparent); }
/* 原子块（代码/表格/公式/HTML 渲染态） */
.md-scope .md-atomic { margin: 0.6em 0; cursor: text; }

/* ================= 渲染态（导出 / 原子块内部 / 预览） ================= */
.md-scope .md-line + .md-line { margin-top: 0; }
/* 标题：衬线 + 紧排，上下间距收紧 */
.md-scope h1, .md-scope h2, .md-scope h3, .md-scope h4, .md-scope h5, .md-scope h6 {
  font-family: var(--md-font-serif);
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
  color: var(--md-text);
  margin: 0.9em 0 0.35em;
}
.md-scope h1 { font-size: 1.75em; letter-spacing: -0.02em; margin-top: 0.2em; }
.md-scope h2 { font-size: 1.4em; }
.md-scope h3 { font-size: 1.18em; }
.md-scope h4 { font-size: 1.04em; }
.md-scope h5, .md-scope h6 { font-size: 0.95em; color: var(--md-text-2); }
/* 正文：段间距紧凑 */
.md-scope p { margin: 0 0 0.7em; }
.md-scope a { color: var(--md-link); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--md-link) 30%, transparent); }
.md-scope a:hover { border-bottom-color: var(--md-link); }
.md-scope strong { font-weight: 650; color: var(--md-text); }
.md-scope mark { background: var(--md-mark-bg); color: var(--md-text); border-radius: 3px; padding: 0 3px; }
.md-scope del { color: var(--md-text-2); }
/* \u884C\u5185\u4EE3\u7801\uFF1A\u6DE1\u5F69\u5E95 */
.md-scope code, .md-scope .cm-inline-code {
  font-family: var(--md-font-mono);
  font-size: 0.88em;
  background: var(--md-code-bg);
  color: var(--md-code-ink);
  border-radius: 5px;
  padding: 1.5px 5px;
}
/* \u5F15\u7528\u5757\uFF1A\u5DE6\u7EBF + \u5FAE\u5E95 */
.md-scope blockquote {
  margin: 0.7em 0;
  padding: 10px 18px;
  border-left: 3px solid var(--md-border);
  border-radius: 0 var(--md-radius) var(--md-radius) 0;
  background: var(--md-quote-bg);
  color: var(--md-text-2);
}
.md-scope blockquote p { margin: 0 0 0.5em; }
.md-scope blockquote p:last-child { margin-bottom: 0; }
/* \u4EE3\u7801\u5757\uFF08Typora .md-fences \u60EF\u4F8B\uFF09 */
.md-scope pre.md-fences {
  margin: 0.75em 0;
  padding: 14px 18px;
  background: var(--md-code-block-bg, var(--md-surface));
  border: 1px solid var(--md-border);
  border-radius: var(--md-radius-lg);
  font-family: var(--md-font-mono);
  font-size: 0.86em;
  line-height: 1.6;
  overflow-x: auto;
  tab-size: 2;
  position: relative;
}
.md-scope pre.md-fences .cm-static-lines { margin: 0; white-space: pre; }
/* 代码 token 配色：全部走 CSS 变量，data-code-theme 切换变量组即可换肤 */
.md-scope .cm-keyword { color: var(--md-tok-keyword, #9f2f2d); }
.md-scope .cm-string { color: var(--md-tok-string, #346538); }
.md-scope .cm-number { color: var(--md-tok-number, #956400); }
.md-scope .cm-comment { color: var(--md-tok-comment, var(--md-text-2)); font-style: italic; }
.md-scope .cm-variable, .md-scope .cm-def { color: var(--md-tok-variable, var(--md-text)); }
.md-scope .cm-variable-2 { color: var(--md-tok-function, #1f6c9f); }
.md-scope .cm-variable-3 { color: var(--md-tok-type, #7a4fa3); }
.md-scope .cm-tag { color: var(--md-tok-tag, #9f2f2d); }
.md-scope .cm-attribute { color: var(--md-tok-attribute, #956400); }
.md-scope .cm-operator, .md-scope .cm-meta { color: var(--md-tok-operator, var(--md-text-2)); }
.md-scope .cm-atom { color: var(--md-tok-atom, #1f6c9f); }
.md-scope .cm-header, .md-scope .cm-link { color: var(--md-tok-link, var(--md-link)); }
/* 代码块语言角标（渲染态） */
.md-scope pre.md-fences[data-lang]:not([data-lang=""])::after {
  content: attr(data-lang);
  position: absolute; top: 6px; right: 10px;
  font-size: 10px; letter-spacing: .04em; text-transform: lowercase;
  color: var(--md-text-2); opacity: .55; pointer-events: none;
}

/* ---------------- 代码块配色主题（设置 → 代码配色） ---------------- */
/* 变量定义在 :root 上（由设置写 data-code-theme），后代选择器统一走 :root 前缀，
   这样编辑器、设置页预览和导出容器都命中同一套变量。 */
:root[data-code-theme='github'] {
  --md-code-block-bg: #f6f8fa;
  --md-tok-keyword: #cf222e; --md-tok-string: #0a3069; --md-tok-number: #0550ae;
  --md-tok-comment: #6e7781; --md-tok-function: #8250df; --md-tok-type: #953800;
  --md-tok-tag: #116329; --md-tok-attribute: #0550ae; --md-tok-operator: #24292f; --md-tok-atom: #0550ae;
}
:root[data-code-theme='monokai'] {
  --md-code-block-bg: #272822; --md-code-block-ink: #f8f8f2;
  --md-tok-keyword: #f92672; --md-tok-string: #e6db74; --md-tok-number: #ae81ff;
  --md-tok-comment: #75715e; --md-tok-function: #a6e22e; --md-tok-type: #66d9ef;
  --md-tok-tag: #f92672; --md-tok-attribute: #a6e22e; --md-tok-operator: #f8f8f2; --md-tok-atom: #ae81ff;
}
:root[data-code-theme='dracula'] {
  --md-code-block-bg: #282a36; --md-code-block-ink: #f8f8f2;
  --md-tok-keyword: #ff79c6; --md-tok-string: #f1fa8c; --md-tok-number: #bd93f9;
  --md-tok-comment: #6272a4; --md-tok-function: #50fa7b; --md-tok-type: #8be9fd;
  --md-tok-tag: #ff79c6; --md-tok-attribute: #50fa7b; --md-tok-operator: #f8f8f2; --md-tok-atom: #bd93f9;
}
:root[data-code-theme='solarized'] {
  --md-code-block-bg: #fdf6e3; --md-code-block-ink: #657b83;
  --md-tok-keyword: #859900; --md-tok-string: #2aa198; --md-tok-number: #d33682;
  --md-tok-comment: #93a1a1; --md-tok-function: #268bd2; --md-tok-type: #b58900;
  --md-tok-tag: #268bd2; --md-tok-attribute: #b58900; --md-tok-operator: #657b83; --md-tok-atom: #d33682;
}
:root[data-code-theme='nord'] {
  --md-code-block-bg: #2e3440; --md-code-block-ink: #d8dee9;
  --md-tok-keyword: #81a1c1; --md-tok-string: #a3be8c; --md-tok-number: #b48ead;
  --md-tok-comment: #616e88; --md-tok-function: #88c0d0; --md-tok-type: #8fbcbb;
  --md-tok-tag: #81a1c1; --md-tok-attribute: #8fbcbb; --md-tok-operator: #81a1c1; --md-tok-atom: #b48ead;
}
/* 深色底主题：整块正文色跟着变量走，避免浅色主题下代码看不清 */
:root[data-code-theme='monokai'] .md-scope pre.md-fences,
:root[data-code-theme='dracula'] .md-scope pre.md-fences,
:root[data-code-theme='nord'] .md-scope pre.md-fences {
  color: var(--md-code-block-ink, #f8f8f2);
}
:root[data-code-theme='solarized'] .md-scope pre.md-fences { color: var(--md-code-block-ink, #657b83); }
:root[data-code-theme='github'] .md-scope pre.md-fences { color: #24292f; }
/* 源码态代码行也跟随代码配色 */
:root[data-code-theme='monokai'] .md-scope .md-fence-src,
:root[data-code-theme='dracula'] .md-scope .md-fence-src,
:root[data-code-theme='nord'] .md-scope .md-fence-src {
  background: var(--md-code-block-bg);
  color: var(--md-code-block-ink, #f8f8f2);
  border-color: color-mix(in srgb, var(--md-code-block-ink, #fff) 18%, transparent);
}
/* \u8868\u683C\uFF1Afigure.md-table-figures \u5305\u88F9\uFF0C\u5706\u89D2 1px \u7EBF */
.md-scope figure.md-table-figures {
  margin: 0.75em 0;
  padding: 0;
  width: fit-content;
  max-width: 100%;
  border: 1px solid var(--md-border);
  border-radius: var(--md-radius-lg);
  overflow: hidden;
  background: var(--md-surface);
}
.md-scope .md-table-block { overflow-x: auto; }
.md-scope table.md-table { border-collapse: collapse; font-size: 0.93em; }
.md-scope table.md-table th {
  font-weight: 600;
  text-align: left;
  padding: 9px 16px;
  background: var(--md-quote-bg);
  border-bottom: 1px solid var(--md-border);
  white-space: nowrap;
}
.md-scope table.md-table td { padding: 8px 16px; border-bottom: 1px solid color-mix(in srgb, var(--md-border) 55%, transparent); }
.md-scope table.md-table tr:last-child td { border-bottom: none; }
/* \u5217\u8868 */
.md-scope ul, .md-scope ol { margin: 0 0 0.7em; padding-left: 1.35em; }
.md-scope li { margin: 0.25em 0; }
.md-scope li::marker { color: var(--md-text-2); }
.md-scope ul.contains-task-list { list-style: none; padding-left: 0.4em; }
.md-scope li.md-task-list-item { display: flex; gap: 8px; align-items: baseline; }
.md-scope li.md-task-list-item input[type="checkbox"] { accent-color: var(--md-link); margin-top: 0.45em; }
/* hr */
.md-scope hr { border: none; border-top: 1px solid var(--md-border); margin: 2em 0; }
/* \u56FE\u7247 */
/* 全局尺寸由设置写入根元素变量；单张可在源码里用 HTML <img width height> 或
   ![](url){width=300 height=180} 覆盖（渲染层会把它转成内联样式）。
   注意：这里不写 width/height:auto，否则会盖掉 HTML 的 width/height 属性。 */
.md-scope img {
  max-width: var(--md-img-max-w, 100%);
  max-height: var(--md-img-max-h, none);
  object-fit: contain;
  border-radius: var(--md-radius);
  display: block;
  margin: 0.4em auto;
}
.md-scope span.md-image { display: inline-block; }
/* 编辑态图片预览（行内 widget）：尺寸跟随设置变量，单张覆盖写内联样式 */
.md-scope .md-image-widget {
  display: inline-block;
  max-width: var(--md-img-max-w, 100%);
  line-height: 0;
  vertical-align: bottom;
}
.md-scope .md-image-widget img {
  max-width: var(--md-img-max-w, 100%);
  max-height: var(--md-img-max-h, none);
  border-radius: var(--md-radius);
  display: inline-block;
  margin: 0.2em 0;
  cursor: pointer;
}
.md-scope .md-image-widget[data-align='left'] { display: block; text-align: left; }
.md-scope .md-image-widget[data-align='center'] { display: block; text-align: center; }
.md-scope .md-image-widget[data-align='right'] { display: block; text-align: right; }
.md-scope .md-image-widget.is-broken { font-family: var(--md-font-mono); font-size: 0.85em; color: var(--md-text-2); }
/* \u6570\u5B66 */
.md-scope .katex { font-size: 1.02em; }
.md-scope p.md-math-block { text-align: center; margin: 0.75em 0; overflow-x: auto; }
.md-scope .md-inline-math { font-size: 0.98em; padding: 0 2px; }
/* mermaid */
.md-scope .md-mermaid { text-align: center; margin: 1em 0; }
.md-scope .md-mermaid svg { border-radius: var(--md-radius); }
.md-scope .md-mermaid-error-card {
  border: 1px solid color-mix(in srgb, #9f2f2d 35%, var(--md-border));
  border-radius: var(--md-radius);
  background: var(--md-surface);
  padding: 12px 16px;
  font-size: 0.85em;
  color: #9f2f2d;
  text-align: left;
}
.md-scope .md-mermaid-error-card pre { font-family: var(--md-font-mono); white-space: pre-wrap; margin: 6px 0 0; opacity: .8; }
/* \u811A\u6CE8 */
.md-scope .footnotes { font-size: 0.88em; color: var(--md-text-2); border-top: 1px solid var(--md-border); margin-top: 2em; padding-top: 0.8em; }
.md-scope .footnote-ref { font-size: 0.75em; vertical-align: super; }
/* front matter */
.md-scope pre.md-meta-block {
  font-family: var(--md-font-mono);
  font-size: 0.82em;
  color: var(--md-text-2);
  background: var(--md-quote-bg);
  border: 1px solid var(--md-border);
  border-radius: var(--md-radius);
  padding: 10px 14px;
  margin-bottom: 1.5em;
  white-space: pre-wrap;
}
/* HTML \u5757 */
/* 尺寸同样走设置变量：超宽 HTML（iframe/表格/长图）不会撑破内容栏；
   内容本身按变量上限收窄并居中。 */
.md-scope .md-html-block {
  margin: 1em 0;
  max-width: var(--md-html-max-w, 100%);
  max-height: var(--md-html-max-h, none);
  overflow: auto;
  margin-inline: auto;
}
.md-scope .md-html-block > img,
.md-scope .md-html-block img { max-width: 100%; height: auto; }
.md-scope pre.md-html-raw { font-family: var(--md-font-mono); font-size: 0.84em; color: var(--md-text-2); background: var(--md-quote-bg); border-radius: var(--md-radius); padding: 10px 14px; white-space: pre-wrap; }
/* \u6E90\u7801\u6001\uFF08\u5149\u6807\u6240\u5728\u5757\uFF09\u878D\u5165 */
.md-scope .cm-line { padding: 0 2px; }
.md-scope .cm-content { caret-color: var(--md-link); }
/* 选中背景统一由 drawSelection 的 .cm-selectionBackground 层绘制（贴合文本盒）；
   原生 ::selection 保持透明，否则全选时行 padding 与折叠空行会画出重叠方块。 */
.md-scope .cm-selectionBackground,
.md-scope .cm-editor.cm-focused .cm-selectionBackground {
  background: color-mix(in srgb, var(--md-link) 18%, transparent) !important;
}
.md-scope .cm-editor .cm-line::selection,
.md-scope .cm-editor .cm-line ::selection,
.md-scope .cm-editor .cm-content::selection,
.md-scope .cm-editor .cm-content ::selection {
  background: transparent !important;
  background-color: transparent !important;
}
.md-scope .cm-editor .cm-selectionMatch { background: color-mix(in srgb, var(--md-link) 12%, transparent); }
.md-scope .cm-cursor { border-left-color: var(--md-link); }
/* 折叠空行不画背景块（全选时高亮保持连续） */
.md-scope .cm-blank-line,
.md-scope .cm-blank-line::after { background: transparent; }
/* \u6253\u5B57\u673A/\u4E13\u6CE8 */
.md-scope[data-focus-mode="on"] .md-live-block { opacity: 0.35; transition: opacity .35s cubic-bezier(.16,1,.3,1); }
.md-scope[data-focus-mode="on"] .md-live-block.is-active, .md-scope[data-focus-mode="on"] .cm-active-line { opacity: 1; }
/* kbd */
.md-scope kbd {
  font-family: var(--md-font-mono); font-size: 0.82em;
  border: 1px solid var(--md-border); border-radius: 4px;
  background: var(--md-quote-bg); padding: 1px 5px;
}
`;
function builtinThemeCss(themeId) {
  const vars = themeId.endsWith("-dark") ? MINIMAL_DARK_CSS : MINIMAL_LIGHT_CSS;
  return vars + CONTENT_CSS;
}
function adaptTyporaCss(css) {
  return css.replace(/@import[^;]+;/g, "/* @import removed */").replace(/(^|\})\s*html\s*([,{])/g, "$1.md-scope$2").replace(/(^|\})\s*body\s*([,{])/g, "$1.md-scope$2").replace(/:root/g, ".md-scope");
}
function themeNameToId(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "user-theme";
}
export {
  BUILTIN_THEMES,
  CONTENT_CSS,
  MINIMAL_DARK_CSS,
  MINIMAL_LIGHT_CSS,
  THEME_CONTAINER_ATTR,
  adaptTyporaCss,
  applyTheme,
  builtinThemeCss,
  getActiveTheme,
  themeNameToId
};
