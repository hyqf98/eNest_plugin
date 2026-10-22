/**
 * 手绘笔触基础件（DOM 版，零构建）
 *
 * 真正的手绘感来自三样东西，都不是 CSS 圆角能给的：
 *   1. SVG 位移滤镜（feTurbulence + feDisplacementMap）：把笔直的边框推歪，得到手抖的线；
 *   2. 手绘涂鸦路径：箭头、星号、波浪下划线，用来标注而不是装饰；
 *   3. 实物隐喻：胶带、装订环、橡皮章。
 *
 * 滤镜定义只放一份，靠 id 被 CSS 的 filter: url(#...) 引用。
 * 只作用于纯描边的伪元素：滤镜会让元素成为包含块，套在容器上会破坏定位与滚动。
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 一段 SVG 标记 → 元素。CSP 允许 inline style，但这里只用属性，避免依赖。 */
function svgFromMarkup(markup, className) {
  const holder = document.createElement('div')
  holder.innerHTML = markup
  const svg = holder.firstElementChild
  if (svg && className) svg.setAttribute('class', className)
  return svg
}

const DEFS_MARKUP = `<svg xmlns="http://www.w3.org/2000/svg" class="sk-defs" aria-hidden="true" focusable="false"><defs>
<filter id="sk-rough" x="-8%" y="-8%" width="116%" height="116%">
<feTurbulence type="fractalNoise" baseFrequency="0.018 0.024" numOctaves="3" seed="7" result="noise"/>
<feDisplacementMap in="SourceGraphic" in2="noise" scale="3.6" xChannelSelector="R" yChannelSelector="G"/>
</filter>
<filter id="sk-rough-fine" x="-10%" y="-10%" width="120%" height="120%">
<feTurbulence type="fractalNoise" baseFrequency="0.055 0.07" numOctaves="2" seed="3" result="noise"/>
<feDisplacementMap in="SourceGraphic" in2="noise" scale="1.7" xChannelSelector="R" yChannelSelector="G"/>
</filter>
<symbol id="sk-arrow" viewBox="0 0 48 40"><path d="M3 6c9 2.4 17.5 6.8 24 14.2 3 3.4 5.4 7.4 7.2 12"/><path d="M26.6 30.4c3.4-.6 6.6-1.2 9.8-1.9M34.6 21.6c.6 3.2 1.2 6.2 1.9 9.2"/></symbol>
<symbol id="sk-star" viewBox="0 0 32 32"><path d="M16 4.4c.3 7.6.5 15.2.7 22.8M5.2 10.1c6.6 3.9 13.2 7.7 19.9 11.6M26.9 10c-6.7 3.9-13.3 7.8-19.9 11.7"/></symbol>
</defs></svg>`

/** 滤镜与 symbol 定义。挂到页面根即可，全页共享。 */
export function mountSketchDefs(parent = document.body) {
  if (document.querySelector('.sk-defs')) return
  const svg = svgFromMarkup(DEFS_MARKUP)
  if (svg) parent.appendChild(svg)
}

/** 手绘涂鸦：箭头 / 星号。装饰用途，不承载信息。 */
export function doodle(kind = 'star', size = 18) {
  const id = kind === 'arrow' ? 'sk-arrow' : 'sk-star'
  const box = kind === 'arrow' ? '0 0 48 40' : '0 0 32 32'
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'sk-doodle')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', box)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const use = document.createElementNS(SVG_NS, 'use')
  use.setAttribute('href', `#${id}`)
  svg.appendChild(use)
  return svg
}

/** 全视口纸面由市场三路由与样式台复用，必须位于滚动内容外层。 */
export function createSketchPaper() {
  const paper = document.createElement('div')
  paper.className = 'sk-paper'
  paper.setAttribute('aria-hidden', 'true')
  for (const className of ['sk-paper-fill', 'sk-drift', 'sk-drift sk-drift--cross', 'sk-stripes']) {
    const layer = document.createElement('span')
    layer.className = className
    paper.appendChild(layer)
  }
  return paper
}

/** 胶带：贴在卡片与照片顶边，让元素看起来是"贴进本子"的。 */
export function tape() {
  const span = document.createElement('span')
  span.className = 'sk-tape'
  span.setAttribute('aria-hidden', 'true')
  return span
}
