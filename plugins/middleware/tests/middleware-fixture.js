import { expect } from '@playwright/test'
export async function fixture(page, mode = 'shell') {
  await page.addInitScript(({ mode }) => {
    const connections = [
      { id: 'orders', kind: 'kafka', name: '订单消息 · 开发', env: 'dev', bootstrapServers: '127.0.0.1:9092', readOnly: false },
      { id: 'rabbit', kind: 'rabbitmq', name: '任务队列', env: 'test', managementUrl: 'http://127.0.0.1:15672', vhost: '/', readOnly: false },
      { id: 'mqtt', kind: 'mqtt', name: '设备状态', env: 'dev', brokerUrl: 'mqtt://127.0.0.1:1883' },
      { id: 'rocket', kind: 'rocketmq', name: '订单轨迹', env: 'staging', dashboardUrl: 'http://127.0.0.1:8080' }
    ]
    const storage = JSON.parse(sessionStorage.getItem('mw-fixture') || 'null') || { 'mw.connections': connections, 'mw.ui': {} }
    const session = new Map(), events = new Map()
    window.__mwCalls = []; window.__mwSessions = {}; window.__mwStorage = storage; window.__modeChange = () => {}
    window.enest = {
      getLaunchMode: async () => mode, onModeChange: callback => { window.__modeChange = callback },
      onEnter: () => {}, onBeforeClose: () => {}, onDestroy: () => {},
      on: (event, callback) => { if (!events.has(event)) events.set(event, new Set()); events.get(event).add(callback) }, off: (event, callback) => events.get(event)?.delete(callback),
      storage: { get: async key => storage[key], set: async (key, value) => { storage[key] = structuredClone(value); sessionStorage.setItem('mw-fixture', JSON.stringify(storage)); return true }, session: { get: async key => session.get(key), set: async (key, value) => { session.set(key, structuredClone(value)); return true }, remove: async key => session.delete(key) } },
      theme: { getTokens: async () => ({ mode: 'dark', tokens: {} }) },
      ui: { toast: async () => {}, setTitle: async () => {}, openInShell: async () => true }, clipboard: { writeText: async text => { window.__copied = text } },
      mw: { workbench: async ({ action, input }) => {
        window.__mwCalls.push({ action, input: structuredClone(input) })
        if (action === 'session.open') { window.__mwSessions[input.sessionKey] = input.config; return { capabilities: {}, messageQueryModes: input.config.kind === 'kafka' ? ['offset', 'time', 'key'] : [] } }
        if (action === 'session.close') { delete window.__mwSessions[input.sessionKey]; return true }
        if (action === 'kinds.list') return connections.map(connection => ({ kind: connection.kind, capabilities: {} }))
        if (action === 'overview') return { metrics: { topics: 3, messagesInPerSec: 128, totalLag: 9 }, brokers: [{ id: 1, host: 'broker-01.internal:9092', alive: true }] }
        if (action === 'topics.list') return [{ name: 'order-events', partitions: 3, replicas: 1, messageCount: 32 }, { name: 'payment-events', partitions: 2, replicas: 1, messageCount: 12 }]
        if (action === 'topic.create' && !input.topic?.name) throw new Error('Host contract requires input.topic.name')
        if (action === 'exchange.create' && !input.exchange?.name) throw new Error('Host contract requires input.exchange.name')
        if (action === 'messages.resend' && !input.message?.payload) throw new Error('Host contract requires input.message')
        if (action === 'topic.describe') return { partitions: 3 }
        if (action === 'messages.query') {
          const result = { messages: [{ offset: 12345, timestamp: 1760000000000, key: 'order-23942-customer-long-identifier', topic: input.topic, payload: '{"orderId":23942,"customer":{"name":"苏雨"},"items":[{"sku":"N-32","quantity":2}],"status":"created"}', headers: { 'content-type': 'application/json' } }] }
          if (window.__deferQuery) return new Promise(resolve => { window.__resolveQuery = () => resolve(result) })
          if (window.__queryError) throw new Error('Broker 暂时不可用')
          return result
        }
        if (action === 'messages.send') {
          if (window.__mwSessions[input.sessionKey]?.readOnly) throw new Error('只读会话')
          if (window.__deferSend) return new Promise(resolve => { window.__resolveSend = () => resolve({ routed: true }) })
          return { routed: true }
        }
        if (action === 'groups.list') return [{ groupId: 'order-worker', state: 'Stable', members: 2, totalLag: 9 }]
        return { items: [] }
      } }
    }
  }, { mode })
  await page.goto('/plugins/middleware/index.html')
  await expect(page.locator('#nav-toggle')).toBeVisible()
}
export async function openConnection(page, id = 'orders') {
  if (await page.locator('#tree').getAttribute('aria-hidden') === 'true') await page.locator('#nav-toggle').click()
  await page.locator(`[data-connection="${id}"]`).click()
  await expect(page.locator('#subnav [data-page=messages]')).toBeVisible()
}
export async function openPage(page, name) {
  await page.locator(`#subnav [data-page="${name}"]`).click()
  await expect(page.locator(`[data-page-panel="${name}"]:visible`)).toBeVisible()
  return page.locator(`[data-page-panel="${name}"]:visible`)
}
