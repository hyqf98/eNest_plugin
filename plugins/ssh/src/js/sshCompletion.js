/** Caret-anchored, append-only command suggestions. Native terminal navigation is left intact. */
import { createRemoteCompletion, mergeSuggestions } from '@ssh/js/remoteCompletion.js'

;(function (global) {
  const engine = global.SshCommandCompletion
  const labels = { cmd: '命令', subcommand: '子命令', flag: '选项', value: '参数', custom: '自定', snippet: '片段', history: '历史', path: '文件', directory: '目录', 'remote-command': '远端' }
  let nextId = 0

  function create({ getSession, getSources, send, readDirectory, readCommands, onStatus, onError }) {
    const id = `ssh-completion-${++nextId}`
    let owner = null, snapshot = null, items = [], index = 0, box = null, frame = null, disposed = false, automatic = null, suppressNextInput = false
    let request = null, generation = 0, remoteStatus = '', remoteTimer = null
    const remote = createRemoteCompletion({ list: readDirectory, exec: readCommands, commandContext: engine.context })
    const sessionIdentity = session => session && `${session.tabId || session.id || ''}:${session.sessionId || ''}`
    const currentOwner = () => {
      const session = getSession()
      return session?.sessionId && session.term === owner?.term && sessionIdentity(session) === owner.key ? session : null
    }
    const removeAria = () => {
      const input = owner?.term?.el?.querySelector('textarea')
      if (input?.getAttribute('aria-controls') === id) {
        input.removeAttribute('aria-controls'); input.removeAttribute('aria-activedescendant'); input.removeAttribute('aria-expanded')
      }
    }
    function hide({ keepAutomatic = false } = {}) {
      generation++; request?.abort(); request = null; remoteStatus = ''
      clearTimeout(remoteTimer); remoteTimer = null
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      if (!keepAutomatic) automatic = null
      removeAria(); box?.remove(); box = null; owner = null; snapshot = null; items = []; index = 0
      document.getElementById('fab')?.classList.remove('completion-over')
      onStatus?.()
    }
    const activeTerminal = () => {
      const session = getSession()
      return session?.term?.el?.contains(document.activeElement) ? session : null
    }
    function position() {
      const session = currentOwner(), cursor = session?.term?.cursorRect?.()
      if (!box || !cursor) return hide()
      const bounds = session.term.el.getBoundingClientRect()
      if (cursor.top < bounds.top || cursor.top - cursor.cellHeight > bounds.bottom) return hide()
      const margin = 8, width = Math.min(640, Math.max(300, innerWidth * 0.56), innerWidth - margin * 2)
      const bottomRoom = innerHeight - cursor.top - margin, topRoom = cursor.top - cursor.cellHeight - margin
      const rowHeight = Math.max(29, (Number(getSources()?.fontSize) || 13) * 2.25)
      const desired = Math.min(items.length * rowHeight + (remoteStatus ? 80 : 54), 330)
      const above = bottomRoom < Math.min(desired, 110) && topRoom > bottomRoom
      box.style.setProperty('--ssh-completion-font', `${Number(getSources()?.fontSize) || 13}px`)
      box.style.width = `${width}px`
      box.style.maxHeight = `${Math.max(40, Math.min(desired, above ? topRoom : bottomRoom))}px`
      box.style.left = `${Math.max(margin, Math.min(cursor.left, innerWidth - width - margin))}px`
      box.style.top = `${Math.max(margin, above ? cursor.top - cursor.cellHeight - box.offsetHeight : cursor.top)}px`
      box.dataset.placement = above ? 'above' : 'below'
    }
    function select(next) {
      if (!items.length) return
      index = (next + items.length) % items.length
      box?.querySelectorAll('[role=option]').forEach((row, n) => row.setAttribute('aria-selected', String(n === index)))
      const row = box?.querySelector(`[data-index="${index}"]`)
      row?.scrollIntoView({ block: 'nearest' })
      owner?.term?.el?.querySelector('textarea')?.setAttribute('aria-activedescendant', `${id}-${index}`)
    }
    function render() {
      box?.remove()
      box = document.createElement('div'); box.className = 'ssh-command-suggestions'; box.id = id
      box.setAttribute('role', 'listbox'); box.setAttribute('aria-label', '命令与路径建议，Option 或 Alt 加上下箭头选择，加回车填入')
      const list = document.createElement('div'); list.className = 'ssh-command-rows'
      items.forEach((item, n) => {
        const row = document.createElement('div'); row.className = 'ssh-command-option'; row.dataset.index = String(n)
        row.id = `${id}-${n}`; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(n === index))
        if (item.source) row.dataset.source = item.source
        row.title = [item.label, item.arguments, item.detail].filter(Boolean).join(' · ')
        const kind = document.createElement('span'); kind.className = 'ssh-command-kind'; kind.textContent = labels[item.kind] || '命令'
        const name = document.createElement('span'); name.className = 'ssh-command-name'; name.textContent = item.label
        const args = document.createElement('span'); args.className = 'ssh-command-arguments'; args.textContent = item.arguments
        const detail = document.createElement('span'); detail.className = 'ssh-command-description'; detail.textContent = item.detail
        const danger = global.SshDict?.matchDanger?.(item.fullCommand, getSources()?.environment)
        if (danger) { row.classList.add('is-destructive'); row.title += ` · ${danger.reason}`; detail.textContent = danger.reason }
        row.append(kind, name, args, detail); list.append(row)
      })
      const help = document.createElement('div'); help.className = 'ssh-command-keys'
      const shortcuts = getSources()?.shortcuts
      const choose = document.createElement('span'); choose.textContent = shortcuts ? `${shortcuts.previous || '点击'} / ${shortcuts.next || '悬停'} 选择 · ${shortcuts.accept || '点击'} 填入` : /Mac/.test(navigator.platform) ? 'Option ↑↓ 选择 · Option Enter 填入' : 'Alt ↑↓ 选择 · Alt Enter 填入'
      const mode = document.createElement('span'); mode.textContent = 'Enter 执行当前命令 · ↑↓ 远端历史 · Esc 关闭'
      help.append(choose, mode)
      if (remoteStatus) { const status = document.createElement('span'); status.className = 'ssh-remote-status'; status.role = 'status'; status.textContent = remoteStatus; help.prepend(status) }
      box.append(list, help); document.body.append(box)
      box.addEventListener('pointerdown', event => { if (event.button === 0) event.preventDefault() })
      box.addEventListener('pointermove', event => {
        const row = event.target.closest('[data-index]'); if (row && Number(row.dataset.index) !== index) select(Number(row.dataset.index))
      })
      box.addEventListener('click', event => { const row = event.target.closest('[data-index]'); if (row) void accept(Number(row.dataset.index)) })
      const input = owner?.term?.el?.querySelector('textarea')
      input?.setAttribute('aria-controls', id); input?.setAttribute('aria-expanded', 'true')
      document.getElementById('fab')?.classList.add('completion-over')
      position(); select(index); onStatus?.()
    }
    function run(force = false) {
      if (disposed) return
      const session = getSession()
      if (force) {
        session?.term?.focus?.()
        session?.term?.revealCommand?.()
      }
      const current = session?.term?.readCommand?.(), sources = getSources() || {}
      hide()
      if (!session?.sessionId || !current || current.cursor !== current.text.length || !force && !activeTerminal()) return
      const prefs = engine.preferences(sources.preferences)
      if (!prefs.enabled || !force && (!prefs.autoSuggest || current.text.trim().length < prefs.minChars)) return
      const candidates = engine.suggest(current.text, { ...sources, force })
      // Known subcommands and enum values own their slot; filesystem names add noise.
      const plan = candidates.some(item => item.kind === 'value' || item.kind === 'subcommand') ? null : remote.plan(current, prefs)
      if (!candidates.length && !plan) return
      owner = { term: session.term, key: sessionIdentity(session) }; snapshot = current; items = candidates
      remoteStatus = plan ? `正在读取${plan.kind === 'paths' ? '远端目录' : '远端 PATH'}…` : ''
      render()
      if (!plan) return
      const ticket = generation, captured = engine.snapshotKey(current), controller = new AbortController()
      request = controller
      const currentRequest = () => !disposed && !controller.signal.aborted && ticket === generation && currentOwner() && engine.snapshotKey(session.term.readCommand?.()) === captured
      remoteTimer = setTimeout(() => {
        remoteTimer = null
        // Check again at dispatch, including changes during the debounce with no UI event yet.
        if (!currentRequest()) { if (ticket === generation) hide(); return }
        void remote.load(session.sessionId, current, prefs, { signal: controller.signal }).then(result => {
          if (!currentRequest()) { if (ticket === generation) hide(); return }
          const selected = items[index]?.fullCommand
          items = mergeSuggestions(candidates, result.items, prefs.maxItems)
          index = Math.max(0, items.findIndex(item => item.fullCommand === selected))
          remoteStatus = result.status || (!items.length ? '当前前缀没有匹配的远端候选' : '')
          render()
        }).catch(error => { if (error.name !== 'AbortError' && currentRequest()) { remoteStatus = '远端读取暂不可用'; render() } })
      }, force ? 0 : 120)
    }
    async function accept(selected) {
      const session = currentOwner(), item = items[selected]
      const suffix = session && engine.suffixFor(item, snapshot, session.term.readCommand?.())
      hide()
      if (!suffix) return
      // Quotes close safely; the next directory suffix can concatenate outside that quote.
      // Request children only after the complete appended suffix has echoed back.
      if (item.directory) automatic = { term: session.term, key: sessionIdentity(session), force: true, expectedText: item.fullCommand }
      // Capture the session before dispatch; a later active-tab change cannot redirect this write.
      session.term.noteInput?.(suffix)
      try { await send(session, suffix); if (getSession()?.term === session.term) session.term.focus?.() }
      catch (error) { onError?.(error) }
    }
    function input(data, session) {
      hide()
      if (!session?.sessionId) return
      // Only a fresh echoed edit can reopen automatically. Paste, navigation and terminal control stay quiet.
      const eligible = [...data].length === 1 && (data === '\x7f' || !/[\x00-\x1f\x7f-\x9f]/.test(data))
      if (eligible && !suppressNextInput && engine.preferences(getSources()?.preferences).autoSuggest) automatic = { term: session.term, key: sessionIdentity(session) }
      suppressNextInput = false
    }
    function terminalState(session, event) {
      if (disposed || getSession()?.term !== session?.term) return
      if (event.reason === 'paste') suppressNextInput = true
      if (event.reason === 'output-pending' || event.reason === 'input') return hide({ keepAutomatic: true })
      if (event.reason !== 'output') return hide()
      if (items.length) hide({ keepAutomatic: true })
      const current = session.term.readCommand?.()
      if (!automatic || automatic.term !== session.term || automatic.key !== sessionIdentity(session) || !current) return
      if (automatic.expectedText && automatic.expectedText !== current.text) return hide()
      if (frame !== null) cancelAnimationFrame(frame)
      const force = !!automatic.force
      frame = requestAnimationFrame(() => { frame = null; run(force) })
    }
    function keydown(event, session) {
      if (event.type !== 'keydown' || event.isComposing || event.keyCode === 229 || !session || getSession()?.term !== session.term) return true
      // Keep the list while a configurable chord is being pressed; the registry owns its final key.
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return true
      if (event.key === 'Escape') {
        const dismissingList = !!box
        hide()
        // Dismissing a visible/loading list is local. Forwarding ESC would leave the
        // shell in an unknown input state and prevent an explicit reopen at this prompt.
        if (dismissingList) { event.preventDefault(); return false }
        return true
      }
      if (!getSources()?.hasCommandRegistry && items.length && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        // An existing list owns its explicit keys even while a session-change notification is queued.
        // A stale accept closes silently; it must never become a remote Alt+Enter submission.
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { if (currentOwner()) select(index + (event.key === 'ArrowUp' ? -1 : 1)); else hide(); event.preventDefault(); return false }
        if (event.key === 'Enter') { event.preventDefault(); void accept(index); return false }
      }
      if (['Tab', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.ctrlKey || event.metaKey) hide()
      return true
    }
    const onPointer = event => { if (!box?.contains(event.target)) hide() }
    const onFocus = event => { if (!owner?.term?.el?.contains(event.target) && !box?.contains(event.target)) hide() }
    const onChange = () => hide()
    const onContextChange = () => { hide(); remote.invalidate() }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('focusin', onFocus)
    window.addEventListener('resize', onChange)
    window.addEventListener('blur', onChange)
    window.addEventListener('ssh-workspace-change', onContextChange)
    window.addEventListener('ssh-completion-settings-change', onContextChange)
    return { run, hide, input, terminalState, keydown, isOpen: () => items.length > 0, move: delta => { if (currentOwner()) select(index + delta); else hide() }, accept: () => accept(index), dispose() {
      disposed = true; hide(); remote.dispose(); document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('focusin', onFocus)
      for (const event of ['resize', 'blur']) window.removeEventListener(event, onChange)
      for (const event of ['ssh-workspace-change', 'ssh-completion-settings-change']) window.removeEventListener(event, onContextChange)
    } }
  }
  global.SshCompletion = { create }
})(window)
