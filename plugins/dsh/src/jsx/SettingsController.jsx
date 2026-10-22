import { useCallback, useEffect, useRef, useState } from 'react'

const emptyResource = () => ({ data: null, loading: false, loaded: false, error: '' })
const initialResources = () => Object.fromEntries(
  ['settings', 'profiles', 'versions', 'remote', 'backups', 'logs', 'profile'].map((key) => [key, emptyResource()]),
)

export const errorText = (error) => String(error?.message || error || '操作失败，请重试。')
export const sourceLabel = (source) => ({ data: '本地安装', bundled: '插件内置', system: '系统安装', none: '不可用' })[source] || source || '未提供'
export const versionKey = (version) => `${version.channel || version.source}:${version.version}`
export const listData = (value) => Array.isArray(value) ? value : []

export function formatBytes(value) {
  if (!Number.isFinite(value)) return '大小未提供'
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

export function formatTime(value) {
  if (value == null) return '时间未提供'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未提供' : date.toLocaleString()
}

export function useSettingsController(state) {
  const [section, setSection] = useState('runtime')
  const [resources, setResources] = useState(initialResources)
  const [pending, setPending] = useState(null)
  const [message, setMessage] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const [confirmationError, setConfirmationError] = useState('')
  const [phrase, setPhrase] = useState('')
  const [logKind, setLogKind] = useState('web')
  const alive = useRef(true)
  const operation = useRef(null)
  const requests = useRef({})
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const call = useCallback((action, input = {}) => window.DshApi.call(action, input), [])

  const load = useCallback(async (key, action, input = {}) => {
    const requestId = (requests.current[key] || 0) + 1
    requests.current[key] = requestId
    if (alive.current) setResources((previous) => ({
      ...previous, [key]: { ...previous[key], loading: true, error: '' },
    }))
    try {
      const data = await call(action, input)
      if (alive.current && requests.current[key] === requestId) setResources((previous) => ({
        ...previous, [key]: { data, loading: false, loaded: true, error: '' },
      }))
      return { ok: true, data }
    } catch (error) {
      const text = errorText(error)
      if (alive.current && requests.current[key] === requestId) setResources((previous) => ({
        ...previous, [key]: { ...previous[key], loading: false, loaded: true, error: text },
      }))
      return { ok: false, error: text }
    }
  }, [call])

  const loadSettings = useCallback(() => load('settings', 'settings.get'), [load])
  const loadProfiles = useCallback(() => load('profiles', 'profiles.list'), [load])
  const loadVersions = useCallback(() => load('versions', 'runtime.versions.list'), [load])
  const loadRemote = useCallback(() => load('remote', 'runtime.versions.available', { limit: 20 }), [load])
  const loadBackups = useCallback(() => load('backups', 'backup.list'), [load])
  const loadLogs = useCallback((kind = 'web') => load('logs', 'logs.tail', { kind, lines: 100 }), [load])
  const loadProfile = useCallback((name) => load('profile', 'profiles.read', { name }), [load])

  useEffect(() => {
    void loadSettings()
    void loadProfiles()
  }, [loadSettings, loadProfiles])

  useEffect(() => {
    if (section === 'versions') void loadVersions()
    if (section === 'maintenance') {
      void loadBackups()
      void loadLogs('web')
      setLogKind('web')
    }
  }, [section, loadBackups, loadLogs, loadVersions])

  // The ref locks immediately, before React renders the disabled operation controls.
  const run = useCallback(async (label, task, success) => {
    if (operation.current) return false
    operation.current = label
    if (alive.current) {
      setPending(label)
      setMessage(null)
      setConfirmationError('')
    }
    try {
      await task()
      if (alive.current && success) setMessage({ kind: 'success', text: success })
      return true
    } catch (error) {
      if (alive.current) {
        const text = errorText(error)
        setMessage({ kind: 'error', text: `${label}失败：${text}` })
        setConfirmationError(text)
      }
      return false
    } finally {
      operation.current = null
      if (alive.current) setPending(null)
    }
  }, [])

  const refreshHost = useCallback(async ({ detect = false, sessions = false, settings = false } = {}) => {
    if (detect) await window.DshState.detect()
    await window.DshState.refreshStatus()
    if (sessions) await window.DshState.scanSessions()
    if (settings && window.DshState.loadSettings) await window.DshState.loadSettings()
  }, [])

  const requireLoad = useCallback(async (promise) => {
    const result = await promise
    if (!result.ok) throw new Error(result.error)
    return result.data
  }, [])

  const ask = useCallback((options) => {
    if (operation.current) return
    setPhrase('')
    setConfirmationError('')
    setConfirmation(options)
  }, [])

  const confirm = useCallback(async () => {
    if (!confirmation || (confirmation.phrase && phrase !== confirmation.phrase)) return
    const ok = await run(confirmation.operation || confirmation.title, confirmation.task, confirmation.success)
    if (ok && alive.current) setConfirmation(null)
  }, [confirmation, phrase, run])

  const closeConfirmation = useCallback(() => {
    if (operation.current) return
    setConfirmation(null)
    setConfirmationError('')
    setPhrase('')
  }, [])

  const processAction = useCallback((kind, action) => run(
    `${kind === 'web' ? 'Web' : 'SDK'} ${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}`,
    async () => {
      const service = window.DshState
      if (action === 'start') {
        await (kind === 'web' ? service.ensureWeb() : service.ensureSdk())
      } else {
        const method = `${action}${kind === 'web' ? 'Web' : 'Sdk'}`
        if (typeof service[method] !== 'function') throw new Error('运行控制尚未就绪，请重新打开管理中心。')
        await service[method]()
      }
      await service.refreshStatus()
      const current = service.state || stateRef.current
      const process = current.status?.[kind]
      if (action !== 'stop' && process?.lastError) throw new Error(process.lastError)
      if (action !== 'stop' && kind === 'sdk' && current.sdkError) throw new Error(current.sdkError)
    },
    action === 'stop' ? '进程已停止。' : '运行请求已提交，状态与日志将在此更新。',
  ), [run])

  const refreshRuntime = useCallback(() => run('刷新运行状态', async () => {
    await refreshHost({ detect: true, settings: true })
    await Promise.all([requireLoad(loadSettings()), requireLoad(loadProfiles())])
  }), [run, refreshHost, requireLoad, loadSettings, loadProfiles])

  const saveSettings = useCallback((input) => ask({
    title: '保存并停止运行进程？',
    description: '保存 Profile 或端口设置会停止 Web 与 SDK 进程，正在进行的对话可能中断。设置将在下次手动启动时生效。',
    label: '保存并停止',
    operation: '保存运行设置',
    task: async () => {
      await call('settings.update', input)
      await requireLoad(loadSettings())
      await refreshHost({ settings: true })
    },
    success: '运行设置已保存，Web 与 SDK 已停止。请按需手动启动。',
  }), [ask, call, requireLoad, loadSettings, refreshHost])

  const saveModel = useCallback((input) => ask({
    title: '保存模型路由并停止 SDK？',
    description: '当前 SDK 会话会中断，新模型将在下次手动启动 SDK 时使用。Web 完全体不受影响。',
    label: '保存并停止 SDK', operation: '保存模型路由',
    task: async () => {
      await window.DshState.stopSdk()
      const previous = {
        provider: await window.DshApi.getPref('provider', stateRef.current.prefs?.provider || ''),
        model: await window.DshApi.getPref('model', stateRef.current.prefs?.model || ''),
      }
      await window.DshApi.setPref('provider', input.provider)
      try {
        await window.DshApi.setPref('model', input.model)
      } catch (error) {
        try {
          await window.DshApi.setPref('provider', previous.provider)
        } catch (rollbackError) {
          throw new Error(`${errorText(error)}；恢复 provider 也失败：${errorText(rollbackError)}`)
        }
        throw error
      }
      window.DshState.commit({ prefs: { ...stateRef.current.prefs, ...input } })
    },
    success: '模型路由已保存，SDK 保持停止，下次手动启动后生效。Web 不受影响。',
  }), [ask])

  const selectLogs = useCallback((kind) => run('读取进程日志', async () => {
    setLogKind(kind)
    await requireLoad(loadLogs(kind))
  }), [run, requireLoad, loadLogs])

  return {
    section, setSection, resources, pending, message, setMessage,
    confirmation, phrase, setPhrase, confirmationError, ask, confirm, closeConfirmation,
    call, run, requireLoad, refreshHost, refreshRuntime, processAction, saveSettings, saveModel,
    loadSettings, loadProfiles, loadVersions, loadRemote, loadBackups, loadLogs, loadProfile,
    logKind, selectLogs,
  }
}
