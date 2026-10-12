/**
 * 自定义下拉（自 SSH 插件移植，与壳子 Select 组件同模式）：
 * 浮动面板 fixed 挂 body，避免原生 <select> 弹层在 modal overflow
 * 内被裁切/遮挡选项、深色主题下白底白字的问题。
 * enhanceSelect 保持原生 select 的 .value 读写与 change 事件完全兼容。
 */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c])

let activeDropdown = null

export function closeDropdown() {
  if (!activeDropdown) return
  try {
    activeDropdown.el.remove()
  } catch {
    /* ignore */
  }
  activeDropdown.trigger?.classList.remove('open')
  activeDropdown.trigger?.setAttribute('aria-expanded', 'false')
  activeDropdown = null
}

export function openDropdown(trigger, items, onSelect, currentValue) {
  if (!trigger) return
  if (activeDropdown && activeDropdown.trigger === trigger) {
    closeDropdown()
    return
  }
  closeDropdown()
  const el = document.createElement('div')
  el.className = 'cs-dropdown'
  el.setAttribute('role', 'listbox')
  if (!items.length) {
    el.innerHTML = '<div class="cs-option cs-empty">暂无选项</div>'
  } else {
    el.innerHTML = items
      .map((it) => {
        const selected = String(it.id) === String(currentValue ?? '') ? ' selected' : ''
        const hint = it.hint ? `<span class="cs-opt-hint">${esc(it.hint)}</span>` : ''
        return `<div class="cs-option${selected}" role="option" data-id="${esc(String(it.id))}"><span class="cs-opt-label">${esc(it.label)}</span>${hint}</div>`
      })
      .join('')
  }
  document.body.appendChild(el)
  const rect = trigger.getBoundingClientRect()
  const panelW = Math.max(rect.width, 160)
  const maxW = Math.min(Math.max(panelW, 200), Math.max(180, window.innerWidth - 16))
  el.style.minWidth = Math.min(panelW, maxW) + 'px'
  el.style.maxWidth = maxW + 'px'
  el.style.left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - maxW - 8)) + 'px'
  const estH = Math.min(280, items.length * 34 + 8)
  const spaceBelow = window.innerHeight - rect.bottom - 8
  const spaceAbove = rect.top - 8
  if (spaceBelow >= Math.min(estH, 160) || spaceBelow >= spaceAbove) {
    el.style.top = Math.min(rect.bottom + 4, window.innerHeight - 40) + 'px'
    el.style.maxHeight = Math.max(96, spaceBelow) + 'px'
  } else {
    el.style.bottom = Math.max(8, window.innerHeight - rect.top + 4) + 'px'
    el.style.maxHeight = Math.max(96, spaceAbove) + 'px'
  }
  trigger.classList.add('open')
  trigger.setAttribute('aria-expanded', 'true')
  activeDropdown = { el, trigger }

  el.addEventListener('click', (ev) => {
    const opt = ev.target.closest('.cs-option')
    if (!opt || opt.classList.contains('cs-empty')) return
    const id = opt.dataset.id || ''
    closeDropdown()
    if (typeof onSelect === 'function') onSelect(id)
  })
}

/**
 * 原生 select 增强：隐藏原生控件、代之以 .cs-trigger 自定义下拉。
 * 覆盖实例 value 属性 + 选择后派发 change，既有 .value 读写与监听零改动。
 */
export function enhanceSelect(select) {
  if (!select || select.dataset.enhanced === '1') return
  select.dataset.enhanced = '1'
  const protoValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
  const readOptions = () =>
    Array.from(select.options).map((o) => ({ id: o.value, label: o.textContent || o.value }))

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'cs-trigger cs-select'
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.innerHTML = '<span class="cs-label"></span><span class="cs-caret">▾</span>'
  select.insertAdjacentElement('afterend', trigger)
  select.style.display = 'none'

  const syncLabel = () => {
    const cur = protoValue.get.call(select)
    const hit = readOptions().find((it) => String(it.id) === String(cur))
    trigger.querySelector('.cs-label').textContent = hit ? hit.label : cur
  }
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() {
      return protoValue.get.call(select)
    },
    set(v) {
      protoValue.set.call(select, v)
      syncLabel()
    },
  })

  trigger.addEventListener('click', () => {
    openDropdown(
      trigger,
      readOptions(),
      (id) => {
        select.value = id
        select.dispatchEvent(new Event('change', { bubbles: true }))
      },
      select.value
    )
  })
  syncLabel()
}

document.addEventListener('pointerdown', (ev) => {
  if (!activeDropdown) return
  if (activeDropdown.el.contains(ev.target)) return
  if (activeDropdown.trigger?.contains(ev.target)) return
  closeDropdown()
})
window.addEventListener('blur', () => closeDropdown())
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeDropdown()
})
