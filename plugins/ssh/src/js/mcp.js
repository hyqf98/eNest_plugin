/**
 * com.github.eNest.ssh — MCP 工具处理器注册（读 + 写完整工具面）
 *
 * handler 键集合必须与 plugin.json contributes.mcpTools 完全一致（宿主注册握手逐一对比，
 * 不符即拒绝），修改两侧时同步增删。app.js 的 boot 在 store.loadAll() 完成后调用
 * registerSshMcp()：注册不等页面可见（MCP 冷启动页面是隐藏的，也没有 onEnter）。
 *
 * 安全约束（docs/developer/mcp.md）：
 * - 执行阶段限时 60s、结果 ≤1MiB；exec 与 files.read/docker logs 在这里兜底截断，
 *   截断时置 truncated 标记让调用方收窄范围。
 * - 绝不弹交互框：connect 不走 completePayloadCredentials（缺密码会 promptDialog），
 *   凭据必须已存 vault（profile.secretRef）或由调用方一次性传 ephemeralSecret（不落盘）。
 * - process.signal / service.action / docker.action(start|stop|restart) 必须 confirmed:true。
 * - 隧道仅绑定回环地址，由后端保证；这里只透传参数。
 */

;(function (global) {
  const TEXT_CAP = 700 * 1024 // 单段文本截断线：给 1MiB JSON 封装留余量
  const EXEC_CAP = 400 * 1024 // exec 的 stdout+stderr 共享预算（两段合计须低于 TEXT_CAP）
  const LIST_CAP = 2000 // system.* / sftp.list 条目上限，超出截断并标记

  const lastSession = { sessionId: '' } // connect 成功后记录默认会话，供后续工具省略 sessionId

  const ok = (text, structured) => ({
    content: [{ type: 'text', text }],
    ...(structured !== undefined ? { structuredContent: structured } : {}),
  })

  const err = (message) => ({ isError: true, content: [{ type: 'text', text: message }] })

  /** 动作函数 → handler：业务校验失败与远端错误统一为 isError 文本 */
  function wrap(run) {
    return async (args) => {
      try {
        return await run(args || {})
      } catch (error) {
        return err('执行失败：' + String((error && error.message) || error || '未知错误'))
      }
    }
  }

  function str(value, max) {
    if (value == null) return ''
    const text = typeof value === 'string' ? value : String(value)
    return max ? text.slice(0, max) : text
  }

  /** 截断长文本：返回 { text, truncated } */
  function capText(value) {
    const text = String(value ?? '')
    return text.length > TEXT_CAP ? { text: text.slice(0, TEXT_CAP), truncated: true } : { text, truncated: false }
  }

  /** 按 cap 截断字符串并报告实际用量 */
  function takeShare(value, cap, used) {
    const text = String(value ?? '')
    const room = Math.max(0, cap - used)
    return { text: text.slice(0, room), truncated: text.length > room, length: text.length }
  }

  /** 列表截断：返回 { items, truncated } */
  function capList(value) {
    const items = Array.isArray(value) ? value : []
    return items.length > LIST_CAP ? { items: items.slice(0, LIST_CAP), truncated: true } : { items, truncated: false }
  }

  function ensureSession(args) {
    const sessionId = str(args.sessionId, 128) || lastSession.sessionId
    if (!sessionId) throw new Error('当前没有已连接的 SSH 会话，请先调用 connect')
    return sessionId
  }

  /**
   * 校验连接凭据（绝不走 promptDialog / pickLocalFile）：
   * password / keyboard-interactive 需要 secretRef 或本次传入的 ephemeralSecret；
   * key 需要 privateKeyHandleId（宿主已授权句柄）或口令 secretRef / ephemeralSecret；agent 免凭据。
   */
  function requireCredential(profile, ephemeralSecret) {
    const authType = profile.authType || 'password'
    if (authType === 'agent') return
    const label = '连接「' + (profile.name || profile.host) + '」'
    if (authType === 'password' || authType === 'keyboard-interactive') {
      if (!profile.secretRef && !ephemeralSecret) {
        throw new Error(
          label + '尚未保存登录密码，MCP 不能弹窗询问。' +
          '请让用户先在 SSH 插件界面打开该连接保存密码，或在 connect 参数中一次性传入 ephemeralSecret（仅本次连接使用，不落盘）'
        )
      }
    } else if (authType === 'key') {
      if (!profile.privateKeyHandleId && !profile.secretRef && !ephemeralSecret) {
        throw new Error(label + '使用私钥认证，但私钥尚未经宿主选择授权。请让用户先在 SSH 插件界面选择并授权私钥文件')
      }
    }
  }

  /** 与 app.js buildConnectPayload 同构的最小负载：只传 secretRef / ephemeralSecret，绝不落明文 */
  function buildPayload(profile, ephemeralSecret) {
    const payload = {
      profileId: profile.id,
      host: profile.host,
      port: Number(profile.port) || 22,
      username: profile.username,
      authType: profile.authType || 'password',
      secretRef: profile.secretRef || undefined,
      privateKeyHandleId: profile.privateKeyHandleId || undefined,
      proxy: profile.proxy?.host ? { ...profile.proxy } : undefined,
      keepAliveSec: Number(profile.keepAliveSec) || 30,
      timeoutMs: Math.min(Number(profile.timeoutMs) || 20000, 55000),
      term: profile.term || 'xterm-256color',
      cols: Number(profile.cols) || 120,
      rows: Number(profile.rows) || 32,
      fingerprintPolicy: profile.fingerprintPolicy || 'tofu',
    }
    if (ephemeralSecret) payload.ephemeralSecret = ephemeralSecret
    if (profile.jump?.host) {
      payload.jump = {
        host: profile.jump.host,
        port: Number(profile.jump.port) || 22,
        username: profile.jump.username || profile.username,
        authType: profile.jump.authType || 'password',
        privateKeyHandleId: profile.jump.privateKeyHandleId || undefined,
        secretRef: profile.jump.secretRef || undefined,
      }
    }
    if (Array.isArray(profile.jumps) && profile.jumps.length) {
      payload.jumps = profile.jumps.map((hop) => ({
        host: hop.host, port: hop.port, username: hop.username, authType: hop.authType,
        privateKeyHandleId: hop.privateKeyHandleId || undefined, secretRef: hop.secretRef || undefined,
      }))
    }
    return payload
  }

  /** 档案脱敏视图：去掉敏感字段与 secretRef 值本身，只留 hasCredential 布尔 */
  function publicProfile(profile) {
    const view = { ...(profile || {}) }
    delete view.password; delete view.passphrase; delete view.ephemeralSecret
    delete view.privateKeyPath; delete view.agentPath
    const mark = (hop) => {
      if (!hop || typeof hop !== 'object') return hop
      const next = { ...hop }
      delete next.password; delete next.passphrase; delete next.privateKeyPath; delete next.agentPath
      if (next.secretRef) next.hasCredential = true
      delete next.secretRef
      return next
    }
    if (view.secretRef) view.hasCredential = true
    delete view.secretRef
    if (view.jump) view.jump = mark(view.jump)
    if (Array.isArray(view.jumps)) view.jumps = view.jumps.map(mark)
    if (view.proxy) view.proxy = mark(view.proxy)
    return view
  }

  /** workbench 复合通道：host.ssh.workbench({ action, sessionId, ...values }) */
  function workbench(api, action, values) {
    const raw = api.raw
    if (!raw?.ssh?.workbench) throw new Error('请更新 eNest 以使用 SSH 工作台')
    return raw.ssh.workbench({ action, ...values })
  }

  function requireConfirmed(args, what) {
    if (args.confirmed !== true) {
      throw new Error('该操作需要确认：请核对目标后以 confirmed:true 重新调用（' + what + '）')
    }
  }

  const handlers = {
    /* —— 连接档案（前端 storage，脱敏） —— */
    'profiles.list': wrap(async () => {
      const store = global.SshStore
      const profiles = store.state.profiles.map(publicProfile)
      return ok('共 ' + profiles.length + ' 个已保存连接', { profiles })
    }),

    'profile.save': wrap(async (args) => {
      const store = global.SshStore
      const profileId = str(args.profileId, 64)
      const existing = profileId ? store.findProfile(profileId) : null
      if (profileId && !existing) throw new Error('连接 ' + profileId + ' 不存在；省略 profileId 可新建')
      const authType = args.authType || existing?.authType || 'password'
      if (args.authType && existing && args.authType !== (existing.authType || 'password')) {
        throw new Error('不能通过 MCP 更换认证方式（会丢弃已保存凭据）。请在插件界面编辑该连接的认证方式')
      }
      if (args.secretRef && authType === 'agent') throw new Error('SSH Agent 认证不需要 secretRef')
      const profile = {
        ...(existing || {}),
        id: existing?.id || store.uid('prof'),
        name: str(args.name ?? existing?.name, 120) || 'SSH 连接',
        host: str(args.host ?? existing?.host, 255),
        port: Number(args.port ?? existing?.port) || 22,
        username: str(args.username ?? existing?.username, 64),
        authType,
        secretRef: str(args.secretRef ?? existing?.secretRef, 128) || undefined,
        env: args.env ?? existing?.env ?? 'dev',
        tags: Array.isArray(args.tags)
          ? [...new Set(args.tags.map((t) => str(t, 40)).filter(Boolean))].slice(0, 20)
          : (existing?.tags || []),
        note: str(args.note ?? existing?.note, 500) || '',
        keepAliveSec: Number(args.keepAliveSec ?? existing?.keepAliveSec) || 30,
        timeoutMs: Number(args.timeoutMs ?? existing?.timeoutMs) || 20000,
        fingerprintPolicy: args.fingerprintPolicy ?? existing?.fingerprintPolicy ?? 'tofu',
        groupId: str(args.groupId ?? existing?.groupId, 64) || '',
        lastConnectedAt: existing?.lastConnectedAt,
      }
      if (!profile.host || !profile.username) throw new Error('缺少主机或用户名')
      if (!await store.upsertProfile(profile)) throw new Error('保存失败：连接档案写入未成功')
      const hasCredential = Boolean(profile.secretRef) || authType === 'agent'
      return ok(
        (existing ? '已更新连接「' : '已创建连接「') + profile.name + '」（' + profile.id + '）' +
        (hasCredential ? '' : '；注意：尚未绑定凭据，connect 前需在插件界面保存密码或使用 ephemeralSecret'),
        { profileId: profile.id, created: !existing, hasCredential }
      )
    }),

    'profile.delete': wrap(async (args) => {
      const store = global.SshStore
      const api = global.SshApi
      const id = str(args.profileId, 64)
      const profile = store.findProfile(id)
      if (!profile) throw new Error('连接不存在：' + id)
      if (!await store.removeProfile(profile.id)) throw new Error('删除失败：连接档案写入未成功')
      if (profile.secretRef) {
        try { await api.vaultRemove(profile.secretRef) } catch { /* vault 清理尽力而为 */ }
      }
      return ok('已删除连接「' + (profile.name || profile.host) + '」', { profileId: profile.id, deleted: true })
    }),

    /* —— 会话 —— */
    connect: wrap(async (args) => {
      const store = global.SshStore
      const api = global.SshApi
      if (!api.hasHostSsh()) throw new Error('功能未就绪：SSH 宿主不可用')
      const profileId = str(args.profileId, 64)
      const ephemeralSecret = args.ephemeralSecret == null ? '' : String(args.ephemeralSecret).slice(0, 1024)
      let profile
      if (profileId) {
        profile = store.findProfile(profileId)
        if (!profile) throw new Error('连接档案不存在：' + profileId + '，先调用 profile.save 或用 profiles.list 查询')
      } else {
        const host = str(args.host, 255)
        const username = str(args.username, 64)
        if (!host || !username) throw new Error('缺少 profileId 时必须提供 host 与 username')
        profile = {
          id: '', // 内联连接不落档案
          host,
          port: Number(args.port) || 22,
          username,
          authType: args.authType || 'password',
          secretRef: str(args.secretRef, 128) || undefined,
          timeoutMs: 20000,
        }
      }
      requireCredential(profile, ephemeralSecret)
      const payload = buildPayload(profile, ephemeralSecret)
      const res = await api.sshConnect(payload)
      const sessionId = res && (res.sessionId || res.id || res.sessionID)
      if (!sessionId) throw new Error('ssh.connect 未返回 sessionId')
      lastSession.sessionId = String(sessionId)
      const authType = profile.authType || 'password'
      return ok(
        '已连接 ' + profile.username + '@' + profile.host +
        (profile.port && profile.port !== 22 ? ':' + profile.port : '') + '（sessionId: ' + sessionId + '）',
        {
          sessionId: String(sessionId),
          profileId: profile.id || null,
          host: profile.host,
          username: profile.username,
          authType,
          credentialSource: ephemeralSecret ? 'ephemeralSecret' : (profile.secretRef ? 'vault' : 'agent'),
        }
      )
    }),

    disconnect: wrap(async (args) => {
      const api = global.SshApi
      const sessionId = str(args.sessionId, 128) || lastSession.sessionId
      if (!sessionId) throw new Error('当前没有可断开的 SSH 会话')
      await api.sshDisconnect(sessionId)
      if (lastSession.sessionId === sessionId) lastSession.sessionId = ''
      return ok('已断开会话 ' + sessionId, { sessionId, disconnected: true })
    }),

    'sessions.list': wrap(async () => {
      const api = global.SshApi
      const sessions = await api.sshListSessions()
      const list = Array.isArray(sessions) ? sessions : []
      return ok('共 ' + list.length + ' 个 SSH 会话', { sessions: list, defaultSessionId: lastSession.sessionId || null })
    }),

    /* —— 执行 —— */
    exec: wrap(async (args) => {
      const api = global.SshApi
      const sessionId = ensureSession(args)
      const command = str(args.command, 65536)
      if (!command) throw new Error('缺少 command')
      const timeoutMs = Math.min(Number(args.timeoutMs) || 30000, 55000)
      const result = await api.sshExec(sessionId, command, { timeoutMs })
      // stdout 与 stderr 共享预算：单段最多 400KB，两段合计不超过 800KB，低于 1MiB 封装线
      const out = takeShare(result.stdout || '', EXEC_CAP, 0)
      const errorOut = takeShare(result.stderr || '', EXEC_CAP, out.text.length)
      const truncated = out.truncated || errorOut.truncated
      return ok(
        'exit ' + (result.exitCode == null ? '?' : result.exitCode) + ' · ' + (result.durationMs || 0) + 'ms' +
        (truncated ? ' · 输出已截断（stdout ' + out.length + ' / stderr ' + errorOut.length + ' 字符，请用 head/tail 分段）' : ''),
        {
          sessionId,
          command: command.length > 200 ? command.slice(0, 200) + '…' : command,
          stdout: out.text,
          stdoutTruncated: out.truncated,
          stderr: errorOut.text,
          stderrTruncated: errorOut.truncated,
          exitCode: result.exitCode ?? null,
          durationMs: result.durationMs || 0,
        }
      )
    }),

    /* —— SFTP —— */
    'sftp.list': wrap(async (args) => {
      const api = global.SshApi
      const sessionId = ensureSession(args)
      const path = str(args.path, 1024) || '.'
      const entries = await api.sftpList(sessionId, path)
      const capped = capList(entries)
      return ok(path + ' 共 ' + capped.items.length + ' 项' + (capped.truncated ? '（超出 ' + LIST_CAP + ' 条已截断，请用更深的子目录缩小范围）' : ''), {
        sessionId, path, entries: capped.items, truncated: capped.truncated, total: Array.isArray(entries) ? entries.length : 0,
      })
    }),

    'sftp.mkdir': wrap(async (args) => {
      const api = global.SshApi
      const sessionId = ensureSession(args)
      const path = str(args.path, 1024)
      if (!path) throw new Error('缺少 path')
      await api.sftpMkdir(sessionId, path)
      return ok('已创建目录 ' + path, { sessionId, path, created: true })
    }),

    'sftp.rename': wrap(async (args) => {
      const api = global.SshApi
      const sessionId = ensureSession(args)
      const path = str(args.path, 1024), newPath = str(args.newPath, 1024)
      if (!path || !newPath) throw new Error('缺少 path 或 newPath')
      await api.sftpRename(sessionId, path, newPath)
      return ok('已重命名 ' + path + ' → ' + newPath, { sessionId, path, newPath, renamed: true })
    }),

    'sftp.delete': wrap(async (args) => {
      const api = global.SshApi
      const sessionId = ensureSession(args)
      const path = str(args.path, 1024)
      const recursive = args.recursive === true
      if (!path) throw new Error('缺少 path')
      await api.sftpDelete(sessionId, path, recursive)
      return ok('已删除 ' + path + (recursive ? '（递归）' : ''), { sessionId, path, recursive, deleted: true })
    }),

    'sftp.chmod': wrap(async (args) => {
      const api = global.SshApi
      const sessionId = ensureSession(args)
      const path = str(args.path, 1024), mode = str(args.mode, 8)
      if (!path || !/^0?[0-7]{3,4}$/.test(mode)) throw new Error('缺少 path 或 mode 格式无效（应为八进制，如 0644）')
      await api.sftpChmod(sessionId, path, mode)
      return ok('已将 ' + path + ' 权限改为 ' + mode, { sessionId, path, mode, changed: true })
    }),

    /* —— 工作台能力（host.ssh.workbench 复合通道） —— */
    system: wrap(async (args) => {
      const api = global.SshApi
      const sessionId = ensureSession(args)
      const action = str(args.action, 32)
      if (!['snapshot', 'processes', 'ports', 'services', 'docker'].includes(action)) {
        throw new Error('action 必须是 snapshot/processes/ports/services/docker')
      }
      const data = await workbench(api, 'system.' + action, { sessionId })
      const capped = capList(data)
      return ok('system.' + action + ' · ' + capped.items.length + ' 项' + (capped.truncated ? '（超出 ' + LIST_CAP + ' 条已截断）' : ' · 完成'), {
        sessionId, action, data: capped.items, truncated: capped.truncated,
      })
    }),

    'files.read': wrap(async (args) => {
      const api = global.SshApi
      const sessionId = ensureSession(args)
      const path = str(args.path, 1024)
      if (!path) throw new Error('缺少 path')
      const file = await workbench(api, 'files.read', { sessionId, path })
      const capped = capText(file.content ?? '')
      return ok(
        path + ' · ' + capped.text.length + ' 字符 · sha256 ' + str(file.hash, 16) + '…' + (capped.truncated ? ' · 已截断，可用 exec 分段读取' : ''),
        {
          sessionId, path,
          content: capped.text,
          truncated: capped.truncated,
          omittedCharacters: capped.truncated ? String(file.content ?? '').length - TEXT_CAP : 0,
          hash: file.hash,
          mtime: file.mtime,
        }
      )
    }),

    'files.write': wrap(async (args) => {
      const api = global.SshApi
      const sessionId = ensureSession(args)
      const path = str(args.path, 1024)
      const content = args.content == null ? '' : String(args.content)
      if (!path) throw new Error('缺少 path')
      if (content.length > 2 * 1024 * 1024) throw new Error('内容超过 2MB 上限')
      const expectedHash = str(args.expectedHash, 128) || undefined
      const overwrite = args.overwrite === true
      if (args.expectedHash != null && !expectedHash) throw new Error('expectedHash 格式无效')
      const result = await workbench(api, 'files.write', { sessionId, path, content, expectedHash, overwrite })
      return ok(
        '已写入 ' + path + ' · 新 sha256 ' + str(result?.hash, 16) + '…',
        { sessionId, path, hash: result?.hash, bytes: content.length }
      )
    }),

    'process.signal': wrap(async (args) => {
      const api = global.SshApi
      const sessionId = ensureSession(args)
      requireConfirmed(args, '结束进程 PID ' + args.pid)
      const pid = Number(args.pid)
      const startTime = str(args.startTime, 64)
      if (!Number.isInteger(pid) || pid <= 1 || !startTime) throw new Error('需要有效的 pid（>1）与进程列表返回的 startTime')
      const signal = args.signal === 'KILL' ? 'KILL' : 'TERM'
      await workbench(api, 'process.signal', { sessionId, pid, startTime, signal, confirmed: true })
      return ok('已向 PID ' + pid + ' 发送 SIG' + signal, { sessionId, pid, signal, sent: true })
    }),

    'service.action': wrap(async (args) => {
      const api = global.SshApi
      const sessionId = ensureSession(args)
      requireConfirmed(args, '服务操作 ' + args.operation + ' ' + args.name)
      const name = str(args.name, 256), operation = str(args.operation, 16)
      if (!name || !['start', 'stop', 'restart'].includes(operation)) throw new Error('需要服务名与 start/stop/restart 操作')
      await workbench(api, 'service.action', { sessionId, name, operation, confirmed: true })
      return ok('已对服务 ' + name + ' 执行 ' + operation, { sessionId, name, operation, done: true })
    }),

    'docker.action': wrap(async (args) => {
      const api = global.SshApi
      const sessionId = ensureSession(args)
      const id = str(args.id, 64), operation = str(args.operation, 16)
      if (!id || !/^[a-f0-9]{12,64}$/.test(id)) throw new Error('需要 docker 列表返回的 12-64 位十六进制容器 id')
      if (!['start', 'stop', 'restart', 'logs', 'inspect'].includes(operation)) {
        throw new Error('operation 必须是 start/stop/restart/logs/inspect')
      }
      const mutating = operation !== 'logs' && operation !== 'inspect'
      if (mutating) requireConfirmed(args, '容器操作 ' + operation + ' ' + id)
      const result = await workbench(api, 'docker.action', { sessionId, id, operation, confirmed: mutating || undefined })
      if (!mutating) {
        const text = typeof result === 'string' ? result : JSON.stringify(result ?? null)
        const capped = capText(text)
        return ok('容器 ' + id + ' ' + operation + (capped.truncated ? '（已截断）' : ''), {
          sessionId, id, operation, output: capped.text, truncated: capped.truncated,
        })
      }
      return ok('已对容器 ' + id + ' 执行 ' + operation, { sessionId, id, operation, done: true })
    }),

    'tunnel.open': wrap(async (args) => {
      const api = global.SshApi
      const sessionId = ensureSession(args)
      const direction = args.direction === 'remote' ? 'remote' : 'local'
      const localPort = Number(args.localPort)
      const remotePort = Number(args.remotePort)
      const remoteHost = str(args.remoteHost, 255) || '127.0.0.1'
      if (!Number.isInteger(localPort) || localPort < (direction === 'local' ? 0 : 1) || localPort > 65535) {
        throw new Error('localPort 无效（local 方向可用 0 自动分配）')
      }
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error('remotePort 无效')
      const tunnel = await workbench(api, 'tunnel.open', { sessionId, direction, localPort, remotePort, remoteHost })
      return ok(
        '已建立' + (direction === 'local' ? '本地' : '反向') + '隧道：127.0.0.1:' + tunnel.localPort +
        ' → ' + tunnel.remoteHost + ':' + tunnel.remotePort + '（仅绑定回环地址）',
        { tunnel }
      )
    }),

    'tunnel.list': wrap(async () => {
      const api = global.SshApi
      const tunnels = await workbench(api, 'tunnel.list', {})
      const list = Array.isArray(tunnels) ? tunnels : []
      return ok('共 ' + list.length + ' 条隧道', { tunnels: list })
    }),

    'tunnel.close': wrap(async (args) => {
      const api = global.SshApi
      const id = str(args.id, 128)
      if (!id) throw new Error('缺少隧道 id（来自 tunnel.list）')
      await workbench(api, 'tunnel.close', { id })
      return ok('已关闭隧道 ' + id, { id, closed: true })
    }),
  }

  /** app.js boot 在 store.loadAll() 成功后调用一次；返回注册是否成功 */
  function registerSshMcp() {
    const api = global.enest
    if (!api?.mcp?.registerHandlers) return Promise.resolve(false)
    return api.mcp.registerHandlers(handlers).then(() => true)
  }

  global.SshMcp = { registerSshMcp }
})(window)
