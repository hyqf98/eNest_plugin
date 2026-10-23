import { state, setUiPref } from './store.js'

/** A retargetable, critically damped drawer; pointer resizing never waits for animation. */
export class NavigationMotion {
  constructor(root, { items, onPick } = {}) {
    this.root = root; this.side = root.querySelector('#side'); this.toggle = root.querySelector('#side-toggle'); this.handle = root.querySelector('#resizer-left')
    this.position = 0; this.velocity = 0; this.target = 0; this.opened = false
    this.scrim = document.createElement('button'); this.scrim.type = 'button'; this.scrim.tabIndex = -1; this.scrim.className = 'wb-nav-scrim'; this.scrim.setAttribute('aria-label', '关闭连接面板'); root.querySelector('.workspace').append(this.scrim)
    this.toggle.onclick = () => this.isCompact() ? this.opened ? this.close() : this.open() : this.collapse(!state.ui.sidebarCollapsed)
    this.scrim.onclick = () => this.close()
    this.handle.tabIndex = 0; this.handle.setAttribute('role', 'separator'); this.handle.setAttribute('aria-label', '调整连接面板宽度'); this.handle.setAttribute('aria-orientation', 'vertical'); this.handle.setAttribute('aria-valuemin', '220'); this.handle.setAttribute('aria-valuemax', '360')
    this.handle.addEventListener('pointerdown', (event) => {
      if (this.isCompact()) return
      event.preventDefault(); this.handle.setPointerCapture(event.pointerId); this.drag = { x: event.clientX, width: this.side.getBoundingClientRect().width }; this.root.classList.add('is-resizing')
    })
    this.handle.addEventListener('pointermove', (event) => { if (this.drag) this.setWidth(this.drag.width + event.clientX - this.drag.x, false) })
    const release = () => { if (!this.drag) return; this.drag = null; this.root.classList.remove('is-resizing'); setUiPref('leftWidth', this.width) }
    this.handle.addEventListener('pointerup', release); this.handle.addEventListener('pointercancel', release); this.handle.addEventListener('lostpointercapture', release)
    this.handle.addEventListener('keydown', (event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); this.setWidth(event.key === 'Home' ? 220 : event.key === 'End' ? 360 : this.width + (event.key === 'ArrowRight' ? 10 : -10)) })
    this.flyouts = []
    if (items && window.PluginKit?.hoverFlyout) {
      const bindFlyout = (anchor, enabled) => window.PluginKit.hoverFlyout(anchor, items, {
        enabled, handleClick: false, onPick, side: 'right', delay: 120, hideDelay: 300, ariaLabel: '数据库工作区导航'
      })
      this.flyouts.push(bindFlyout(this.side, () => !this.isCompact() && !!state.ui.sidebarCollapsed))
      this.flyouts.push(bindFlyout(this.toggle, () => this.isCompact() ? !this.opened : !!state.ui.sidebarCollapsed))
    }
    this.onResize = () => this.update(); window.addEventListener('resize', this.onResize); this.update()
  }
  isCompact() { return this.root.dataset.surface === 'quick' || window.innerWidth < 720 }
  isOpen() { return this.isCompact() && this.opened }
  setWidth(value, persist = true) { this.width = Math.round(Math.max(220, Math.min(360, value || 240))); this.root.style.setProperty('--side-w', `${this.width}px`); this.side.style.width = `${this.width}px`; this.handle.setAttribute('aria-valuenow', this.width); if (persist) setUiPref('leftWidth', this.width) }
  collapse(value) { setUiPref('sidebarCollapsed', value); this.update() }
  update() {
    this.setWidth(state.ui.leftWidth, false)
    const compact = this.isCompact()
    if (this.compact !== compact || (compact ? this.opened : !state.ui.sidebarCollapsed)) this.hideFlyouts()
    this.compact = compact; this.root.dataset.navCompact = String(compact); this.root.dataset.navCollapsed = String(!compact && !!state.ui.sidebarCollapsed); this.root.classList.toggle('sidebar-collapsed', !compact && !!state.ui.sidebarCollapsed)
    this.side.hidden = false; this.side.classList.remove('collapsed'); this.toggle.setAttribute('aria-expanded', String(compact ? this.opened : !state.ui.sidebarCollapsed)); this.toggle.setAttribute('aria-controls', 'side')
    this.root.querySelector('.mid-col').inert = compact && this.opened
    this.side.inert = compact && !this.opened; const browser = this.side.querySelector('.nav-browser'); if (browser) browser.inert = !compact && !!state.ui.sidebarCollapsed
    this.root.dataset.navOpen = String(compact && this.opened)
    if (!compact) { cancelAnimationFrame(this.frame); this.side.style.transform = ''; this.side.style.opacity = '' }
    else { if (!this.opened && this.target !== 1) { this.position = 0; this.target = 0 }; this.paint() }
  }
  hideFlyouts() { this.flyouts.forEach((flyout) => flyout.hide()) }
  open() { this.hideFlyouts(); if (!this.isCompact()) { this.collapse(false); this.side.querySelector('input')?.focus(); return }; this.returnFocus = document.activeElement; this.opened = true; this.target = 1; this.update(); this.animate(); (this.side.querySelector('.nav-search') || this.side.querySelector('button'))?.focus() }
  close(restore = true) { if (!this.opened) return; this.opened = false; this.target = 0; this.root.dataset.navOpen = 'false'; this.side.inert = true; this.root.querySelector('.mid-col').inert = false; this.toggle.setAttribute('aria-expanded', 'false'); this.animate(); if (restore) (this.returnFocus?.isConnected ? this.returnFocus : this.toggle)?.focus() }
  paint() { this.side.style.transform = `translateX(${(this.position - 1) * this.width}px)`; this.scrim.style.opacity = String(this.position * 0.2) }
  animate() {
    cancelAnimationFrame(this.frame)
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.anim === 'low') { this.position = this.target; this.velocity = 0; this.paint(); return }
    let last = performance.now()
    const tick = (now) => { const dt = Math.min((now - last) / 1000, 0.025); last = now; const response = document.documentElement.dataset.anim === 'medium' ? 0.24 : 0.3, omega = 2 * Math.PI / response; this.velocity += ((this.target - this.position) * omega * omega - 2 * omega * this.velocity) * dt; this.position += this.velocity * dt; this.paint(); if (Math.abs(this.position - this.target) < 0.001 && Math.abs(this.velocity) < 0.005) { this.position = this.target; this.velocity = 0; this.paint(); return }; this.frame = requestAnimationFrame(tick) }
    this.frame = requestAnimationFrame(tick)
  }
  destroy() { this.flyouts.forEach((flyout) => flyout.destroy()); this.flyouts = []; cancelAnimationFrame(this.frame); window.removeEventListener('resize', this.onResize) }
}
