/**
 * memes 的浏览器预览夹具：在普通浏览器里伪造 window.enest，无需 eNest 宿主。
 * 用途：浏览器里看界面、用假数据走通整条流程（浏览 → 筛选 → 复制 → 收藏 → 导入）。
 * 不进入构建产物；只在预览与界面测试时注入。
 *
 * 主题：applyAppearance 需要 version:2 外观对象；URL ?theme=dark|light 或按 T 键切换。
 * 网络：模拟宿主流式协议——net.fetch(stream:true) 先返回 reqId 元信息，
 *       再经 net.onChunk 推 base64 分片 + done 帧；文本响应直接回 body。
 */

const appearanceListeners = new Set()
const chunkListeners = new Set()
const storageData = new Map()
const assets = new Map()
let assetSeq = 0
let reqSeq = 0
let delay = 350
let fakeErrorMode = false

function themeTokens(mode) {
  const dark = mode === 'dark'
  return {
    '--bg': dark ? '#17181c' : '#f7f6f3',
    '--surface': dark ? '#202227' : '#ffffff',
    '--text': dark ? '#e8e6e1' : '#2b2a27',
    '--border': dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.10)',
    '--accent': dark ? '#e9865a' : '#d97b4c',
  }
}

function appearancePayload(mode) {
  return {
    version: 2,
    revision: Date.now(),
    mode,
    theme: { id: 'enest.builtin/default' },
    fonts: {},
    layout: { variant: 'default', gap: 12, density: 1 },
    components: { controlRadius: 8, cardRadius: 12, panelRadius: 10, borderWidth: 1 },
    background: { effect: 'none' },
    tokens: themeTokens(mode),
  }
}

/* ---------------- 假数据 ---------------- */

const CATEGORIES = ['熊猫头', '金馆长', '蘑菇头', '假笑男孩', '尔康', '王境泽', '鹦鹉兄弟', '白熊', '龙图', '柴犬', 'Taco', '柑仔蜜']
const LABELS = ['就这', '无语', '妙啊', '告辞', '安排', '泪目', '好活', '拿来吧你', '裂开', '赢麻了', '典中典', '急了', '乐', '绷不住', '差不多得了', '6']

function seedItem(n) {
  const w = 140 + ((n * 37) % 160)
  const h = 140 + ((n * 53) % 220)
  return {
    id: String(n + 1), name: `${n + 1}.png`, label: `${CATEGORIES[n % CATEGORIES.length]}·${LABELS[n % LABELS.length]}`,
    src: `media/${n + 1}.png`, thumb: `thumbs/${n + 1}.webp`,
    width: w, height: h, animated: n % 3 === 0, bytes: 50000 + (n * 997) % 90000,
    category: `cat${n % CATEGORIES.length}`, categoryTitle: CATEGORIES[n % CATEGORIES.length], folder: `bqb-${n % CATEGORIES.length}`,
  }
}

const TOTAL = 240

function catalogIndex() {
  return { categories: CATEGORIES.map((title, i) => ({ id: `cat${i}`, title, count: Math.floor(TOTAL / CATEGORIES.length) })) }
}

function catalogSearch() {
  return { items: Array.from({ length: TOTAL }, (_, i) => seedItem(i)) }
}

/** 假表情图：canvas 画确定性渐变 + 文字；返回 PNG 字节 */
const fakeCoverBytes = new Map()
function fakeImageBytes(n) {
  const key = n % TOTAL
  if (fakeCoverBytes.has(key)) return fakeCoverBytes.get(key)
  const item = seedItem(key)
  const canvas = document.createElement('canvas')
  canvas.width = item.width
  canvas.height = item.height
  const ctx = canvas.getContext('2d')
  const hue = (key * 47) % 360
  const grad = ctx.createLinearGradient(0, 0, item.width, item.height)
  grad.addColorStop(0, `hsl(${hue}, 42%, 72%)`)
  grad.addColorStop(1, `hsl(${(hue + 46) % 360}, 38%, 52%)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, item.width, item.height)
  ctx.fillStyle = 'rgba(255,255,255,.94)'
  ctx.font = `bold ${Math.max(15, Math.floor(Math.min(item.width, item.height) / 6))}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(LABELS[key % LABELS.length], item.width / 2, item.height / 2)
  const dataUrl = canvas.toDataURL('image/png')
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  fakeCoverBytes.set(key, bytes)
  return bytes
}

function fakeFbqHtml(page) {
  const start = (page - 1) * 24
  const imgs = Array.from({ length: 24 }, (_, i) => {
    const n = start + i
    return `<li class="tagbqppdpqk"><img class="img-responsive" data-original="https://sinaimg.fake.local/${(n % TOTAL) + 1}.gif" src="https://sinaimg.fake.local/${(n % TOTAL) + 1}.gif" title="${LABELS[n % LABELS.length]}搞笑表情包" alt="${LABELS[n % LABELS.length]}"></li>`
  }).join('')
  const next = page < 3 ? `<a href="/bqb/lists/page/${page + 1}.html">下一页</a>` : ''
  return `<html><body><ul>${imgs}</ul>${next}</body></html>`
}

function fakeFbqSearchHtml(keyword) {
  const imgs = Array.from({ length: 24 }, (_, i) => {
    const n = i + 7
    return `<img data-original="https://sinaimg.fake.local/${(n % TOTAL) + 1}.gif" src="https://sinaimg.fake.local/${(n % TOTAL) + 1}.gif" title="${keyword}·${LABELS[i % LABELS.length]}">`
  }).join('')
  return `<html><body>${imgs}</body></html>`
}

/* ---------------- 字节工具 ---------------- */

function bytesToBase64(bytes) {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function dataUrlToBytes(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function mimeOf(url) {
  if (/\.gif($|\?)/i.test(url)) return 'image/gif'
  if (/\.webp($|\?)/i.test(url)) return 'image/webp'
  if (/\.jpe?g($|\?)/i.test(url)) return 'image/jpeg'
  return 'image/png'
}

/* ---------------- net.fetch 模拟 ---------------- */

/** 真实数据模式：浏览器直连（zhaoolee.com CORS 全开），模拟宿主 net.fetch 语义 */
const REAL_MODE = new URLSearchParams(location.search).get('fake') !== '1'

function arrayBufferToBase64(buffer) {
  return bytesToBase64(new Uint8Array(buffer))
}

async function realFetch(req) {
  if (fakeErrorMode) throw new Error('模拟网络故障')
  const res = await fetch(req.url, { method: 'GET', headers: req.headers, signal: AbortSignal.timeout?.(req.timeoutMs ?? 30000) })
  if (req.stream) {
    reqSeq += 1
    const reqId = `freq-${reqSeq}`
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    const buffer = await res.arrayBuffer()
    setTimeout(() => {
      for (const cb of chunkListeners) {
        cb({ reqId, chunk: arrayBufferToBase64(buffer) })
        cb({ reqId, chunk: '', done: true })
      }
    }, 0)
    return { status: res.status, headers: { 'content-type': contentType }, body: '', streamed: true, reqId }
  }
  const text = await res.text()
  return { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? '' }, body: text, streamed: false }
}

function resolveFixtureUrl(url) {
  if (url.includes('catalog/index.json')) return { kind: 'json', value: catalogIndex() }
  if (url.includes('catalog/search.json')) return { kind: 'json', value: catalogSearch() }
  if (url.includes('/search/bqb/keyword/')) {
    const word = decodeURIComponent(url.split('/keyword/')[1] || '')
    return { kind: 'text', value: fakeFbqSearchHtml(word), contentType: 'text/html' }
  }
  if (url.includes('/bqb/lists/page/')) {
    const page = Number(/page\/(\d+)/.exec(url)?.[1] ?? 1)
    return { kind: 'text', value: fakeFbqHtml(page), contentType: 'text/html' }
  }
  if (url === 'https://fabiaoqing.com/' || url.endsWith('fabiaoqing.com')) {
    return {
      kind: 'text',
      contentType: 'text/html',
      value: `<html><body>${['熊猫', '开心', '无语', '告辞', '加油', '晚安', '谢谢', '生气', '摸鱼', '打工'].map(word => `<a href="/search/bqb/keyword/${encodeURIComponent(word)}">${word}</a>`).join('')}</body></html>`,
    }
  }
  const fakeImg = /sinaimg\.fake\.local\/(\d+)/.exec(url)
  if (fakeImg) return { kind: 'bytes', value: fakeImageBytes(Number(fakeImg[1]) - 1), contentType: mimeOf(url) }
  const bqbImg = /\/(media|thumbs)\/(\d+)\./.exec(url)
  /* thumbs 实际是 canvas 生成的 PNG 字节，统一按 image/png 返回，避免 webp 声明与字节不符 */
  if (bqbImg) return { kind: 'bytes', value: fakeImageBytes(Number(bqbImg[2]) - 1), contentType: 'image/png' }
  return null
}

function fixtureFetch(req) {
  if (REAL_MODE) return realFetch(req).catch(err => Promise.reject(err instanceof TypeError ? new Error('网络不可达（浏览器直连模式）') : err))
  const resolved = resolveFixtureUrl(req.url)
  if (!resolved) return Promise.reject(new Error(`fixture 不认识 ${req.url}`))
  if (fakeErrorMode) return Promise.reject(new Error('模拟网络故障'))
  if (req.stream) {
    reqSeq += 1
    const reqId = `freq-${reqSeq}`
    setTimeout(() => {
      for (const cb of chunkListeners) {
        if (resolved.kind === 'bytes') {
          /* 每块独立 base64（宿主语义），不做跨块切分 */
          cb({ reqId, chunk: bytesToBase64(resolved.value) })
        } else {
          cb({ reqId, chunk: btoa(unescape(encodeURIComponent(resolved.value))) })
        }
        cb({ reqId, chunk: '', done: true })
      }
    }, delay)
    return Promise.resolve({ status: 200, headers: { 'content-type': resolved.contentType ?? 'application/json' }, body: '', streamed: true, reqId })
  }
  let body = ''
  if (resolved.kind === 'json') body = JSON.stringify(resolved.value)
  else if (resolved.kind === 'text') body = resolved.value
  else body = bytesToBase64(resolved.value)
  return Promise.resolve({ status: 200, headers: { 'content-type': resolved.contentType ?? 'application/json' }, body, streamed: false })
}

/* ---------------- window.enest ---------------- */

function installMemesFixture() {
  window.enest = {
    theme: {
      getAppearance: async () => appearancePayload(new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light'),
      onAppearanceChange: cb => { appearanceListeners.add(cb); return () => appearanceListeners.delete(cb) },
    },
    net: {
      fetch: fixtureFetch,
      onChunk: cb => { chunkListeners.add(cb); return () => chunkListeners.delete(cb) },
    },
    clipboard: {
      writeImage: async dataUrl => { console.log('[fixture] clipboard.writeImage', `${String(dataUrl).length} 字符`); return true },
      writeText: async text => { console.log('[fixture] clipboard.writeText', text); return true },
    },
    storage: {
      get: async key => storageData.get(key),
      set: async (key, value) => { storageData.set(key, value); return true },
      remove: async key => { storageData.delete(key); return true },
      flush: async () => ({}),
      assets: {
        put: async ({ bytes, dataUrl, mime, name }) => {
          const realBytes = bytes ? new Uint8Array(bytes) : dataUrlToBytes(dataUrl)
          assetSeq += 1
          const assetId = `asset-${assetSeq}`
          assets.set(assetId, { dataUrl: `data:${mime || 'image/png'};base64,${bytesToBase64(realBytes)}`, name: name || '' })
          return { assetId }
        },
        get: async assetId => assets.get(assetId) ?? null,
        remove: async assetId => { assets.delete(assetId); return true },
        list: async () => [...assets.entries()].map(([assetId, v]) => ({ assetId, ...v })),
      },
    },
    localFiles: {
      pick: async () => [{ handleId: 'pick-1', name: `本地导入${Date.now() % 1000}.png` }],
      read: async ({ encoding }) => {
        if (encoding !== 'dataUrl') return ''
        const bytes = fakeImageBytes(Date.now() % TOTAL)
        return `data:image/png;base64,${bytesToBase64(bytes)}`
      },
      fromDrop: async files => Array.from(files).map(file => ({ handleId: `drop-${file.name}`, name: file.name })),
    },
    on: () => {},
    off: () => {},
  }

  window.__memesFixture = {
    setDelay(ms) { delay = ms },
    setFakeError(on) { fakeErrorMode = on },
    toggleTheme() {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
      const payload = appearancePayload(next)
      for (const cb of appearanceListeners) cb(payload)
    },
  }
  window.addEventListener('keydown', e => {
    if (e.key === 't' || e.key === 'T') window.__memesFixture.toggleTheme()
  })
}

installMemesFixture()
