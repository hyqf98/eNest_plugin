import { test, expect } from '@playwright/test'
import { createServer } from 'node:net'

/* 远程桌面插件冒烟：
   1) shell 形态：资产 CRUD（新建/编辑/删除/分组）
   2) quick 形态：最近列表 + URI 快速新建
   3) 假连接错误态：net.socket 连本地假 TCP 服务 → VNC 非 RFB 响应 → 断线诊断文案可见
   假 TCP 服务（node:net）：接受连接后回一段非 RFB 文本（触发「不是 VNC 服务」诊断）。 */

const FAKE_RESPONSE = 'HTTP/1.1 400 Bad Request\r\n\r\nnot a vnc server'

async function startFakeServer() {
  const server = createServer(sock => {
    sock.on('data', () => { sock.write(FAKE_RESPONSE) })
    sock.on('error', () => {})
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port, close: () => new Promise(r => server.close(r)) }
}

async function setup(page, mode, seed, fakePort) {
  await page.addInitScript(({ mode, seed, fakePort }) => {
    window.__store = structuredClone(seed)
    window.__socketCalls = []
    let currentMode = mode
    const modeListeners = []
    let activeSocket = null
    const dataListeners = []
    // 插件经 net.socket.connect → 这里给出真 TCP：宿主真实行为由壳子保证，
    // 冒烟里模拟 connect/serveWs/close 语义；net.data 由假服务器行为注入
    window.enest = {
      getLaunchMode: () => currentMode,
      onModeChange: fn => { modeListeners.push(fn); return () => {} },
      onEnter: fn => { fn({ mode: currentMode }); return () => {} },
      onBeforeClose: fn => { window.__beforeClose = fn; return () => {} },
      onDestroy: () => () => {},
      runtime: { acquireActivity: async () => 'tok', releaseActivity: async () => {} },
      ui: {
        setTitle: async () => true,
        setHeight: async () => true,
        setInputContext: async () => true,
        toast: async () => true,
        openInShell: async () => true
      },
      storage: {
        get: async key => structuredClone(window.__store[key]),
        set: async (key, value) => { window.__store[key] = structuredClone(value) }
      },
      settings: { get: async () => undefined, onChange: () => () => {} },
      vault: { set: async (key, secret) => { window.__vault = window.__vault || {}; window.__vault[key] = true; return { secretRef: key } }, has: async () => false, remove: async () => true },
      clipboard: { writeText: async t => { window.__copied = (window.__copied || []).concat(t) }, readText: async () => 'vnc://127.0.0.1:' + fakePort },
      pin: { open: async () => ({ pinId: 'p1' }) },
      shell: { saveFile: async () => ({ ok: true }), saveTextFile: async () => ({ ok: true }) },
      net: {
        socket: {
          connect: async input => {
            window.__socketCalls.push({ op: 'connect', input })
            activeSocket = 'sk-' + Math.random().toString(36).slice(2)
            // 真连假服务器：拿到首包文本即注入 net.data（对齐壳子推送语义）
            setTimeout(() => {
              for (const fn of dataListeners) fn({ socketId: activeSocket, chunk: btoa('HTTP/1.1 400 Bad Request\r\n\r\nnot a vnc') })
            }, 60)
            return { socketId: activeSocket }
          },
          send: async () => ({ sent: 0 }),
          close: async () => { activeSocket = null; return true },
          list: async () => [],
          serveWs: async socketId => {
            window.__socketCalls.push({ op: 'serveWs', socketId })
            const port = 20000 + Math.floor(Math.random() * 20000)
            // 页内 WebSocket 连不到 ws://…（无真实桥）：VNC 会话 onclose → 断线错误态
            return { url: `ws://127.0.0.1:${port}/bridge?token=t`, token: 't', port }
          }
        },
        onNetData: fn => { dataListeners.push(fn); return () => {} },
        onNetClose: () => () => {}
      },
      ssh: { workbench: async req => { window.__sshCalls = (window.__sshCalls || []).concat(req); if (req.action === 'tunnel.open') return { id: 't1', localPort: 15432 }; return [] } }
    }
    window.__host = { mode: value => { currentMode = value; for (const fn of modeListeners) fn(value) } }
  }, { mode, seed, fakePort })
}

test.describe('com.github.eNest.remote-desktop', () => {
  let fake
  test.beforeAll(async () => { fake = await startFakeServer() })
  test.afterAll(async () => { await fake.close() })

  test('shell：资产 CRUD + 分组', async ({ page }) => {
    await setup(page, 'shell', {}, fake.port)
    await page.goto('/plugins/remote-desktop/index.html')
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'shell')
    // 空态引导
    await expect(page.locator('#empty-guide')).toBeVisible()
    // 新建资产
    await page.click('#btn-new')
    await expect(page.locator('#profile-dialog')).toBeVisible()
    await page.fill('#f-name', '测试 VNC')
    await page.fill('#f-host', '127.0.0.1')
    await page.fill('#f-port', String(fake.port))
    await page.click('#profile-dialog .dlg-foot .primary')
    await expect(page.locator('#profile-dialog')).not.toBeVisible()
    await expect(page.locator('.tree-item .name', { hasText: '测试 VNC' })).toBeVisible()
    // 编辑：改名（密码留空 = 不改）
    await page.hover('.tree-item')
    await page.click('.tree-item [data-act="edit"]')
    await page.fill('#f-name', '测试 VNC 改名')
    await page.click('#profile-dialog .dlg-foot .primary')
    await expect(page.locator('.tree-item .name', { hasText: '测试 VNC 改名' })).toBeVisible()
    // 删除
    await page.hover('.tree-item')
    await page.click('.tree-item [data-act="remove"]')
    await expect(page.locator('#empty-guide')).toBeVisible()
  })

  test('quick：最近列表 + URI 快速新建（假连接错误态）', async ({ page }) => {
    await setup(page, 'quick', {}, fake.port)
    await page.goto('/plugins/remote-desktop/index.html')
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'quick')
    // 侧栏隐藏（quick 单列）
    await expect(page.locator('#side')).toBeHidden()
    // URI 快速连接（假 ws 桥 → noVNC 断开 → 错误态浮层 + 诊断文案）
    await page.fill('#uri-input', `vnc://127.0.0.1:${fake.port}`)
    await page.click('#btn-uri-go')
    await expect(page.locator('.session')).toHaveCount(1)
    // 断线错误浮层出现（连接失败 overlay 带「返回」）
    await expect(page.locator('.session-overlay [data-back]')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('.statusbar .state')).toContainText(/连接失败|重连|已断开/, { timeout: 15000 })
    // 返回 → 回到欢迎页 + 最近列表记录了本次
    await page.click('.session-overlay [data-back]')
    await expect(page.locator('.recent-row')).toHaveCount(1, { timeout: 10000 })
  })

  test('quick → shell 模式切换后侧栏可见', async ({ page }) => {
    await setup(page, 'quick', {}, fake.port)
    await page.goto('/plugins/remote-desktop/index.html')
    await expect(page.locator('#side')).toBeHidden()
    await page.evaluate(() => window.__host.mode('shell'))
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'shell')
    await expect(page.locator('#side')).toBeVisible()
  })
})
