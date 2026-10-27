/** Isolated visual fixtures: no real files, credentials, network, clipboard or OS processes. */
export function installPreviewFixture({ pluginId, mode = 'shell' }) {
  const events = new Map(), values = new Map(), now = 1791856800000
  window.__appearanceSnapshot ||= {
    version: 2,
    revision: 1,
    theme: { source: 'enest.builtin', id: 'tech', name: '刻度', version: 1, legacy: false },
    requestedMode: 'light',
    mode: 'light',
    tokens: {},
    fonts: { body: 'Avenir Next, PingFang SC, sans-serif', heading: 'Songti SC, serif', mono: 'Menlo, monospace', scale: 1 },
    components: { controlRadius: 6, cardRadius: 8, panelRadius: 7, borderWidth: 1 },
    background: { media: null, effect: 'structure', texture: 'grid', intensity: .5, speed: 1, direction: 0 },
    layout: { variant: 'tech', density: 1, gap: 10, sidebarWidth: 220, contentWidth: 1200, columns: 4 },
    animation: { requested: 'medium', effective: 'medium', continuous: true },
    home: { source: 'enest.builtin', id: 'home', variant: 'tech' },
    diagnostics: []
  }
  const listener = (name, callback) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); return () => events.get(name)?.delete(callback) }
  const seed = {
    'db.connections': [{ id: 'demo-postgres', name: '产品分析 · 演示', driver: 'postgres', host: 'analytics.example.test', port: 5432, database: 'workspace', username: 'readonly', readOnly: true, env: 'dev', favorite: true }],
    'rdp.profiles': [{ id: 'demo-design', name: '设计工作站 · 演示', host: 'studio.example.test', port: 3389, protocol: 'rdp', username: 'designer', tags: ['设计'], tunnel: { enabled: false }, viewOnly: true }],
    'rdp.groups': [], 'rdp.recent': [],
    'ssh.profiles': [{ id: 'demo-ssh', name: '开发服务器 · 演示', host: 'dev.example.test', port: 22, username: 'developer', auth: 'password', tags: ['开发'], groupId: '' }],
    'todos_v2': { version: 2, lists: ['收件箱', '本周发布'], tasks: [
      { id: 'demo-task-1', text: '检查插件小窗布局与键盘操作', list: '本周发布', priority: 'high', pinned: true, tags: ['体验'], note: '覆盖 480 × 320 与 720 × 420 两种尺寸。', subtasks: [{ text: '检查内容溢出', done: true }, { text: '确认快捷键提示', done: false }] },
      { id: 'demo-task-2', text: '整理 API 示例与权限说明', list: '本周发布', tags: ['文档'] },
      { id: 'demo-task-3', text: '为工具补充界面截图', list: '收件箱', tags: ['设计'] }
    ] },
    'notes_v2': { version: 2, notes: [
      { id: 'demo-note-1', title: '把常用工具放回工作流', text: '# 本周的三个重点\n\n让插件启动更快，让小窗操作更顺手，让每一次授权都清楚。\n\n- 检查布局与键盘体验\n- 补充文档中的完整示例\n- 为每个插件拍一张真实截图\n\n> 少一点切换，多一点专注。', color: '#7fa894', pinned: true, tags: ['工作', '灵感'], updatedAt: now },
      { id: 'demo-note-2', title: '发布前检查', text: '构建 · 校验 · 归档 · 核对资源', color: '#cfa467', tags: ['清单'], updatedAt: now - 1000 }
    ] },
    'totp_v1': { entries: [{ id: 'demo-totp', issuer: 'eNest Demo', account: 'demo@example.test', secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' }] }
  }
  if (pluginId === 'drawboard') {
    seed['drawboard.data.v1'] = null  // 画板截图场景由 market-scenarios 的 __drawboardDemo 现画
  }
  for (const [key, value] of Object.entries(seed)) values.set(key, value)
  const handlers = {
    getLaunchMode: () => mode, getLaunchContext: () => ({ mode, code: 'main', payload: null }),
    'storage.get': async key => values.get(key) ?? null,
    'storage.set': async (key, value) => { values.set(key, value); return true },
    'storage.remove': async key => values.delete(key),
    'storage.keys': async () => [...values.keys()],
    'storage.blobs.put': async ({ dataUrl, name }) => {
      const id = 'preview-blob-' + values.size, bytes = Math.floor(dataUrl.length * .75)
      values.set('blob:' + id, { dataUrl, name, bytes })
      return { id, bytes }
    },
    'storage.blobs.get': async id => values.get('blob:' + id) ?? null,
    'storage.blobs.remove': async id => values.delete('blob:' + id),
    'settings.get': async () => null,
    'theme.getAppearance': async () => structuredClone(window.__appearanceSnapshot),
    'theme.onAppearanceChange': callback => {
      window.__appearanceListeners ||= new Set()
      window.__appearanceListeners.add(callback)
      return () => window.__appearanceListeners.delete(callback)
    },
    'clipboard.readText': async () => 'eNest，让常用工具回到工作流里。',
    'clipboard.readImage': async () => null,
    'clipboard.history.list': async () => [{ id: 'clip-demo', type: 'text', text: '让常用工具回到工作流里。', content: '让常用工具回到工作流里。', createdAt: now, timestamp: now, pinned: true }],
    'clipboard.history.query': async () => ({ items: [{ id: 'clip-demo', type: 'text', text: '让常用工具回到工作流里。', preview: '让常用工具回到工作流里。', ts: now, bytes: 42, pinned: true, sourceApp: { name: 'eNest · 演示' } }], total: 1, nextCursor: null }),
    'clipboard.capabilities': async () => ({ paste: true, permissionRequired: false }),
    'clipboard.history.get': async () => null,
    'agent.apps': async () => [{ id: 'claude', name: 'Claude Code', installed: false }, { id: 'codex', name: 'Codex', installed: false }],
    'agent.read': async () => ({ exists: false, data: {}, config: {} }),
    'agent.backups': async () => [], 'agent.sessions.list': async () => [],
    'sys.processes': async () => [{ pid: 4201, name: 'eNest', command: 'eNest', user: 'demo', pcpu: 1.8, rss: 145600 }, { pid: 4210, name: 'Vite', command: 'vite', user: 'demo', pcpu: .6, rss: 68400 }],
    'sys.ports': async () => [{ pid: 4210, name: 'Vite', port: 5173, address: '127.0.0.1', protocol: 'TCP', state: 'LISTEN' }],
    'localFiles.pick': async () => ['batch-rename', 'lan-share'].includes(pluginId) ? [
      { id: 'demo-file-1', name: '项目说明.pdf', kind: 'file', size: 142600, displayPath: '演示文件' },
      { id: 'demo-file-2', name: '界面设计.png', kind: 'file', size: 286720, displayPath: '演示文件' }
    ] : ['image-tools', 'screen-assistant'].includes(pluginId) ? [{ id: 'demo-image', name: '海岸配色.png', kind: 'file', size: 32768, displayPath: '隔离演示图片' }] : [],
    'localFiles.read': async ({ handleId }) => {
      if (handleId !== 'demo-image') throw new Error('Unknown demonstration file handle')
      const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 650
      const context = canvas.getContext('2d'), sky = context.createLinearGradient(0, 0, 0, 650)
      sky.addColorStop(0, '#cfddd8'); sky.addColorStop(1, '#f6e9cd'); context.fillStyle = sky; context.fillRect(0, 0, 1000, 650)
      context.fillStyle = '#e5b46e'; context.beginPath(); context.arc(752, 158, 78, 0, Math.PI * 2); context.fill()
      for (const [color, y, bend] of [['#789c95', 320, 95], ['#416f70', 440, -70], ['#244c55', 560, 60]]) {
        context.fillStyle = color; context.beginPath(); context.moveTo(0, y); context.bezierCurveTo(240, y - bend, 620, y + bend, 1000, y - 60); context.lineTo(1000, 650); context.lineTo(0, 650); context.closePath(); context.fill()
      }
      context.fillStyle = '#fff7e9'; context.font = '600 22px sans-serif'; context.fillText('COASTAL STUDY / 01', 50, 592)
      return canvas.toDataURL('image/png')
    },
    'localFiles.fromDrop': async () => [],
    'ssh.listProfiles': async () => [], 'ssh.keys': async () => [],
    'db.dialects': async () => ['postgres', 'mysql', 'sqlite'],
    'db.listDrivers': async () => ['postgres', 'mysql', 'sqlite'],
    'vault.has': async () => false,
    'pin.list': async () => [], 'pin.getAll': async () => [],
    'focusTimer.get': async () => ({ state: { status: 'idle', phase: 'focus', cycle: 1, remainingMs: 1500000, options: { task: '', focusMin: 25, breakMin: 5, longBreakMin: 15 } }, records: [] }),
    'timers.list': async () => [], 'timer.list': async () => [],
    'dsh.workbench': async ({ action }) => {
      if (action === 'runtime.detect') return { available: true, version: '0.2.0-rc.2', dshHome: '(演示数据)' }
      if (action === 'runtime.status') return { sdk: { running: true }, web: { running: false } }
      if (action === 'sessions.list') return [{ sessionId: 'demo-session', title: '梳理下一版工作计划', updatedAt: now }]
      if (action === 'sessions.read') return { events: [{ type: 'user/message', message: '帮我整理今天的开发任务。', timestamp: now }, { type: 'assistant/message', message: '先完成插件构建与验证，再检查小窗布局和发布资源。', timestamp: now + 1000 }] }
      if (action.includes('list')) return []
      return {}
    },
    'net.fetch': async () => ({ status: 200, ok: true, data: {}, body: '{}' }),
    'backend.call': async (method, args = []) => {
      if (method === 'providers') return {
        platform: 'darwin',
        providers: [
          { id: 'spotlight', label: 'Spotlight (mdfind)', available: true, detail: 'macOS 系统索引，即时搜索（演示数据）' },
          { id: 'everything', label: 'Everything HTTP', available: false, detail: '未配置 Everything HTTP 端口' }
        ],
        active: 'spotlight'
      }
      if (method === 'search') {
        const dir = '/Users/demo/Studio/enest'
        const mk = (name, ext, isDirectory, size, minutesAgo) => ({ path: `${dir}/${name}`, name, dir, ext, isDirectory, size, mtimeMs: now - minutesAgo * 60000 })
        const pool = [
          mk('icons', '', true, 0, 51),
          mk('release-notes-draft.md', 'md', false, 4218, 12),
          mk('Node 22 升级记录.md', 'md', false, 12980, 134),
          mk('enest-plugin-market.png', 'png', false, 1243904, 420),
          mk('季度目标 review.key', 'key', false, 8375509, 1580),
          mk('analytics-2026Q3.xlsx', 'xlsx', false, 346112, 2760),
          mk('registry-backup-10-08.json', 'json', false, 88410, 4300),
          mk('wireframes-v3.sketch', 'sketch', false, 15982592, 65),
          mk('deploy.sh', 'sh', false, 940, 9000)
        ]
        const terms = String(args[0] ?? '').toLowerCase().split(/\s+/).filter(Boolean).map(term => term.replace(/[*"]/g, '')).filter(Boolean)
        const hits = terms.length ? pool.filter(file => terms.every(term => file.name.toLowerCase().includes(term))) : []
        return { results: hits, provider: 'spotlight', total: hits.length, collected: hits.length, truncated: false, elapsedMs: 38 }
      }
      if (method === 'readText') return {
        content: '# Node 22 升级记录\n\n- rolldown 需要 styleText，Node 18 已不够用\n- 切到 node@22 后 vite 8 与 esbuild 均正常\n- CI 三个平台都要固定到 22.x\n\n> 下一步：把 postinstall 指向 ignored 脚本的问题一并收掉。',
        encoding: 'utf-8', truncated: false, size: 12980
      }
      if (method === 'open' || method === 'reveal' || method === 'trash' || method === 'stat') return true
      return true
    }
  }
  function api(path = '') {
    return new Proxy(function (...args) {
      if (handlers[path]) return handlers[path](...args)
      const last = path.split('.').at(-1)
      if (/^on[A-Z]/.test(last)) return listener(path, args[0])
      if (path === 'on') return listener(args[0], args[1])
      if (last === 'acquire' || last === 'begin') return Promise.resolve({ token: 'demo', release() {} })
      if (last === 'list' || last === 'getAll') return Promise.resolve([])
      return Promise.resolve(true)
    }, { get(_, key) { if (key === 'then') return undefined; return api(path ? path + '.' + key : key) } })
  }
  window.enest = api()
  window.__preview = {
    mode(value) { mode = value; for (const callback of events.get('onModeChange') ?? []) callback(mode) },
    enter() { for (const callback of events.get('onEnter') ?? []) callback({ mode, code: 'main', payload: null }) }
  }
}
