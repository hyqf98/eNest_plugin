/**
 * 极简 DOM 构造工具（零依赖、零构建）
 *
 * 主题工作区在 dev 源码态是磁盘直读的，宿主不为插件首页开放 vite 例外，
 * 因此这里不能依赖 JSX / 打包器。用 h() 建元素，比模板字符串更安全（自动转义文本）。
 */

/**
 * h('div', { class: 'x', onClick }, child1, child2)
 * - 属性名 style 支持对象；on* 走 addEventListener；其余走 setAttribute。
 * - 值为 null/undefined/false 的属性跳过；文本子节点自动转成 Text 节点。
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag)
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue
      if (key === 'style' && typeof value === 'object') {
        for (const [prop, val] of Object.entries(value)) {
          if (val === null || val === undefined) continue
          if (prop.startsWith('--')) el.style.setProperty(prop, String(val))
          else el.style[prop] = val
        }
      } else if (key === 'dataset' && typeof value === 'object') {
        for (const [prop, val] of Object.entries(value)) if (val !== null && val !== undefined) el.dataset[prop] = String(val)
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value)
      } else if (key === 'class') {
        el.className = value
      } else if (key in el && typeof value !== 'string') {
        el[key] = value
      } else {
        el.setAttribute(key, String(value))
      }
    }
  }
  append(el, children)
  return el
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue
    if (Array.isArray(child)) { append(el, child); continue }
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

/** 替换容器内容（视图整体重绘用；单节点更新请直接改 DOM）。 */
export function render(container, node) {
  container.replaceChildren(node)
}

/** 清空容器。 */
export function clear(container) {
  container.replaceChildren()
}
