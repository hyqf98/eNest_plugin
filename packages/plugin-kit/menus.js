const focusable = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
let activeMenu = null
let activePeek = null
let sequence = 0
const hoverBindings = new Set()

function normalizeItems(items) {
  return (items || []).flatMap(item => {
    if (!item || item.hidden) return []
    if (item === 'sep' || item.sep) return [{ sep: true }]
    if (Array.isArray(item)) return [{ key: item[0], label: item[1], ...(typeof item[2] === 'object' ? item[2] : {}) }]
    return item.key == null ? [] : [item]
  })
}

function renderItems(menu, items, select) {
  for (const item of items) {
    if (item.sep) {
      const separator = document.createElement('div')
      separator.className = 'pk-menu-sep'
      separator.setAttribute('role', 'separator')
      menu.append(separator)
      continue
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.tabIndex = -1
    button.className = `pk-menu-item${item.danger ? ' danger' : ''}`
    button.dataset.k = String(item.key)
    button.disabled = Boolean(item.disabled)
    button.setAttribute('role', item.checked == null ? 'menuitem' : 'menuitemcheckbox')
    if (item.checked != null) button.setAttribute('aria-checked', String(Boolean(item.checked)))
    const check = document.createElement('span')
    check.className = 'pk-menu-check'
    check.setAttribute('aria-hidden', 'true')
    check.textContent = item.checked ? '✓' : ''
    const label = document.createElement('span')
    label.className = 'pk-menu-label'
    label.textContent = String(item.label ?? item.key)
    button.append(check, label)
    if (item.hint) {
      const hint = document.createElement('span')
      hint.className = 'pk-menu-hint pk-mono'
      hint.textContent = String(item.hint)
      button.append(hint)
    }
    button.addEventListener('click', event => {
      event.stopPropagation()
      if (!button.disabled) select(item, button, event)
    })
    menu.append(button)
  }
}

function focusItem(menu, index) {
  const buttons = [...menu.querySelectorAll('button[data-k]')]
  const enabled = buttons.filter(button => !button.disabled)
  const target = enabled.length ? enabled[(index + enabled.length) % enabled.length] : menu
  buttons.forEach(button => { button.tabIndex = button === target ? 0 : -1 })
  target.focus({ preventScroll: true })
  if (target !== menu) target.scrollIntoView({ block: 'nearest' })
}

function navigateMenu(menu, event) {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false
  const buttons = [...menu.querySelectorAll('button[data-k]:not(:disabled)')]
  const index = buttons.indexOf(document.activeElement)
  let next
  if (event.key === 'ArrowDown') next = index + 1
  else if (event.key === 'ArrowUp') next = index < 0 ? buttons.length - 1 : index - 1
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = buttons.length - 1
  else if (event.key.length === 1 && event.key !== ' ') {
    const rotated = [...buttons.slice(index + 1), ...buttons.slice(0, index + 1)]
    const match = rotated.find(button => button.querySelector('.pk-menu-label').textContent.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()))
    if (match) next = buttons.indexOf(match)
  }
  if (next == null) return false
  event.preventDefault()
  event.stopPropagation()
  focusItem(menu, next)
  return true
}

function placeMenu(menu, anchor, point, { side = 'bottom', align = 'start', gap = 4 } = {}) {
  const rect = menu.getBoundingClientRect()
  const bounds = anchor?.getBoundingClientRect() || { top: 4, bottom: 4, left: 4, right: 4 }
  let left = point?.x ?? (align === 'end' ? bounds.right - rect.width : bounds.left)
  let top = point?.y ?? bounds.bottom + gap
  if (!point && (side === 'left' || side === 'right')) {
    left = side === 'right' ? bounds.right + gap : bounds.left - rect.width - gap
    if (left + rect.width > innerWidth - 8) left = bounds.left - rect.width - gap
    if (left < 8) left = bounds.right + gap
    top = bounds.top
  } else if (!point && top + rect.height > innerHeight - 8 && bounds.top > innerHeight - bounds.bottom) {
    top = bounds.top - rect.height - gap
  }
  menu.style.left = `${Math.round(Math.max(8, Math.min(left, innerWidth - rect.width - 8)))}px`
  menu.style.top = `${Math.round(Math.max(8, Math.min(top, innerHeight - rect.height - 8)))}px`
}

export function closeMenu({ restoreFocus = true } = {}) {
  activeMenu?.close(restoreFocus)
}

export function openMenu(source, items, onPick, options = {}) {
  closeMenu()
  const list = normalizeItems(items)
  if (!list.some(item => !item.sep)) return null
  const anchor = source instanceof Element ? source : source?.currentTarget instanceof Element ? source.currentTarget : source?.target?.closest?.(focusable)
  if (!activePeek?.contains(anchor)) activePeek?.hide()
  const previousFocus = anchor?.matches(focusable) ? anchor : document.activeElement
  const point = !(source instanceof Element) && Number.isFinite(source?.clientX) && Number.isFinite(source?.clientY) && (source.clientX || source.clientY)
    ? { x: source.clientX, y: source.clientY } : null
  const menu = document.createElement('div')
  menu.className = 'pk-menu'
  menu.id = `pk-menu-${++sequence}`
  menu.tabIndex = -1
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', options.ariaLabel || '操作菜单')
  menu.setAttribute('data-input-context', 'overlay')
  const expanded = anchor?.getAttribute('aria-expanded')
  const controls = anchor?.getAttribute('aria-controls')
  const controller = new AbortController()
  const { signal } = controller
  const close = (restoreFocus = false) => {
    if (activeMenu?.element !== menu) return
    activeMenu = null
    controller.abort()
    const hadFocus = menu.contains(document.activeElement) || document.activeElement === document.body
    menu.remove()
    if (anchor) {
      restoreAttribute(anchor, 'aria-expanded', expanded)
      restoreAttribute(anchor, 'aria-controls', controls)
    }
    if (restoreFocus && hadFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  }
  renderItems(menu, list, (item, button, event) => {
    close(true)
    if (onPick) onPick(String(item.key), button)
    else item.onSelect?.(event)
  })
  document.body.append(menu)
  activeMenu = { element: menu, anchor, close }
  anchor?.setAttribute('aria-expanded', 'true')
  anchor?.setAttribute('aria-controls', menu.id)
  placeMenu(menu, anchor, point, options)
  document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target)) close(false)
  }, { capture: true, signal })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      close(true)
    } else if (menu.contains(event.target)) {
      if (event.key === 'Tab') close(true)
      else navigateMenu(menu, event)
    }
  }, { capture: true, signal })
  document.addEventListener('focusin', event => { if (!menu.contains(event.target)) close(false) }, { signal })
  document.addEventListener('scroll', event => { if (!menu.contains(event.target)) close(false) }, { capture: true, signal })
  window.addEventListener('resize', () => close(true), { signal })
  window.addEventListener('blur', () => close(false), { signal })
  window.addEventListener('pagehide', () => close(false), { signal })
  focusItem(menu, 0)
  queueMicrotask(() => {
    if (activeMenu?.element === menu && (document.activeElement?.disabled || document.activeElement === menu)) focusItem(menu, 0)
  })
  return menu
}

export function attachContextMenu(target, items, options = {}) {
  const nodes = target instanceof Element ? [target] : [...(target || [])]
  const open = event => {
    const list = typeof items === 'function' ? items(event) : items
    if (!normalizeItems(list).some(item => !item.sep)) return
    event.preventDefault()
    event.stopPropagation()
    openMenu(event.type === 'keydown' ? event.currentTarget : event, list, options.onPick, options)
  }
  const keyboard = event => {
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') open(event)
  }
  for (const node of nodes) {
    node.addEventListener('contextmenu', open)
    node.addEventListener('keydown', keyboard)
  }
  return () => {
    for (const node of nodes) {
      node.removeEventListener('contextmenu', open)
      node.removeEventListener('keydown', keyboard)
    }
  }
}

function restoreAttribute(element, name, value) {
  if (value == null) element.removeAttribute(name)
  else element.setAttribute(name, value)
}

// The live panel stays mounted: editor state and connection resources belong to its caller.
export function bindHoverPanel(anchor, panel, options = {}) {
  const { delay = 120, hideDelay = 300, handleClick = true } = options
  let previousExpanded = anchor.getAttribute('aria-expanded')
  let open = false, destroyed = false, overAnchor = false, overPanel = false
  let showTimer = 0, hideTimer = 0
  const lifetime = new AbortController()
  let visible = null
  const enabled = () => !destroyed && anchor.isConnected && panel.isConnected && !anchor.disabled && (typeof options.enabled === 'function' ? options.enabled() : options.enabled !== false)
  const ownsPortal = target => target instanceof Node && (activeMenu && panel.contains(activeMenu.anchor) && activeMenu.element.contains(target) || [...panel.querySelectorAll('[aria-controls][aria-expanded="true"]')].some(trigger => {
    const popup = document.getElementById(trigger.getAttribute('aria-controls'))
    return popup?.contains(target)
  }))
  const inside = target => target instanceof Node && (anchor.contains(target) || panel.contains(target) || ownsPortal(target))
  const cancelTimers = () => { clearTimeout(showTimer); clearTimeout(hideTimer) }
  const hide = ({ restoreFocus = false } = {}) => {
    cancelTimers()
    if (!open) return
    const childMenuFocused = activeMenu && panel.contains(activeMenu.anchor) && activeMenu.element.contains(document.activeElement)
    if (activeMenu && panel.contains(activeMenu.anchor)) closeMenu({ restoreFocus: false })
    open = false
    overPanel = false
    visible?.abort()
    visible = null
    if (activePeek === binding) activePeek = null
    const hadFocus = childMenuFocused || panel.contains(document.activeElement)
    panel.removeAttribute('data-peek')
    restoreAttribute(anchor, 'aria-expanded', previousExpanded)
    options.onOpenChange?.(false)
    if (restoreFocus && hadFocus && anchor.isConnected) anchor.focus({ preventScroll: true })
  }
  const scheduleHide = () => {
    clearTimeout(showTimer)
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (!enabled()) hide()
      else if (!overAnchor && !overPanel && !panel.contains(document.activeElement) && !ownsPortal(document.activeElement)) hide()
    }, hideDelay)
  }
  const show = ({ focus = false } = {}) => {
    cancelTimers()
    if (!enabled()) return
    if (!open) {
      activePeek?.hide()
      closeMenu({ restoreFocus: false })
      activePeek = binding
      open = true
      previousExpanded = anchor.getAttribute('aria-expanded')
      panel.dataset.peek = 'true'
      anchor.setAttribute('aria-expanded', 'true')
      options.onOpenChange?.(true)
      visible = new AbortController()
      const { signal } = visible
      document.addEventListener('pointerdown', event => { if (!inside(event.target)) hide() }, { capture: true, signal })
      document.addEventListener('focusin', event => { if (!inside(event.target)) scheduleHide() }, { signal })
      document.addEventListener('keydown', event => {
        const childOverlay = event.target?.closest?.('[role="menu"], [role="listbox"], [role="dialog"], dialog[open]')
        if (event.key === 'Escape' && !event.defaultPrevented && !activeMenu && (!childOverlay || childOverlay === panel)) {
          event.preventDefault()
          event.stopImmediatePropagation()
          hide({ restoreFocus: true })
        }
      }, { capture: true, signal })
      window.addEventListener('blur', () => hide(), { signal })
      window.addEventListener('resize', () => hide({ restoreFocus: true }), { signal })
      document.addEventListener('visibilitychange', () => { if (document.hidden) hide() }, { signal })
    }
    if (focus) (panel.querySelector(focusable) || panel).focus({ preventScroll: true })
  }
  const onEnter = (event, isPanel) => {
    if (event.pointerType === 'touch') return
    if (!enabled()) { hide(); return }
    if (isPanel) overPanel = true
    else overAnchor = true
    cancelTimers()
    if (!open && !isPanel) showTimer = setTimeout(() => show(), delay)
  }
  const onLeave = isPanel => {
    if (isPanel) overPanel = false
    else overAnchor = false
    scheduleHide()
  }
  const { signal } = lifetime
  anchor.addEventListener('pointerenter', event => onEnter(event, false), { signal })
  panel.addEventListener('pointerenter', event => onEnter(event, true), { signal })
  anchor.addEventListener('pointerleave', () => onLeave(false), { signal })
  panel.addEventListener('pointerleave', () => onLeave(true), { signal })
  panel.addEventListener('focusin', cancelTimers, { signal })
  panel.addEventListener('focusout', scheduleHide, { signal })
  anchor.addEventListener('focusout', scheduleHide, { signal })
  anchor.addEventListener('keydown', event => {
    if (!enabled() || !['ArrowDown', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    show({ focus: true })
  }, { signal })
  anchor.addEventListener('click', event => {
    if (!handleClick) { hide(); return }
    if (!enabled()) return
    event.preventDefault()
    if (open) hide({ restoreFocus: true })
    else show({ focus: true })
  }, { signal, capture: !handleClick })
  const binding = {
    show, hide, contains: inside,
    destroy() {
      if (destroyed) return
      hide()
      destroyed = true
      cancelTimers()
      lifetime.abort()
      hoverBindings.delete(binding)
      options.onDestroy?.()
    },
  }
  hoverBindings.add(binding)
  window.addEventListener('pagehide', () => binding.destroy(), { signal })
  return binding
}

export function hoverFlyout(anchor, items, options = {}) {
  const panel = document.createElement('div')
  panel.className = 'pk-flyout'
  panel.hidden = true
  panel.tabIndex = -1
  panel.id = `pk-flyout-${++sequence}`
  panel.setAttribute('role', 'menu')
  panel.setAttribute('aria-label', options.ariaLabel || '导航菜单')
  panel.setAttribute('data-input-context', 'overlay')
  document.body.append(panel)
  const originalControls = anchor.getAttribute('aria-controls')
  const originalPopup = anchor.getAttribute('aria-haspopup')
  anchor.setAttribute('aria-controls', panel.id)
  anchor.setAttribute('aria-haspopup', 'menu')
  let frame = 0
  const binding = bindHoverPanel(anchor, panel, {
    ...options,
    onOpenChange(open) {
      cancelAnimationFrame(frame)
      if (open) {
        panel.replaceChildren()
        renderItems(panel, normalizeItems(typeof items === 'function' ? items() : items), (item, button, event) => {
          binding.hide({ restoreFocus: true })
          const pick = options.onPick || options.onSelect
          if (pick) pick(String(item.key), button)
          else item.onSelect?.(event)
        })
        panel.hidden = false
        placeMenu(panel, anchor, null, { ...options, side: options.side || 'right' })
        frame = requestAnimationFrame(() => { if (!panel.hidden) panel.dataset.open = 'true' })
      } else {
        panel.hidden = true
        panel.removeAttribute('data-open')
      }
      options.onOpenChange?.(open)
    },
    onDestroy() {
      cancelAnimationFrame(frame)
      panel.remove()
      restoreAttribute(anchor, 'aria-controls', originalControls)
      restoreAttribute(anchor, 'aria-haspopup', originalPopup)
      options.onDestroy?.()
    },
  })
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      binding.hide({ restoreFocus: true })
    } else if (event.key === 'Tab') {
      // Return to the trigger before the browser calculates the next tab stop.
      binding.hide({ restoreFocus: true })
    } else navigateMenu(panel, event)
  })
  return binding
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  closeMenu({ restoreFocus: false })
  for (const binding of [...hoverBindings]) binding.destroy()
})
