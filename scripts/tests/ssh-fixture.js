import { expect } from '@playwright/test'

/** Real vendored xterm; only the remote transport/storage are deterministic fixtures. */
export async function sshFixture(page, mode = 'shell') {
  await page.addInitScript(({ mode }) => {
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
    const saved = sessionStorage.getItem('ssh-fixture-storage')
    const data = saved ? JSON.parse(saved) : {
      'ssh.profiles': [
        { id: 'dev', name: '应用服务 · 开发', host: 'dev.example.test', port: 22, username: 'developer', authType: 'agent', env: 'dev', favorite: true },
        { id: 'ops', name: '日志服务', host: 'ops.example.test', port: 22, username: 'operator', authType: 'agent', env: 'staging' }
      ],
      'ssh.groups': [], 'ssh.history': [],
      'ssh.snippets': [{ id: 'logs', title: '跟踪应用日志', command: 'tail -f /var/log/app.log', tags: ['日志'] }],
      'ssh.ui': { recordHistory: true, selectCopy: false, fontSize: 13 }
    }
    const listeners = new Map(), sessions = new Map(), beforeClose = []
    let sequence = 0, currentMode = mode
    window.__data = data; window.__calls = []; window.__toasts = []; window.__sshEcho = true
    window.__emit = (name, value) => { for (const callback of listeners.get(name) || []) callback(value) }
    window.__sshData = (sessionId, value) => window.__emit('ssh.data', { sessionId, data: value })
    const activeId = () => window.SshWorkbenchBridge?.activeSession()?.sessionId
    window.__sshPrompt = (text = '', sessionId = activeId(), integrated = true) => {
      const state = sessions.get(sessionId)
      if (!state) throw new Error('Missing SSH fixture session')
      state.text = text; state.cursor = text.length
      window.__sshData(sessionId, '\r\n' + (integrated ? '\x1b]133;A\x07' : '') + 'fixture$ ' + (integrated ? '\x1b]133;B\x07' : '') + text)
    }
    const redraw = (id, state) => window.__sshData(id, '\r\x1b[2Kfixture$ ' + state.text + (state.cursor < state.text.length ? `\x1b[${state.text.length - state.cursor}D` : ''))
    const write = async (id, value) => {
      window.__calls.push(['write', { sessionId: id, data: value }])
      const state = sessions.get(id)
      if (!state) throw new Error('Session disconnected')
      if (!window.__sshEcho) return
      const units = String(value).match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/gu) || []
      for (const unit of units) {
        if (unit === '\r' || unit === '\n') {
          window.__calls.push(['executed', { sessionId: id, command: state.text }])
          window.__sshData(id, '\x1b]133;C\x07\r\n')
          window.__sshPrompt('', id); continue
        }
        if (unit === '\x03') { window.__sshData(id, '^C\x1b]133;C\x07'); window.__sshPrompt('', id); continue }
        if (unit === '\t' || unit === '\x1b') continue
        if (unit === '\x1b[A' || unit === '\x1b[B') { state.text = unit.endsWith('A') ? 'echo remote-history' : ''; state.cursor = state.text.length; redraw(id, state); continue }
        if (unit === '\x1b[D') state.cursor = Math.max(0, state.cursor - 1)
        else if (unit === '\x1b[C') state.cursor = Math.min(state.text.length, state.cursor + 1)
        else if (unit === '\x01') state.cursor = 0
        else if (unit === '\x05') state.cursor = state.text.length
        else if (unit === '\x0b') state.text = state.text.slice(0, state.cursor)
        else if (unit === '\x15') { state.text = state.text.slice(state.cursor); state.cursor = 0 }
        else if (unit === '\x7f' || unit === '\b') { if (state.cursor) { state.text = state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor); state.cursor-- } }
        else if (!/[\x00-\x1f]/.test(unit)) { state.text = state.text.slice(0, state.cursor) + unit + state.text.slice(state.cursor); state.cursor += unit.length }
        redraw(id, state)
      }
      return true
    }
    const snapshot = { platform: 'linux', cpuPercent: 12.3, memPercent: 34.6, memUsed: 3715145728, memTotal: 10737418240, disks: [{ mount: '/', usedPercent: 42.8, used: 45956150067, total: 107374182400 }], net: [{ name: 'eth0', rxKbps: 12.4, txKbps: 8.6 }] }
    const entries = [
      { name: 'app', type: 'dir', size: 4096, mode: 493, mtime: 1791960000 },
      { name: 'application-production-with-long-name.conf', type: 'file', size: 18352, mode: 420, mtime: 1791960000 },
      { name: 'README.md', type: 'file', size: 2048, mode: 420, mtime: 1791960000 }
    ]
    window.__mode = value => { currentMode = value; window.__onMode?.(value) }
    window.enest = {
      getLaunchMode: () => currentMode, onModeChange: callback => { window.__onMode = callback },
      onEnter: callback => { window.__enter = callback }, onBeforeClose: callback => { beforeClose.push(callback); window.__beforeClose = () => Promise.all(beforeClose.map(fn => fn())) }, onDestroy: () => () => {},
      on: (name, callback) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback) },
      off: (name, callback) => listeners.get(name)?.delete(callback),
      storage: { get: async key => clone(data[key]), set: async (key, value) => { if (window.__storageFail) throw new Error('存储失败'); data[key] = clone(value); sessionStorage.setItem('ssh-fixture-storage', JSON.stringify(data)); return true }, remove: async key => { delete data[key] } },
      settings: { register: async () => true, get: async () => true, set: async () => true },
      theme: { getTokens: async () => ({ mode: 'light', tokens: {} }) },
      ui: { toast: async value => window.__toasts.push(value), setTitle: async () => {}, onThemeChange: callback => { window.__theme = callback }, setInputContext: async value => { window.__inputContext = value }, resize: async () => {}, openInShell: async () => { window.__mode('shell'); return true } },
      clipboard: { writeText: async value => { window.__copied = value; return true } },
      vault: { set: async () => ({ secretRef: 'fixture-secret' }), has: async () => true, remove: async () => true },
      localFiles: { pick: async options => { window.__calls.push(['localFiles.pick', options]); return [] }, list: async () => [] },
      shell: { saveTextFile: async input => { window.__calls.push(['saveTextFile', input]); return { ok: true } } },
      notify: async () => true,
      ssh: {
        connect: async payload => { const sessionId = `ssh-fixture-${++sequence}`; window.__calls.push(['connect', payload]); sessions.set(sessionId, { text: '', cursor: 0 }); return { sessionId } },
        write, resize: async (sessionId, cols, rows) => { window.__calls.push(['resize', { sessionId, cols, rows }]); return true },
        disconnect: async id => { window.__calls.push(['disconnect', id]); sessions.delete(id); return true }, listSessions: async () => [...sessions.keys()].map(sessionId => ({ sessionId })),
        exec: async input => { window.__calls.push(['exec', input]); return { exitCode: 0, stdout: '', stderr: '' } },
        completion: { suggest: async input => { window.__calls.push(['completion.suggest', input]); return { items: [] } } },
        metrics: { start: async () => true, stop: async () => true },
        sftp: { list: async input => { window.__calls.push(['sftp.list', input]); if (window.__deferSftp) await new Promise(resolve => { window.__releaseSftp = resolve }); return clone(entries) }, mkdir: async () => true, rename: async () => true, delete: async () => true, chmod: async () => true },
        workbench: async input => {
          window.__calls.push(['workbench', input])
          if (window.__deferTools && input.action.startsWith('system.')) await new Promise(resolve => { (window.__pendingTools ||= []).push(resolve) })
          if (input.action === 'system.snapshot') return clone(snapshot)
          if (input.action === 'system.processes') return [{ pid: 2241, name: 'application-worker-with-a-long-service-name', user: 'developer', cpuPercent: 12.4, memoryBytes: 20447232, startTime: 'fixture-start' }]
          if (input.action === 'system.ports') return [{ protocol: 'TCP', address: '127.0.0.1', port: 8080, pid: 2241, process: 'application-worker' }]
          if (input.action === 'system.services') return [{ name: 'app.service', state: 'running', enabled: true }]
          if (input.action === 'system.docker') return []
          if (input.action === 'files.read') return { content: 'server {\n  listen 8080;\n}\n', size: 30, mtime: 1791960000, encoding: 'utf-8' }
          if (input.action === 'files.stat') return { type: 'file', size: 30, mode: 420, mtime: 1791960000 }
          if (input.action === 'files.write') return { ok: true }
          if (input.action === 'shell.integrate') { window.__sshPrompt('', input.sessionId); return { ok: true } }
          return []
        }
      }
    }
  }, { mode })
  await page.goto('/plugins/ssh/index.html')
  await expect(page.locator('#app')).toHaveAttribute('data-workbench', 'ready')
}

/** A parsed prompt is not proof that xterm has measured its cells or fitted the visible pane. */
export async function fitSshTerminal(page) {
  await page.evaluate(() => document.fonts.ready)
  await expect.poll(() => page.evaluate(async () => {
    const terminal = window.SshWorkbenchBridge.activeSession().term
    terminal.fit()
    const measured = () => {
      const screen = terminal.el.querySelector('.xterm-screen').getBoundingClientRect()
      const bounds = terminal.el.getBoundingClientRect(), size = terminal.getSize()
      return { width: screen.width, height: screen.height, hostWidth: bounds.width, hostHeight: bounds.height, ...size }
    }
    const before = measured()
    await new Promise(resolve => requestAnimationFrame(resolve))
    const after = measured(), cellWidth = after.width / after.cols, cellHeight = after.height / after.rows
    return JSON.stringify(before) === JSON.stringify(after) && cellWidth > 0 && cellHeight > 0
      && after.hostWidth - after.width >= -1 && after.hostWidth - after.width < cellWidth + 17
      && after.hostHeight - after.height >= -1 && after.hostHeight - after.height < cellHeight + 1
  })).toBe(true)
}

export async function connectSsh(page, profileId = 'dev') {
  await page.evaluate(async id => {
    const bridge = window.SshWorkbenchBridge
    await bridge.connectProfile(bridge.store.findProfile(id))
  }, profileId)
  await fitSshTerminal(page)
  await page.evaluate(() => {
    window.__sshData(window.SshWorkbenchBridge.activeSession().sessionId, '\x1b]7;file://fixture/home/developer\x07')
    window.__sshPrompt()
  })
  await expect.poll(() => page.evaluate(() => window.SshWorkbenchBridge.activeSession()?.term?.readCommand?.()?.text)).toBe('')
  return page.evaluate(() => window.SshWorkbenchBridge.activeSession().sessionId)
}

export async function setCommand(page, text, integrated = true) {
  await page.evaluate(({ text, integrated }) => { window.__sshPrompt(text, undefined, integrated); window.SshWorkbenchBridge.activeSession().term.focus() }, { text, integrated })
  if (integrated) await expect.poll(() => page.evaluate(() => window.SshWorkbenchBridge.activeSession().term.readCommand()?.text)).toBe(text)
}

export const fixture = sshFixture
export const connect = connectSsh
