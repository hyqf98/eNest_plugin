/**
 * com.enest.ccswitch — 全量快照：导出 / 导入恢复
 * 范围：插件自管数据（providers / order / mcp / projects / 设置镜像）。
 * 密钥范围（安全取舍）：
 * - 供应商密钥本体保存在宿主 vault（无明文导出通道），导出内容只含 secretRef 引用；
 * - 导出 JSON 顶部 scope 字段明确标注「不含密钥明文」，导入时 secretRef 原样保留（同一数据根可用，
 *   跨机器需在编辑表单重新录入密钥，UI 导入完成提示会说明）。
 * 兼容：接受本插件全量格式（format: enest.ccswitch.full）或旧供应商格式（providers 数组 / payload.providers）。
 * 命名空间挂 window.CCS.snapshot。
 */
;(function (global) {
  const A = global.CCS.api
  const P = global.CCS.providers
  const M = global.CCS.mcp

  const KEYS = {
    providers: 'ccswitch.providers.v1',
    order: 'ccswitch.provider-order.v1',
    mcp: 'ccswitch.mcp.v1',
    projects: 'ccswitch.projects.v1'
  }

  /** 导出全量 payload（含脱敏说明与各 storage 段原样数据） */
  async function exportAll() {
    const [providers, order, mcp, projects] = await Promise.all([
      A.storageGet(KEYS.providers, []),
      A.storageGet(KEYS.order, []),
      A.storageGet(KEYS.mcp, []),
      A.storageGet(KEYS.projects, [])
    ])
    return {
      format: 'enest.ccswitch.full',
      version: 1,
      exportedAt: new Date().toISOString(),
      scope: {
        secrets: 'excluded',
        note: '不含密钥明文：API Key 保存在宿主保险库，导出仅含 secretRef 引用；跨环境导入后需重新录入密钥'
      },
      data: {
        providers: Array.isArray(providers) ? providers : [],
        providerOrder: Array.isArray(order) ? order : [],
        mcp: Array.isArray(mcp) ? mcp : [],
        projects: Array.isArray(projects) ? projects : []
      }
    }
  }

  /**
   * 导入恢复：
   * - full 格式：整段覆盖（可传 merge:true 改为按 name 去重合并）
   * - 旧格式（{providers:[…]}）：走 providers.importPayload
   * 返回 { mode, providers: {added, skipped}, mcp, projects }
   */
  async function importAll(payload, { merge = false } = {}) {
    if (!payload || typeof payload !== 'object') throw new Error('无效的快照 JSON')
    if (payload.format === 'enest.ccswitch.full' && payload.data) {
      const d = payload.data
      const result = { mode: merge ? 'merge' : 'overwrite', providers: { added: 0, skipped: 0 }, mcp: 0, projects: 0 }
      // 供应商：统一走 importPayload（含去重/字段归一），覆盖模式先清空
      const existing = (await A.storageGet(KEYS.providers, [])) || []
      if (!merge && existing.length) {
        // 覆盖：先清 vault 旧引用（避免悬挂），清空 storage，并重置模块内存缓存，
        // 否则 providers/mcp 的进程内缓存会让 importPayload 的同名去重误判
        for (const p of existing) {
          if (p.secretRef) { try { await A.vaultRemove(p.secretRef) } catch { /* best-effort */ } }
        }
        await A.storageSet(KEYS.providers, [])
        await A.storageSet(KEYS.order, [])
        P.resetCache?.()
        M.resetCache?.()
      }
      const list = Array.isArray(d.providers) ? d.providers : []
      if (merge && list.length) {
        const names = new Set(existing.map(p => p.name))
        for (const p of list) if (names.has(p.name)) p.__dup = true
      }
      const res = await P.importPayload({ providers: list.filter(p => !p.__dup) })
      result.providers = { ...res, restoredOrder: Array.isArray(d.providerOrder) ? d.providerOrder.length : 0 }
      // MCP / 项目：覆盖模式整段替换；合并模式按 id 去重追加
      if (Array.isArray(d.mcp)) {
        if (merge) {
          const cur = (await A.storageGet(KEYS.mcp, [])) || []
          const ids = new Set(cur.map(e => e.id))
          const add = d.mcp.filter(e => e && e.id && !ids.has(e.id))
          await A.storageSet(KEYS.mcp, cur.concat(add))
          result.mcp = add.length
        } else {
          await A.storageSet(KEYS.mcp, d.mcp)
          result.mcp = d.mcp.length
        }
      }
      if (Array.isArray(d.projects)) {
        if (merge) {
          const cur = (await A.storageGet(KEYS.projects, [])) || []
          const ids = new Set(cur.map(e => e.id))
          const add = d.projects.filter(e => e && e.id && !ids.has(e.id))
          await A.storageSet(KEYS.projects, cur.concat(add))
          result.projects = add.length
        } else {
          await A.storageSet(KEYS.projects, d.projects)
          result.projects = d.projects.length
        }
      }
      return result
    }
    // 旧格式兼容
    const res = await P.importPayload(payload)
    return { mode: 'legacy', providers: res, mcp: 0, projects: 0 }
  }

  global.CCS = global.CCS || {}
  global.CCS.snapshot = { KEYS, exportAll, importAll }
})(window)
