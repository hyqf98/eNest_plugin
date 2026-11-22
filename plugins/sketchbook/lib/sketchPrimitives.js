/**
 * 手绘笔触基础件（DOM 版，零构建）
 *
 * 真正的"手画"来自四样东西，都不是 CSS 圆角能给的：
 *   1. 位移滤镜（feTurbulence + feDisplacementMap）：把笔直线推歪，得到手抖的边；
 *   2. 实物隐喻：胶带、折角、图钉、打孔；
 *   3. 纸品分层：不同纸有自己的底色、纹理与投影高度；
 *   4. 笔迹记号：波浪下划线、圈注、涂鸦箭头，用来指向内容而不是装饰。
 *
 * 滤镜只挂在纯描边的绝对定位伪元素上 —— 滤镜会让元素成为包含块，
 * 套在容器上会连带破坏定位与滚动，这是这套主题最容易踩坏布局的地方。
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 一段 SVG 标记 → 元素。只用属性，不依赖内联样式。 */
function svgFromMarkup(markup, className) {
  const holder = document.createElement('div')
  holder.innerHTML = markup
  const svg = holder.firstElementChild
  if (svg && className) svg.setAttribute('class', className)
  return svg
}

/**
 * 两组粗糙度：coarse 给纸片外框，fine 给小控件与文字级笔迹，wild 给强调面。
 * baseFrequency 越低，被推歪的波长越长（整条线画歪了）；越高越像笔尖在纸纹上抖。
 * scale 是位移幅度上限。
 */
const DEFS_MARKUP = `<svg xmlns="http://www.w3.org/2000/svg" class="sk-defs" aria-hidden="true" focusable="false"><defs>
<filter id="sk-rough" x="-6%" y="-6%" width="112%" height="112%">
<feTurbulence type="fractalNoise" baseFrequency="0.014 0.021" numOctaves="3" seed="11" result="noise"/>
<feDisplacementMap in="SourceGraphic" in2="noise" scale="3.4" xChannelSelector="R" yChannelSelector="G"/>
</filter>
<filter id="sk-rough-fine" x="-8%" y="-8%" width="116%" height="116%">
<feTurbulence type="fractalNoise" baseFrequency="0.06 0.075" numOctaves="2" seed="5" result="noise"/>
<feDisplacementMap in="SourceGraphic" in2="noise" scale="1.5" xChannelSelector="R" yChannelSelector="G"/>
</filter>
<filter id="sk-rough-wild" x="-10%" y="-10%" width="120%" height="120%">
<feTurbulence type="fractalNoise" baseFrequency="0.01 0.016" numOctaves="2" seed="23" result="noise"/>
<feDisplacementMap in="SourceGraphic" in2="noise" scale="5.2" xChannelSelector="R" yChannelSelector="G"/>
</filter>
<filter id="sk-rough-b" x="-6%" y="-6%" width="112%" height="112%">
<feTurbulence type="fractalNoise" baseFrequency="0.014 0.021" numOctaves="3" seed="47" result="noise"/>
<feDisplacementMap in="SourceGraphic" in2="noise" scale="3.9" xChannelSelector="R" yChannelSelector="G"/>
</filter>
<filter id="sk-rough-c" x="-6%" y="-6%" width="112%" height="112%">
<feTurbulence type="fractalNoise" baseFrequency="0.014 0.021" numOctaves="3" seed="83" result="noise"/>
<feDisplacementMap in="SourceGraphic" in2="noise" scale="3.1" xChannelSelector="R" yChannelSelector="G"/>
</filter>
<symbol id="sk-arrow" viewBox="0 0 48 40"><path d="M3.4 5.6c9.2 2.6 17.8 7.1 24.4 14.6 3 3.4 5.5 7.5 7.3 12.1"/><path d="M26.9 30.1c3.4-.5 6.7-1.1 9.9-1.8M34.2 21.4c.7 3.2 1.3 6.2 2 9.2"/></symbol>
<symbol id="sk-star" viewBox="0 0 32 32"><path d="M16 4.1c.4 7.7.6 15.3.8 22.9M5 10.4c6.7 3.8 13.3 7.6 20 11.4M26.6 9.8c-6.7 3.9-13.4 7.8-20 11.7"/></symbol>
<symbol id="sk-spiral" viewBox="0 0 40 40"><path d="M22.4 6.8c-6.9-.6-12.7 4.2-13.3 11-.6 6.9 4.3 12.8 11.1 13.4 6.8.6 12.7-4.3 13.3-11.1.5-5.6-3.2-10.4-8.3-11.3-4.4-.8-8.5 2.4-9 6.9-.5 4.2 2.6 8 6.8 8.4"/></symbol>
<symbol id="sk-check" viewBox="0 0 32 32"><path d="M5.2 17.6c2.6 2.2 5.2 4.5 7.8 6.9 3.6-7 7.4-13.6 11.8-19.7"/></symbol>
</defs></svg>`

/** 滤镜与 symbol 定义。挂到页面根即可，全页共享；重复调用不会叠加。 */
export function mountSketchDefs(parent = document.body) {
  if (document.querySelector('.sk-defs')) return
  const svg = svgFromMarkup(DEFS_MARKUP)
  if (svg) parent.appendChild(svg)
}

const DOODLES = { arrow: ['sk-arrow', '0 0 48 40'], star: ['sk-star', '0 0 32 32'], spiral: ['sk-spiral', '0 0 40 40'], check: ['sk-check', '0 0 32 32'] }

/** 手绘涂鸦：箭头 / 星号 / 螺旋 / 对勾。装饰用途，不承载信息。 */
export function doodle(kind = 'star', size = 18) {
  const [id, box] = DOODLES[kind] ?? DOODLES.star
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'sk-doodle')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', box)
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const use = document.createElementNS(SVG_NS, 'use')
  use.setAttribute('href', `#${id}`)
  svg.appendChild(use)
  return svg
}

/**
 * 桌面底层。整页背景必须是滚动内容之外的独立层，
 * 否则长页面滚动时背景会跟着离开视口，纸就没地方"放"了。
 */
export function createSketchPaper() {
  const paper = document.createElement('div')
  paper.className = 'sk-surface sk-desk'
  paper.setAttribute('aria-hidden', 'true')
  const paint = document.createElement('span')
  paint.className = 'sk-desk-paint'
  const wash = document.createElement('span')
  wash.className = 'sk-wash'
  paper.append(paint, wash)
  return paper
}

/** 胶带：贴在纸的上沿，让它看起来是"贴进本子"的。 */
export function tape(options = {}) {
  const span = document.createElement('span')
  span.className = 'sk-tape'
  span.setAttribute('aria-hidden', 'true')
  if (options.width) span.style.setProperty('--sk-tape-w', `${options.width}px`)
  if (options.height) span.style.setProperty('--sk-tape-h', `${options.height}px`)
  if (options.tilt !== undefined) span.style.setProperty('--sk-tape-tilt', `${options.tilt}deg`)
  if (options.left !== undefined) span.style.left = `${options.left}%`
  return span
}

/** 图钉：纸角的小圆钉，替代胶带用在不同纸品上。 */
export function pin(options = {}) {
  const span = document.createElement('span')
  span.className = 'sk-pin'
  span.setAttribute('aria-hidden', 'true')
  if (options.left !== undefined) span.style.left = `${options.left}%`
  return span
}

/** 手抖描边层：绝对定位的空壳，CSS 在其 ::after 上画框。 */
export function drawBorder(variant = '') {
  const span = document.createElement('span')
  span.className = `sk-draw${variant ? ` sk-draw--${variant}` : ''}`
  span.setAttribute('aria-hidden', 'true')
  return span
}

/**
 * 纸片：组合出"一张摆在桌面上的纸"。
 *   stock: paper | card | pad | kraft | photo
 *   tooth: none | grid | ruled | kraft | fibre
 *   depth: sticky | slip | card | pad | paper（投影高度）
 */
export function paperSheet({ stock = 'card', tooth = 'none', depth = 'card', torn = false, dogear = false, tilt = 0 } = {}) {
  const node = document.createElement('article')
  node.className = [
    'sk-sheet', 'sk-surface', `sk-stock-${stock}`,
    tooth !== 'none' ? `sk-tooth-${tooth}` : '',
    `sk-sheet--${depth}`,
    torn ? 'sk-torn' : '', dogear ? 'sk-dogear' : '',
  ].filter(Boolean).join(' ')
  if (tilt) node.style.setProperty('--sk-tilt', `${tilt}deg`)
  return node
}

/** 活页纸板：左侧打孔的一整张纸，用于详情与设置页。 */
export function paperBoard({ stock = 'paper', tooth = 'ruled' } = {}) {
  const node = document.createElement('section')
  node.className = ['sk-surface', 'sk-board', `sk-stock-${stock}`, tooth !== 'none' ? `sk-tooth-${tooth}` : ''].filter(Boolean).join(' ')
  return node
}
