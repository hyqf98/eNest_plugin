/**
 * 游戏盒子的页面预览夹具：在普通浏览器里伪造 window.enest，无需 eNest 宿主。
 * 用途：浏览器里看界面、用假数据点通整条流程（建任务 → 下载 → 解压 → 完成 → 启动）。
 * 不进入构建产物；只在预览与界面测试时注入。
 *
 * 假数据按 src/shared/contracts.ts 的方法名与事件名实现；任务会随时间真实推进，
 * 所以下载中 / 解压中 / 完成 / 登录过期等状态都能在界面上看到。
 */

interface TaskSeed {
  id: string
  itemId: string
  title: string
  files: number
  totalBytes: number
  state: string
  progress: number
  error?: string
  installError?: string
  ageMinutes: number
}

interface FixtureOptions {
  /** 预置任务；默认给一组覆盖各种状态的样例 */
  tasks?: TaskSeed[]
  auth?: 'logged-in' | 'logged-out' | 'expired'
  /** 下载推进速度倍率；越大越快 */
  speed?: number
}

interface Running {
  id: string
  phase: 'downloading' | 'installing'
  progress: number
  speed: number
}

export function installGameBoxFixture(options: FixtureOptions = {}) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const values = new Map<string, unknown>()
  const running = new Map<string, Running>()
  const speedScale = options.speed ?? 1
  // 前端统一从 'backend.event' 接收 { event, data }（与真实宿主一致），所以每个事件都要同时分发到它
  const emit = (event: string, data: unknown) => {
    const payload = { event, data }
    for (const cb of listeners.get(event) ?? []) cb(payload)
    for (const cb of listeners.get('backend.event') ?? []) cb(payload)
  }
  const on = (name: string, cb: (payload: unknown) => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(cb); return () => listeners.get(name)?.delete(cb) }

  // ---- 假封面：用 canvas 画确定性的渐变图，避免依赖外网 ----
  const covers = new Map<string, string>()
  function cover(seed: string, wide = false): string {
    const key = `${seed}:${wide ? 1 : 0}`
    if (covers.has(key)) return covers.get(key)!
    const canvas = document.createElement('canvas')
    canvas.width = wide ? 960 : 480
    canvas.height = wide ? 540 : 640
    const ctx = canvas.getContext('2d')!
    let h = 0
    for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    const hue = h % 360
    const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height)
    g.addColorStop(0, `hsl(${hue} 42% 30%)`); g.addColorStop(1, `hsl(${(hue + 60) % 360} 48% 16%)`)
    ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = 'rgba(255,255,255,.10)'
    for (let i = 0; i < 7; i++) { ctx.beginPath(); ctx.arc((h >> (i * 3)) % canvas.width, (h >> (i * 4)) % canvas.height, 40 + i * 18, 0, Math.PI * 2); ctx.fill() }
    const url = canvas.toDataURL('image/jpeg', 0.82)
    covers.set(key, url)
    return url
  }
  const seedOf = (token: string) => token.split(':').slice(1, 3).join('') || token

  // ---- 假条目库 ----
  const GAMES = [
    '极限竞速：地平线6 尊享版', '侠盗猎车手5：增强版', '生化危机9：安魂曲', '剑星：完整版', '塞尔达传说 时之笛 重制版',
    '艾尔登法环 黄金树幽影', '赛博朋克2077 终极版', '博德之门3', '黑神话：悟空', '艾尔登法环',
    '荒野大镖客2', '巫师3 次世代版', '只狼：影逝二度', '空洞骑士：丝之歌', '星际拓荒',
    '哈迪斯2', '泰拉瑞亚', '星露谷物语', '双人成行', '它是我的战争',
  ]
  const CATS = ['动作冒险', '角色扮演', '射击', '竞速', '策略', '独立']
  const SOFT = ['Visual Enhancer', 'OBS Studio', 'Everything', '7-Zip', 'Notepad++', 'PotPlayer', 'Bandizip', 'Snipaste', 'TrafficMonitor', 'AutoHotkey']
  const TRAINERS = ['60秒差距 v1.2.1 四项修改器', 'D4：暗梦不灭 v1.0-1.1 四项修改器', '黑神话：悟空 v1.0.13 十九项修改器', '艾尔登法环 黄金树幽影 v1.12 二十五项修改器', '赛博朋克2077 v2.2 十项修改器']
  const MODS = ['艾尔登法环 无缝联机', '巫师3 高清材质包', '天际 AE 界面美化', '博德之门3 额外外观', '赛博朋克2077 车辆扩展']

  interface Item { id: string; kind: string; section: string; source: string; sourceId: string; title: string; subtitle: string; cover: string; coverToken: string; category: string; sizeText: string; meta: string[]; favorite: boolean; installed: boolean }
  const items: Item[] = []
  const push = (title: string, kind: string, section: string, index: number) => items.push({
    id: `${section}:${index}`, kind, section, source: section === 'trainer' ? 'fucnm' : section === 'mod' ? '3dm' : 'ode', sourceId: String(1000 + index),
    title, subtitle: kind === 'game' ? '中文 · 免安装 · 学习版' : '', cover: '', coverToken: `cover:${section}${index}`,
    category: CATS[index % CATS.length], sizeText: `${(18 + (index * 37) % 130)}.${(index * 7) % 100} GB`,
    meta: kind === 'trainer' ? [`v1.${index}.0`, `支持 v1.0.${index}`, `${(index * 13) % 40 + 2} 项`] : [],
    favorite: index % 4 === 0, installed: index % 5 === 1,
  })
  GAMES.forEach((t, i) => push(t, 'game', 'pc', i))
  GAMES.slice(0, 6).forEach((t, i) => push(t, 'game', 'console', i))
  SOFT.forEach((t, i) => push(t, 'software', 'software', i))
  TRAINERS.forEach((t, i) => push(t, 'trainer', 'trainer', i))
  MODS.forEach((t, i) => push(t, 'mod', 'mod', i))

  const sectionOf = (id: string) => id.split(':')[0]
  const facets = (section: string) => ({
    categories: [{ id: '', label: '全部' }, ...CATS.map((c, i) => ({ id: String(i + 1), label: c }))],
    sorts: [{ id: '', label: '最新' }, { id: 'day', label: '日排行' }, { id: 'week', label: '周排行' }, { id: 'month', label: '月排行' }, { id: 'total', label: '总排行' }],
    // 与后端一致：数据源1 没有需要特别说明的；数据源2 的站点目前限制程序访问
    sources: [{ id: 'ode', label: '数据源1', hint: '', available: true }, { id: 'gamer520', label: '数据源2', hint: '这个数据源的站点目前限制程序访问，可能加载失败；加载不出来请切回数据源1', available: true }],
  })

  // ---- 任务 ----
  const seeds: TaskSeed[] = options.tasks ?? [
    { id: 't_dl1', itemId: 'pc:0', title: GAMES[0], files: 19, totalBytes: 156_500_000_000, state: 'downloading', progress: 0.37, ageMinutes: 12 },
    { id: 't_dl2', itemId: 'pc:3', title: GAMES[3], files: 1, totalBytes: 63_400_000_000, state: 'downloading', progress: 0.02, ageMinutes: 2 },
    { id: 't_in', itemId: 'pc:6', title: GAMES[6], files: 3, totalBytes: 98_000_000_000, state: 'installing', progress: 1, ageMinutes: 40 },
    { id: 't_pa', itemId: 'pc:7', title: GAMES[7], files: 5, totalBytes: 121_000_000_000, state: 'paused', progress: 0.71, ageMinutes: 90 },
    { id: 't_if', itemId: 'pc:8', title: GAMES[8], files: 2, totalBytes: 84_000_000_000, state: 'install_failed', progress: 1, installError: '解压失败（7z exit=2）: Cannot open as archive', ageMinutes: 200 },
    { id: 't_fl', itemId: 'pc:9', title: GAMES[9], files: 1, totalBytes: 45_000_000_000, state: 'failed', progress: 0.18, error: '获取天翼云下载链接失败，请检查登录状态后重试', ageMinutes: 30 },
    { id: 't_ok', itemId: 'pc:1', title: GAMES[1], files: 4, totalBytes: 77_000_000_000, state: 'complete', progress: 1, ageMinutes: 1440 },
    { id: 't_ok2', itemId: 'software:1', title: SOFT[1], files: 1, totalBytes: 180_000_000, state: 'complete', progress: 1, ageMinutes: 2880 },
  ]
  const tasks = new Map<string, Record<string, unknown>>()
  const now = Date.now()
  for (const s of seeds) {
    const perFile = Math.floor(s.totalBytes / s.files)
    tasks.set(s.id, {
      id: s.id, itemId: s.itemId, title: s.title, coverToken: `cover:${s.itemId}`, kind: s.itemId.startsWith('software') ? 'software' : 'game', state: s.state, statusText: '',
      files: Array.from({ length: s.files }, (_, i) => ({ name: `${s.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 30)}.z${String(i + 1).padStart(2, '0')}`, size: perFile, downloaded: perFile, state: 'done' })),
      totalBytes: s.totalBytes, completedBytes: Math.floor(s.totalBytes * s.progress), speed: 0, etaSeconds: 0, error: s.error ?? '', installError: s.installError ?? '',
      downloadDir: `D:\\Games\\${s.title.slice(0, 12)}`, installDir: `D:\\Games\\${s.title.slice(0, 12)}`, autoInstall: true, removePackage: true, stalled: false,
      createdAt: now - s.ageMinutes * 60_000, finishedAt: s.state === 'complete' ? now - s.ageMinutes * 60_000 + 600_000 : 0,
    })
    if (s.state === 'downloading') running.set(s.id, { id: s.id, phase: 'downloading', progress: s.progress, speed: 22_000_000 * speedScale })
    if (s.state === 'installing') running.set(s.id, { id: s.id, phase: 'installing', progress: 0.2, speed: 0 })
  }

  function statusText(t: Record<string, unknown>): string {
    const files = t.files as Array<{ state: string }>
    const done = files.filter(f => f.state === 'done').length
    switch (t.state) {
      case 'queued': return '排队中'
      case 'resolving': return '正在解析资源'
      case 'downloading': return `正在下载 ${done}/${files.length}`
      case 'installing': return '正在解压安装'
      default: return ''
    }
  }

  const timer = setInterval(() => {
    for (const r of running.values()) {
      const t = tasks.get(r.id)!
      const total = t.totalBytes as number
      if (r.phase === 'downloading') {
        const next = Math.min(1, r.progress + (r.speed / total) * 0.5)
        r.progress = next
        t.completedBytes = Math.floor(total * next)
        t.speed = r.speed
        t.etaSeconds = r.speed > 0 ? Math.floor((total - (t.completedBytes as number)) / r.speed) : 0
        const files = t.files as Array<{ size: number; state: string; downloaded: number }>
        let left = t.completedBytes as number
        files.forEach(f => { const d = Math.min(f.size, left); f.downloaded = d; f.state = d >= f.size ? 'done' : d > 0 ? 'downloading' : 'pending'; left -= d })
        if (next >= 1) { t.state = 'installing'; r.phase = 'installing'; r.progress = 0; t.speed = 0; t.etaSeconds = 0; files.forEach(f => { f.downloaded = f.size; f.state = 'done' }) }
      } else {
        r.progress = Math.min(1, r.progress + 0.04 * speedScale)
        if (r.progress >= 1) {
          t.state = 'complete'; t.finishedAt = Date.now(); running.delete(r.id)
          const it = items.find(i => i.id === t.itemId); if (it) it.installed = true
          emit('task.finished', { task: { ...t, statusText: '' }, counts: { active: running.size } })
          emit('library.changed', managed())
        }
      }
      t.statusText = statusText(t)
      emit('task.updated', { ...t })
    }
  }, 500)

  const managed = () => {
    const out: Array<Record<string, unknown>> = []
    for (const it of items) if (it.favorite || it.installed || [...tasks.values()].some(t => t.itemId === it.id)) {
      const t = [...tasks.values()].find(t => t.itemId === it.id)
      out.push({ item: { ...it }, state: t?.state ?? 'none', exePath: it.installed ? `D:\\Games\\${it.title.slice(0, 12)}\\game.exe` : '', installDir: it.installed ? `D:\\Games\\${it.title.slice(0, 12)}` : '', running: false })
    }
    return out
  }

  let auth = options.auth ?? 'logged-out'
  let qr: { sessionId: string; phase: string; ticks: number } | null = null
  const settings = { downloadDir: 'D:\\Games', installDir: 'D:\\Games', concurrentTasks: 3, connectionsPerTask: 16, speedLimit: 0, pansouBaseUrl: 'https://so.252035.xyz', autoInstall: true, removePackage: true, sourcePc: 'ode', sourceConsole: 'ode', sourceSoftware: 'ode' }

  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    'system.hello': () => ({ pluginId: 'com.github.eNest.game-box', platform: 'win32', node: 'v22' }),
    'settings.get': () => ({ ...settings }),
    'settings.update': (patch: Record<string, unknown>) => Object.assign(settings, patch),
    'library.facets': (section: string) => facets(section),
    'library.list': (q: { section: string; page: number; keyword: string; category: string }) => {
      const kw = q.keyword.trim()
      const list = items.filter(i => i.section === q.section && (!kw || i.title.toLowerCase().includes(kw.toLowerCase())) && (!q.category || i.category === q.category))
      const size = 12, totalPages = Math.max(1, Math.ceil(list.length / size)), page = Math.min(q.page, totalPages)
      return { items: list.slice((page - 1) * size, page * size).map(i => ({ ...i })), page, totalPages, total: list.length }
    },
    'library.detail': (itemId: string) => {
      const it = items.find(i => i.id === itemId)
      if (!it) throw new Error('条目不存在')
      const n = Number(itemId.split(':')[1])
      const packages = it.kind === 'trainer' || it.kind === 'mod' ? [{ id: 'p1', name: it.title, sizeText: `${(2 + n * 3)}.${n} MB`, size: 0, provider: '直链下载', state: 'ready', exePath: '', updatedAt: '2026-11-20' }] : [
        { id: 'p0', name: `${it.title.split('/')[0]} 正在打包`, sizeText: '6.37 MB', size: 0, provider: '直链下载', state: 'warehousing', exePath: '', updatedAt: '' },
        { id: 'p1', name: `${it.title.split('/')[0]} v1.0.${n}`, sizeText: `${(45 + n * 11)}.${n} GB`, size: 0, provider: '天翼云盘', state: 'ready', exePath: 'game/bin/game.exe', updatedAt: '2026-11-18' },
        { id: 'p2', name: `${it.title.split('/')[0]} v1.0.${n + 1}`, sizeText: `${(48 + n * 11)}.${n + 3} GB`, size: 0, provider: '天翼云盘', state: 'ready', exePath: 'game/bin/game.exe', updatedAt: '2026-11-21' },
        { id: 'p3', name: '附加内容与补丁', sizeText: '', size: 0, provider: '文件夹', state: 'folder', exePath: '', updatedAt: '', childCount: 3 },
      ]
      return {
        item: { ...it },
        media: [0, 1, 2, 3].map(i => ({ token: `cover:${itemId}:s${i}`, type: 'image' })),
        description: `<h2>游戏介绍</h2><p>${it.title} 是一款${it.category}类作品。这是一段用于预览的假介绍文字，用来检查正文的排版、行宽、图片与列表的显示效果。</p><h3>游戏特色</h3><ul><li>开放世界探索，包含二十余个区域</li><li>支持手柄与键鼠，含完整中文语音</li><li>包含全部已发布的 DLC 与画质升级</li></ul><p>安装说明：解压后直接运行 <code>game.exe</code>，无需安装。首次启动较慢属于正常现象。</p><img src="${cover(itemId, true)}" alt="" /><p>配置要求：Windows 10 64 位、16 GB 内存、DirectX 12 显卡。</p>`,
        datetime: '2026-11-22 17:27', sizeText: it.sizeText, installedSizeText: `${(45 + n * 11) * 3} GB`, minConfig: 'Windows 10 / 8 GB 内存 / GTX 1060', recommendConfig: 'Windows 11 / 16 GB 内存 / RTX 3060',
        officialUrl: 'https://store.steampowered.com/', packages,
        trainerOptions: it.kind === 'trainer' ? [{ name: '无限生命', hotkey: 'F1', type: 1, text: '开启', tooltip: '锁定生命值' }, { name: '无限弹药', hotkey: 'F2', type: 1, text: '开启', tooltip: '无需装填' }] : [],
        trainerGuides: it.kind === 'trainer' ? [{ id: 1, title: '修改器使用说明', url: 'https://example.test/guide' }] : [],
      }
    },
    'media.load': (token: string) => ({ url: cover(seedOf(token), token.endsWith(':s0') || token.endsWith(':s1') || token.endsWith(':s2') || token.endsWith(':s3')), mime: 'image/jpeg' }),
    'library.favorite': (itemId: string, favorite: boolean) => { const it = items.find(i => i.id === itemId); if (it) it.favorite = favorite; emit('library.changed', managed()); return { ok: true } },
    'library.managed': () => managed(),
    'library.setExe': () => managed(),
    'library.addCustom': () => managed(),
    'library.launch': (itemId: string) => { const it = items.find(i => i.id === itemId); if (it) it.installed = true; emit('library.changed', managed()); return { running: true, elevated: false } },
    'library.close': () => { emit('library.changed', managed()); return { running: false } },
    'library.uninstall': (itemId: string) => { const it = items.find(i => i.id === itemId); if (it) it.installed = false; tasks.delete([...tasks.entries()].find(([, t]) => t.itemId === itemId)?.[0] ?? ''); emit('library.changed', managed()); return managed() },
    'library.reveal': () => ({ ok: true }),
    'share.parse': (url: string) => { const code = /\/t\/([^/?]+)/.exec(url)?.[1] ?? 'share'; return { title: `分享 ${code}`, shareId: '123456', files: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, name: `${code}.part0${i + 1}.rar`, size: (8 + i) * 1024 ** 3, sizeText: `${8 + i} GB` })), folders: [] } },
    'task.create': (req: { itemId: string; share?: { title: string }; downloadTarget?: { handleId: string }; installTarget?: { handleId: string } }) => {
      if (!req.downloadTarget?.handleId || !req.installTarget?.handleId) throw new Error('缺少目录授权句柄，请在对话框里点击选择')
      const id = `t_new${tasks.size}`
      const title = req.share?.title ?? items.find(i => i.id === req.itemId)?.title ?? '新任务'
      const total = 52_000_000_000
      tasks.set(id, { id, itemId: req.itemId, title, coverToken: `cover:${req.itemId}`, kind: 'game', state: 'resolving', statusText: '正在解析资源', files: [{ name: 'Game.part1.rar', size: total, downloaded: 0, state: 'pending' }], totalBytes: total, completedBytes: 0, speed: 0, etaSeconds: 0, error: '', installError: '', downloadDir: settings.downloadDir, installDir: settings.installDir, autoInstall: req.autoInstall, removePackage: req.removePackage, stalled: false, createdAt: Date.now(), finishedAt: 0 })
      setTimeout(() => { const t = tasks.get(id)!; t.state = 'downloading'; running.set(id, { id, phase: 'downloading', progress: 0, speed: 30_000_000 * speedScale }) }, 1200)
      return { taskId: id }
    },
    'task.list': () => [...tasks.values()].map(t => ({ ...t, statusText: statusText(t) })).sort((a, b) => (b.createdAt as number) - (a.createdAt as number)),
    'task.pause': (id: string) => { const t = tasks.get(id); if (t) { t.state = 'paused'; t.speed = 0; running.delete(id) } return { ok: true } },
    'task.resume': (id: string) => { const t = tasks.get(id); if (t) { t.state = 'downloading'; t.error = ''; running.set(id, { id, phase: 'downloading', progress: (t.completedBytes as number) / (t.totalBytes as number), speed: 22_000_000 * speedScale }) } return { ok: true } },
    'task.retryInstall': (id: string) => { const t = tasks.get(id); if (t) { t.state = 'installing'; t.installError = ''; running.set(id, { id, phase: 'installing', progress: 0.3, speed: 0 }) } return { ok: true } },
    'task.remove': (id: string) => { running.delete(id); tasks.delete(id); return { ok: true } },
    'task.updateOptions': (id: string, patch: Record<string, unknown>) => { const t = tasks.get(id); if (t) Object.assign(t, patch); return { ok: true } },
    'auth.info': () => ({ state: auth === 'logged-in' ? 'logged-in' : auth === 'expired' ? 'expired' : 'logged-out', nickname: auth === 'logged-in' ? '演示用户' : '', savedAccount: '138****8888' }),
    'auth.qrStart': () => { qr = { sessionId: 'qr1', phase: 'pending', ticks: 0 }; setTimeout(() => emit('auth.qr', { sessionId: 'qr1', status: { phase: 'pending', image: qrImage(), message: '请用天翼云盘 App 扫码' } }), 400); return { sessionId: 'qr1' } },
    'auth.qrCancel': () => { qr = null; return { ok: true } },
    // 与真实后端一致：登录成功返回会话凭据，页面入库后经 auth.saveSession 回传，此时才切换登录态
    'auth.loginPassword': () => ({ sessionId: 'ps1', needCaptcha: '', credential: 'demo-credential' }),
    'auth.saveSession': (input: { sessionRef: string; rememberPassword?: boolean }) => { auth = 'logged-in'; emit('auth.changed', handlers['auth.info']()); return { ok: true } },
    'auth.logout': () => { auth = 'logged-out'; emit('auth.changed', handlers['auth.info']()); return { ok: true } },
    // 两步式：未确认时返回要删除的保险库引用；页面删完后以 confirmed 再调用
    'auth.forget': (confirmed?: boolean) => (confirmed ? { ok: true, removeRefs: [] as string[] } : { ok: true, removeRefs: ['ref-account', 'ref-password'] }),
    'pansou.health': () => ({ available: true, baseUrl: settings.pansouBaseUrl }),
    'pansou.search': (kw: string) => ({ total: 6, groups: [
      { type: 'tianyi', label: '天翼云盘', results: [0, 1, 2].map(i => ({ url: `https://cloud.189.cn/t/demo${i}?pwd=a1b${i}`, accessCode: `a1b${i}`, note: `【${kw}】中文免安装版 第${i + 1} 个资源`, datetime: '2026-11-20', source: 'tgsearchers7', downloadable: true })) },
      { type: 'ali', label: '阿里云盘', results: [0, 1].map(i => ({ url: `https://www.alipan.com/s/demo${i}`, accessCode: '', note: `【${kw}】全DLC 学习版 ${i + 1}`, datetime: '2026-11-18', source: 'yunpanx', downloadable: false })) },
    ] }),
  }

  function qrImage(): string {
    const c = document.createElement('canvas'); c.width = 200; c.height = 200
    const x = c.getContext('2d')!
    x.fillStyle = '#fff'; x.fillRect(0, 0, 200, 200); x.fillStyle = '#111'
    let s = 7
    for (let i = 0; i < 25; i++) for (let j = 0; j < 25; j++) { s = (s * 1103515245 + 12345) >>> 0; if ((s >> 16) & 1) x.fillRect(8 + i * 7.4, 8 + j * 7.4, 7, 7) }
    for (const [ox, oy] of [[8, 8], [147, 8], [8, 147]]) { x.fillStyle = '#111'; x.fillRect(ox, oy, 45, 45); x.fillStyle = '#fff'; x.fillRect(ox + 7, oy + 7, 31, 31); x.fillStyle = '#111'; x.fillRect(ox + 14, oy + 14, 17, 17) }
    return c.toDataURL('image/png')
  }

  // 二维码轮询：约 6 秒后模拟"已扫码"，再 3 秒后带凭据下发登录成功；
  // auth.changed 由页面入库后调 auth.saveSession 触发，与真实后端顺序一致
  setInterval(() => {
    if (!qr) return
    qr.ticks++
    if (qr.ticks === 12) emit('auth.qr', { sessionId: 'qr1', status: { phase: 'scanned', image: qrImage(), message: '已扫码，请在手机上确认' } })
    if (qr.ticks === 18) { qr = null; emit('auth.qr', { sessionId: 'qr1', status: { phase: 'pending', image: '', message: '登录成功' }, credential: 'demo-qr-credential' }) }
  }, 500)

  const members: Record<string, string> = {
    '': 'setTitle setIcon setBadge resize setDirty ui theme settings storage vault localFiles shell clipboard runtime backend on off onEnter onOut onDestroy getPluginId getEnterCode getLaunchMode onModeChange i18n',
    ui: 'toast openSettings setTitle',
    theme: 'getTokens onThemeChange getAppearance onAppearanceChange',
    settings: 'get set onChange', storage: 'get set remove flush commit', vault: 'set has remove',
    localFiles: 'pick reveal', shell: 'openExternal', clipboard: 'writeText', runtime: 'acquireActivity releaseActivity', backend: 'call stop', i18n: 'getLocale onLocaleChange',
  }
  const surfaces = new Map<string, unknown>()
  function api(path = ''): any {
    if (surfaces.has(path)) return surfaces.get(path)
    const keys = Object.hasOwn(members, path) ? members[path].split(' ') : null
    const target: any = keys ? {} : function (...args: unknown[]) {
      if (path === 'backend.call') {
        const method = String(args[0]); const rest = (args[1] as unknown[]) ?? []
        const h = handlers[method]
        if (!h) return Promise.reject(new Error(`未知后端方法：${method}`))
        try { return Promise.resolve(h(...rest)) } catch (e) { return Promise.reject(e) }
      }
      if (path === 'storage.get') return Promise.resolve(values.get(args[0]) ?? null)
      if (path === 'storage.set') { values.set(String(args[0]), args[1]); return Promise.resolve(true) }
      if (path === 'localFiles.pick') return Promise.resolve([{ id: 'demo-dir', name: 'Games', kind: 'directory', size: 0, displayPath: 'D:\\Games' }])
      if (path === 'vault.set') return Promise.resolve({ secretRef: `ref:${args[0]}` })
      if (path === 'vault.has') return Promise.resolve(false)
      if (path === 'settings.get') return Promise.resolve(null)
      if (path === 'getPluginId') return 'com.github.eNest.game-box'
      if (path === 'getEnterCode') return 'main'
      if (path === 'getLaunchMode') return 'shell'
      if (path === 'i18n.getLocale') return 'zh-CN'
      const last = path.split('.').at(-1)
      if (/^on[A-Z]/.test(last)) return on(path, args[0] as (p: unknown) => void)
      if (path === 'on') return on(String(args[0]), args[1] as (p: unknown) => void)
      if (path === 'off') return listeners.get(String(args[0]))?.delete(args[1] as (p: unknown) => void)
      return Promise.resolve(true)
    }
    const surface = new Proxy(target, { get(t, key, receiver) {
      if (key === 'then') return undefined
      if (typeof key !== 'string' || Reflect.has(t, key)) return Reflect.get(t, key, receiver)
      return api(path ? path + '.' + key : key)
    } })
    surfaces.set(path, surface)
    for (const key of keys ?? []) target[key] = api(path ? path + '.' + key : key)
    return surface
  }

  Object.defineProperty(window, 'enest', { value: api(), configurable: true, writable: true })
  window.__gameBox = { emit, handlers, tasks, setAuth: (v: 'logged-in' | 'logged-out' | 'expired') => { auth = v; emit('auth.changed', handlers['auth.info']()) } }
}
