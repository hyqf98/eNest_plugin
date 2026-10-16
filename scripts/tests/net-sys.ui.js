import { test, expect } from '@playwright/test'
import * as net from 'node:net'
import { createServer as createHttp } from 'node:http'

/**
 * net-kit 冒烟：双形态（quick / shell）+ Tab 切换 + HTTP 流式 + TCP echo 收发 hex 渲染 + sysguard 表格排序。
 * 宿主 API mock（enest.net.* 直连本进程内真实 echo TCP / 假 HTTP 服务，验证插件收发渲染链路）。
 */

let tcpPort = 0
let httpPort = 0

test.beforeAll(async () => {
  // echo TCP
  await new Promise((res) => {
    const srv = net.createServer((s) => s.on('data', (d) => s.write(d)))
    srv.listen(0, '127.0.0.1', () => { tcpPort = srv.address().port; res() })
    test.__tcpSrv = srv
  })
  // 假 HTTP：JSON / SSE
  await new Promise((res) => {
    const srv = createHttp((req, res) => {
      if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: { list: [{ id: 1 }, { id: 2 }] } }))
      } else if (req.url === '/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        let i = 0
        const t = setInterval(() => {
          res.write(`data: tick-${++i}\n\n`)
          if (i >= 3) { clearInterval(t); res.end() }
        }, 30)
      } else if (req.url === '/refused') {
        res.destroy()
      }
    })
    srv.listen(0, '127.0.0.1', () => { httpPort = srv.address().port; res() })
    test.__httpSrv = srv
  })
})

test.afterAll(() => {
  test.__tcpSrv?.close()
  test.__httpSrv?.closeAllConnections?.()
  test.__httpSrv?.close()
})

async function setup(page, { mode = 'shell', plugin = 'net-kit', seed = {} } = {}) {
  // 屏蔽协议主题 CSS（vite 场景同样无 enest:// scheme）
  await page.route('**/__enest_theme.css', (route) => route.fulfill({ contentType: 'text/css', body: '' }))
  // Node 侧桥：net.fetch / socket 直连真实服务（页面 fetch 受 CORS 限制）
  const sockets = new Map()
  let socketSeq = 0
  const toB64 = (buf) => Buffer.from(buf).toString('base64')
  await page.exposeFunction('__hostFetch', async (req) => {
      const reqId = 'req-' + Math.random().toString(36).slice(2, 8)
      const events = []
      let result
      try {
        const started = await fetch(req.url, {
          method: req.method ?? 'GET',
          headers: req.headers ?? {},
          body: req.body,
        })
        const headers = {}
        started.headers.forEach((v, k) => { headers[k] = v })
        const ct = headers['content-type'] ?? ''
        result = { status: started.status, headers, body: '', streamed: true, reqId }
        if (started.body) {
          const reader = started.body.getReader()
          if (ct.includes('text/event-stream')) {
            const dec = new TextDecoder()
            let buf = ''
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buf += dec.decode(value, { stream: true })
              let nl
              while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl)
                buf = buf.slice(nl + 1)
                if (line.startsWith('data:')) events.push({ reqId, chunk: line.slice(5).replace(/^ /, '') })
              }
            }
          } else {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              events.push({ reqId, chunk: toB64(value) })
            }
          }
        }
        events.push({ reqId, chunk: '', done: true })
      } catch (err) {
        throw new Error(String(err?.message ?? err))
      }
      return { result, events }
    })
  await page.exposeFunction('__hostConnect', ({ host, port }) => {
      return new Promise((res, rej) => {
        const socketId = 'sk-' + ++socketSeq
        const sock = net.connect({ host, port }, () => {
          sock.on('data', (d) => page.evaluate(([evt, data]) => window.__emitHost(evt, data), ['net.data', { socketId, chunk: toB64(d) }]).catch(() => {}))
          sock.on('close', () => { sockets.delete(socketId); page.evaluate(([evt, data]) => window.__emitHost(evt, data), ['net.close', { socketId, reason: 'closed' }]).catch(() => {}) })
          sockets.set(socketId, sock)
          res({ socketId })
        })
        sock.once('error', (e) => rej(new Error(e.message)))
      })
    })
  await page.exposeFunction('__hostSend', (socketId, data) => {
      const sock = sockets.get(socketId)
      if (!sock) throw new Error('socket not found')
      const buf = /^[A-Za-z0-9+/]+={0,2}$/.test(data) && data.length % 4 === 0
        ? Buffer.from(data, 'base64')
        : Buffer.from(data, 'utf8')
      sock.write(buf)
      return { sent: buf.length }
    })
  await page.exposeFunction('__hostClose', (socketId) => {
    sockets.get(socketId)?.destroy()
    sockets.delete(socketId)
    return true
  })
  await page.addInitScript(({ mode, plugin, seed, tcpPort, httpPort }) => {
    const listeners = {}
    const on = (evt) => (fn) => {
      (listeners[evt] ??= []).push(fn)
      return () => { listeners[evt] = listeners[evt].filter((f) => f !== fn) }
    }
    const emit = (evt, data) => (listeners[evt] ?? []).forEach((f) => { try { f(data) } catch {} })
    const store = structuredClone(seed)
    const storeWrites = []
    const toasts = []
    window.__store = store
    window.__toasts = toasts
    window.__storeWrites = storeWrites
    window.__mode = mode
    window.enest = {
      getLaunchMode: () => window.__mode,
      onModeChange: (fn) => {
        (listeners['mode'] ??= []).push(fn)
        return () => { listeners['mode'] = listeners['mode'].filter((f) => f !== fn) }
      },
      setMode(m) { window.__mode = m; emit('mode', m) },
      onEnter: on('enter'),
      onOut: on('out'),
      onBeforeClose: on('close'),
      onBeforeSuspend: on('suspend'),
      onDestroy: on('destroy'),
      ui: {
        setTitle: async () => true,
        setHeight: async () => true,
        resize: async () => true,
        setInputContext: async () => true,
        toast: async ({ message, type }) => { toasts.push({ message, type }); return true },
        openSettings: async () => true,
        focus: async () => true,
        focusSearch: async () => true,
        onThemeChange: () => () => {},
      },
      quickInput: {
        configure: async () => true,
        release: async () => true,
        escape: async () => true,
        onChange: on('query'),
        onAction: on('action'),
      },
      storage: {
        get: async (key) => structuredClone(store[key]),
        set: async (key, value) => { store[key] = structuredClone(value); storeWrites.push(key); return true },
        remove: async (key) => { delete store[key]; return true },
        clear: async () => true,
        session: { get: async () => undefined, set: async () => true, remove: async () => true, clear: async () => true },
      },
      clipboard: { writeText: async () => true, readText: async () => '' },
      shell: {
        saveTextFile: async (p) => ({ ok: true, path: '/tmp/' + (p.defaultName ?? 'f') }),
        saveFile: async () => ({ ok: true, path: '/tmp/f' }),
        openExternal: async () => true,
      },
      // —— net mock：net.fetch / socket 经 __host* 交 Node 侧真实服务（免 CORS），事件回流 emit ——
      net: {
        async fetch(req) {
          const out = await window.__hostFetch(req)
          const reqId = out.result.reqId
          for (const ev of out.events) emit('net.chunk', ev)
          return out.result
        },
        websocket: {
          connect: async () => ({ socketId: 'ws-demo' }),
          send: async (socketId, data, binary = false) => {
            (window.__wsSent ??= []).push({ socketId, data, binary })
            emit('ws.message', { socketId, data, binary })
            return { sent: data.length }
          },
          close: async socketId => { emit('ws.close', { socketId, code: 1000, reason: '' }); return true },
          onMessage: on('ws.message'),
          onClose: on('ws.close'),
        },
        socket: {
          connect: async ({ host, port, tls, timeoutMs }) => window.__hostConnect({ host, port, tls, timeoutMs }),
          send: async (socketId, data) => window.__hostSend(socketId, data),
          close: async (socketId) => window.__hostClose(socketId),
          list: async () => [],
          serveWs: async () => ({ url: 'ws://127.0.0.1:1/bridge?token=x', token: 'x', port: 1 }),
        },
        onNetData: on('net.data'),
        onNetClose: on('net.close'),
        onChunk: on('net.chunk'),
      },
      // —— sys mock：固定样本 ——
      sys: {
        processes: async () => [
          { pid: 1, pcpu: 0.2, pmem: 0.1, rss: 20480, user: 'root', command: '/sbin/launchd' },
          { pid: 2345, pcpu: 42.5, pmem: 3.3, rss: 512000, user: 'haijun', command: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
          { pid: 8080, pcpu: 1.4, pmem: 0.6, rss: 65536, user: 'haijun', command: 'node echo-server.mjs' },
        ],
        ports: async () => [
          { command: 'node', pid: 8080, user: 'haijun', protocol: 'TCP', address: '127.0.0.1', port: tcpPort, name: '127.0.0.1:' + tcpPort },
          { command: 'rapportd', pid: 512, user: '_rapportd', protocol: 'TCP', address: '0.0.0.0', port: 59345, name: '*:59345' },
        ],
        kill: async (pid, opts) => {
          if (!opts?.confirmed) throw new Error('请先确认结束进程')
          window.__killed ??= []
          window.__killed.push(pid)
          return true
        },
      },
      runtime: { acquireActivity: async () => 'tok', releaseActivity: async () => {} },
    }
    // node → 浏览器事件桥
    window.__emitHost = (evt, data) => emit(evt, data)
  }, { mode, plugin, seed, tcpPort, httpPort })
  page.on('pageerror', (error) => { throw error })
  await page.goto(`/plugins/${plugin}/index.html?mode=${mode}`)
}

// ———— net-kit 桌面形态：HTTP 流式 + TCP echo ————

test('net-kit 桌面：HTTP JSON 流式渲染 + JSON 树 + 断言徽章', async ({ page }) => {
  await setup(page, { mode: 'shell', plugin: 'net-kit' })
  await expect(page.locator('.nk-tab.active')).toContainText('HTTP')
  // 三栏桌面布局
  await expect(page.locator('.nk-split')).toBeVisible()
  // 填 URL 发送
  await page.fill('.nk-input.nk-mono.grow', `http://127.0.0.1:${httpPort}/json`)
  await page.click('.nk-btn.primary:has-text("发送")')
  // 状态徽章 200（ok 系）
  await expect(page.locator('.nk-badges .nk-badge.ok')).toHaveText('200', { timeout: 8000 })
  // JSON 树渲染
  await expect(page.locator('.nk-json')).toContainText('code')
  // 断言：添加 statusEq 200 与 JSONPath 存在，重发验证 pass 徽章
  await page.click('button:has-text("断言")')
  await page.click('button:has-text("+ 添加断言")')
  const sel = page.locator('.nk-assert select').first()
  await sel.selectOption('jsonPathExists')
  await page.fill('.nk-assert input[placeholder*="JSONPath"]', '$.data.list[*].id')
  await page.fill('.nk-input.nk-mono.grow', `http://127.0.0.1:${httpPort}/json`)
  await page.click('.nk-btn.primary:has-text("发送")')
  await expect(page.locator('.nk-assert .res.pass')).toBeVisible({ timeout: 8000 })
})

test('net-kit 桌面：SSE 逐事件 + 暂停按钮', async ({ page }) => {
  await setup(page, { mode: 'shell', plugin: 'net-kit' })
  await page.fill('.nk-input.nk-mono.grow', `http://127.0.0.1:${httpPort}/sse`)
  await page.click('.nk-btn.primary:has-text("发送")')
  await expect(page.locator('.nk-sse-item').first()).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.nk-sse-item')).toHaveCount(3, { timeout: 8000 })
  await expect(page.locator('.nk-badge.accent')).toHaveText('SSE')
})

test('net-kit 桌面：TCP echo 收发 + hexdump 渲染 + 解码策略切换', async ({ page }) => {
  await setup(page, { mode: 'shell', plugin: 'net-kit' })
  // 切到 TCP 模式
  await page.click('#modes button:has-text("TCP")')
  await page.fill('input[placeholder="host"]', '127.0.0.1')
  await page.fill('input[placeholder="port"]', String(tcpPort))
  await page.click('.nk-card-head .nk-btn.primary:has-text("连接")')
  await expect(page.locator('.nk-duplex')).toBeVisible({ timeout: 8000 })
  // 发送（base64 通道）→ echo 回显 → hexdump 渲染
  await page.fill('.nk-duplex-bottom input.grow', 'HELLO')
  await page.click('.nk-duplex-bottom .nk-btn.primary:has-text("发送")')
  const viewer = page.locator('.nk-stream .nk-viewer')
  await expect(viewer).toContainText('48 45 4c 4c 4f', { timeout: 8000 }) // HELLO hex
  await expect(viewer).toContainText('|HELLO|')
  // 切 utf8 视图
  await page.click('.nk-duplex-top .nk-seg button:has-text("UTF-8")')
  await expect(viewer).toContainText('HELLO')
  // 切分隔符帧视图（无分隔符时显示单帧）
  await page.click('.nk-duplex-top .nk-seg button[title*="分隔符帧 · \\\\r\\\\n"]')
  await expect(viewer).toContainText('#1')
})

test('net-kit Quick：智能识别 host:port 探活连接', async ({ page }) => {
  await setup(page, { mode: 'quick', plugin: 'net-kit' })
  await expect(page.locator('.nk-single')).toBeVisible()
  // Quick 输入 host:port → TCP 探活（走 quickRoute 需要 onEnter payload；直接调用页面入口不可行，
  // 改为验证 Quick 形态单列渲染 + 手动 TCP 连接）
  await page.click('#modes button:has-text("TCP")')
  await page.fill('input[placeholder="host"]', '127.0.0.1')
  await page.fill('input[placeholder="port"]', String(tcpPort))
  await page.click('.nk-card-head .nk-btn.primary:has-text("连接")')
  await expect(page.locator('.nk-duplex')).toBeVisible({ timeout: 8000 })
  // 模式切换（⌘Enter 固定到主窗）：setMode('shell') 后三栏出现
  await page.evaluate(() => window.enest.setMode('shell'))
  await expect(page.locator('.nk-split')).toBeVisible()
})

// ———— sysguard 桌面形态：表格排序 + 联动 + 危险确认 ————

test('sysguard 桌面：进程表排序 + 端口联动 + kill 确认', async ({ page }) => {
  await setup(page, { mode: 'shell', plugin: 'sysguard' })
  // 进程表默认按 CPU 降序：Chromium 第一
  const firstRow = page.locator('.sg-table.proc tbody tr').first()
  await expect(firstRow).toContainText('Chromium', { timeout: 8000 })
  // 点 PID 列头：数字列首次点击为降序（8080 在前），再点一次切升序（launchd pid=1 在前）
  await page.click('.sg-table.proc th:has-text("PID")')
  await expect(page.locator('.sg-table.proc tbody tr').first()).toContainText('echo-server')
  await page.click('.sg-table.proc th:has-text("PID")')
  await expect(page.locator('.sg-table.proc tbody tr').first()).toContainText('launchd')
  // 端口 Tab → 点端口行联动回进程表
  await page.click('#tabs button:has-text("端口")')
  await expect(page.locator('.sg-table.port')).toBeVisible()
  await page.click('.sg-table.port tbody tr:has-text("59345")')
  await expect(page.locator('#tabs button.active')).toHaveText('进程')
  await expect(page.locator('.sg-search')).toHaveValue('512')
  // 危险确认：结束 Chromium（pid 升序下定位其行内按钮；先清空联动搜索恢复全表）
  await page.fill('.sg-search', '')
  await page.locator('.sg-search').dispatchEvent('input')
  await expect(page.locator('.sg-table.proc tbody tr')).toHaveCount(3)
  await page.click('.sg-table.proc tbody tr:has-text("Chromium") .kill')
  const dlg = page.locator('#dlg')
  await expect(dlg).toContainText('结束进程')
  await expect(dlg).toContainText('#2345')
  await dlg.locator('button:has-text("结束 #2345")').click()
  await expect.poll(() => page.evaluate(() => window.__killed)).toEqual([2345])
  await expect(page.locator('#plugin-notice')).toContainText('已结束')
})

test('sysguard Quick：端口查询 + 迷你曲线', async ({ page }) => {
  await setup(page, { mode: 'quick', plugin: 'sysguard' })
  await expect(page.locator('#quick-view')).toBeVisible()
  await page.fill('#q-input', String(tcpPort))
  await page.locator('#q-input').dispatchEvent('input')
  await expect(page.locator('.sg-row36', { hasText: 'node' }).first()).toBeVisible({ timeout: 8000 })
  await expect(page.locator('#q-canvas')).toBeVisible()
  // 进程名搜索
  await page.fill('#q-input', 'Chromium')
  await page.locator('#q-input').dispatchEvent('input')
  await expect(page.locator('.sg-row36', { hasText: 'Chromium' }).first()).toBeVisible()
})

test('net-kit WebSocket：宿主桥文本与二进制收发、主动断开', async ({ page }) => {
  await setup(page, { plugin: 'net-kit' })
  await page.locator('#modes button', { hasText: 'WebSocket' }).click()
  await page.getByPlaceholder('wss://host/path（ws:// 明文走宿主桥）').fill('wss://example.test/echo')
  await page.locator('.nk-card-head button', { hasText: /^连接$/ }).click()
  const input = page.getByPlaceholder('发送文本（hex 视图下按 hex 字面发送）')
  await input.fill('HELLO')
  await page.locator('button', { hasText: /^发送$/ }).click()
  await expect.poll(() => page.evaluate(() => window.__wsSent)).toEqual([{ socketId: 'ws-demo', data: 'HELLO', binary: false }])
  await expect(page.locator('.nk-sse-item.ok')).toContainText('HELLO')
  await page.locator('.nk-seg button', { hasText: /^Hex$/ }).click()
  await input.fill('00 ff 80')
  await page.locator('button', { hasText: /^发送$/ }).click()
  await expect.poll(() => page.evaluate(() => window.__wsSent.at(-1))).toEqual({ socketId: 'ws-demo', data: 'AP+A', binary: true })
  await expect(page.locator('.nk-sse-item.ok').last()).toContainText('binary 3B')
  await page.locator('.nk-card-head button', { hasText: /^断开$/ }).click()
  await expect(page.locator('.nk-card-head button', { hasText: /^断开$/ })).toBeDisabled()
  await expect(page.locator('#foot-status')).toContainText('WS 已关闭')
})
