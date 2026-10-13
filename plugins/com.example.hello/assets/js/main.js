/**
 * main.js — Hello 示例插件入口
 * 设置项读取（contributes.settings 声明的 key）：
 * - greeting：启动问候语，渲染到 h1
 * - fontSize：展示字号（12–28），应用到 .app 根节点
 * 计数迁移：helloCount 走 api.storage KV（storage.local 权限），
 * 不再占用 settings 通道（settings.get/set 仅限注册过的设置项）。
 */
async function boot() {
  const api = window.enest || window.zapi
  const out = document.getElementById('out')
  if (!api) {
    out.textContent = 'eNest API 不可用（浏览器直开）'
    return
  }
  try {
    await api.ui.setTitle('Hello')
  } catch {
    /* 权限未声明时忽略 */
  }

  // —— 声明式设置项：greeting（问候语）与 fontSize（展示字号）——
  let greeting = '你好，eNest！'
  let fontSize = 14
  try {
    const g = await api.settings.get('greeting')
    if (typeof g === 'string' && g) greeting = g
    const f = await api.settings.get('fontSize')
    const n = Number(f)
    if (Number.isFinite(n) && n >= 12 && n <= 28) fontSize = n
  } catch {
    /* 设置项未注册 / 宿主不支持时用默认值 */
  }
  document.querySelector('.app h1').textContent = greeting
  document.querySelector('.app').style.fontSize = fontSize + 'px'

  // —— 打开次数：storage KV（迁移自 settings.get/set）——
  const readCount = async () => Number((await api.storage.get('helloCount')) || 0)
  out.textContent = `打开次数（storage）: ${await readCount()}`

  document.getElementById('btn').onclick = async () => {
    // 每次点击重新读取当前值（闭包缓存的 count 只反映打开时的快照）
    const next = (await readCount()) + 1
    try {
      await api.storage.set('helloCount', next)
      out.textContent = `打开次数（storage）: ${next}`
    } catch (e) {
      out.textContent = String(e.message || e)
    }
  }
}

void boot()
