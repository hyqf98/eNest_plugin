/**
 * ctxMenu.js — 自定义右键菜单（键盘导航、Esc / 点击外部关闭）
 */

let activeMenu = null
let activeCleanup = null
let returnFocus = null

export function closeCtxMenu({ restoreFocus = true } = {}) {
  const menu = activeMenu, target = returnFocus
  const ownedFocus = menu?.contains(document.activeElement) || document.activeElement === document.body
  activeMenu = null
  returnFocus = null
  const cleanup = activeCleanup
  activeCleanup = null
  cleanup?.()
  menu?.remove()
  // Restore before a selection callback opens its next surface, never after it.
  if (restoreFocus && ownedFocus && target?.isConnected) target.focus({ preventScroll: true })
}

/**
 * @param {MouseEvent|{clientX:number,clientY:number}} ev
 * @param {Array<[string,string,{danger?:boolean}|string]|{sep:true}|string>} items
 *   支持：'sep' | [key,label] | [key,label,{danger}] | {key,label,danger}
 * @param {(key:string)=>void} onPick
 */
export function openCtxMenu(ev, items, onPick) {
  closeCtxMenu()
  const trigger = ev.target?.closest?.('button, [href], input, select, textarea, [tabindex]')
  returnFocus = trigger || document.activeElement
  const menu = document.createElement('div')
  menu.className = 'ctx-menu'
  menu.setAttribute('role', 'menu')
  menu.tabIndex = -1

  const list = (items || []).map((it) => {
    if (it === 'sep' || it?.sep) return { sep: true }
    if (Array.isArray(it)) {
      return { key: it[0], label: it[1], danger: !!(it[2] && typeof it[2] === 'object' && it[2].danger) }
    }
    return { key: it.key, label: it.label, danger: !!it.danger }
  })

  menu.innerHTML = list
    .map((it) =>
      it.sep
        ? '<div class="menu-sep" role="separator"></div>'
        : `<button type="button" role="menuitem" tabindex="-1" data-k="${escapeHtml(it.key)}" class="${it.danger ? 'danger' : ''}">${escapeHtml(it.label)}</button>`
    )
    .join('')

  document.body.appendChild(menu)
  const rect = menu.getBoundingClientRect()
  const x = Math.min(ev.clientX || 0, window.innerWidth - rect.width - 8)
  const y = Math.min(ev.clientY || 0, window.innerHeight - rect.height - 8)
  menu.style.left = `${Math.max(4, x)}px`
  menu.style.top = `${Math.max(4, y)}px`
  activeMenu = menu

  const buttons = [...menu.querySelectorAll('button[data-k]')]
  const enabledButtons = () => buttons.filter((button) => !button.disabled)
  const focusItem = (index) => {
    const target = enabledButtons()[index] || menu
    buttons.forEach((button) => { button.tabIndex = button === target ? 0 : -1 })
    target.focus({ preventScroll: true })
  }
  const onDocPointer = (event) => {
    // The pointer's destination owns focus; restoring here would steal it.
    if (!menu.contains(event.target)) closeCtxMenu({ restoreFocus: false })
  }
  const onKey = (event) => {
    if (activeMenu !== menu) return
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); closeCtxMenu(); return
    }
    if (!menu.contains(event.target)) return
    if (event.key === 'Tab') { closeCtxMenu(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const enabled = enabledButtons(), index = enabled.indexOf(document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : event.key === 'ArrowDown' ? (index + 1) % enabled.length : (index - 1 + enabled.length) % enabled.length
    focusItem(next)
  }
  // Delay only pointer binding so the opening gesture cannot dismiss the menu.
  const pointerTimer = setTimeout(() => {
    if (activeMenu === menu) document.addEventListener('pointerdown', onDocPointer, true)
  }, 0)
  document.addEventListener('keydown', onKey, true)
  activeCleanup = () => {
    clearTimeout(pointerTimer)
    document.removeEventListener('pointerdown', onDocPointer, true)
    document.removeEventListener('keydown', onKey, true)
  }

  for (const button of buttons) {
    button.addEventListener('focus', () => buttons.forEach((item) => { item.tabIndex = item === button ? 0 : -1 }))
    button.addEventListener('click', () => {
      const key = button.dataset.k
      closeCtxMenu()
      onPick?.(key)
    })
  }
  focusItem(0)
  // Callers may disable capability-dependent actions immediately after opening.
  queueMicrotask(() => {
    if (activeMenu === menu && (document.activeElement === document.body || document.activeElement === menu || buttons.includes(document.activeElement) && document.activeElement.disabled)) focusItem(0)
  })
  return menu
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
