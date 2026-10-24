const TASK = 'pomodoro'
const STORE = 'pomodoro_journal_v2'
const LEGACY = '_enest_migration.focus-timers-v1'
const LIMIT = 2000
const CHUNK_RECORDS = 64
const bounded = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
const copy = value => structuredClone(value)

export function normalizeOptions(raw = {}) {
  return { focusMin: bounded(raw.focusMin, 25, 1, 180), breakMin: bounded(raw.breakMin, 5, 1, 60),
    longBreakMin: bounded(raw.longBreakMin, 15, 1, 120), longBreakEvery: Math.round(bounded(raw.longBreakEvery, 4, 2, 12)),
    autoStart: raw.autoStart === true, task: typeof raw.task === 'string' ? raw.task.slice(0, 500) : '', notify: raw.notify !== false }
}
export function createPlan(raw) {
  const options = normalizeOptions(raw)
  const steps = []
  for (let cycle = 0; cycle < options.longBreakEvery; cycle++) {
    for (const phase of ['focus', cycle === options.longBreakEvery - 1 ? 'longBreak' : 'break']) {
      const minutes = options[phase === 'focus' ? 'focusMin' : phase === 'break' ? 'breakMin' : 'longBreakMin']
      steps.push({ id: `${phase}-${cycle}`, durationMs: Math.round(minutes * 60000), data: { phase },
        ...(options.notify ? { notification: { title: '番茄钟', body: phase === 'focus' ? '本次专注已完成，休息一下。' : '休息结束，可以开始下一次专注。' } } : {}) })
    }
  }
  return { id: TASK, steps, repeat: true, autoAdvance: options.autoStart, data: { options } }
}
function initial(options = normalizeOptions()) {
  return { status: 'idle', phase: 'focus', remainingMs: options.focusMin * 60000, deadline: null, startedAt: null, cycle: 1, options }
}
export function receiptToRecord(receipt) {
  const phase = receipt.stepData?.phase
  if (!['focus', 'break', 'longBreak'].includes(phase)) return null
  return { id: receipt.id, phase, task: normalizeOptions(receipt.data?.options).task,
    startedAt: receipt.startedAt, endedAt: receipt.endedAt, durationMs: receipt.elapsedMs,
    outcome: receipt.outcome === 'cancelled' ? 'stopped' : receipt.outcome,
    counted: receipt.outcome === 'completed' && phase === 'focus' }
}
function legacyRecords(raw) {
  return (Array.isArray(raw) ? raw : []).filter(record => record && typeof record.id === 'string' && ['focus', 'break', 'longBreak'].includes(record.phase)
    && typeof record.task === 'string' && Number.isFinite(record.durationMs) && Number.isFinite(record.endedAt))
    .slice(0, LIMIT).map(record => ({ ...record, task: record.task.slice(0, 500), durationMs: bounded(record.durationMs, 0, 0, 10800000),
      counted: record.counted === true && record.phase === 'focus' && record.outcome === 'completed' }))
}

/** Host deadlines survive view disposal; all phase policy, history and edits stay here. */
export function createPomodoroController(api) {
  let journal, generic = { task: null, receipts: [] }, serial = Promise.resolve()
  const requireApi = () => {
    if (!api?.deadlineTasks || !api?.storage?.get || !api?.storage?.set) throw Error('请更新 eNest 以使用后台番茄计时')
  }
  const queued = work => { const next = serial.catch(() => {}).then(work); serial = next; return next }
  async function save(next) {
    // Write an inactive bank, then commit its pointer. A closed view cannot expose half a journal.
    const bank = journal?.bank === 'a' ? 'b' : 'a'
    const records = next.records.slice(0, LIMIT)
    const chunks = Math.ceil(records.length / CHUNK_RECORDS)
    for (let i = 0; i < chunks; i++) await api.storage.set(`${STORE}.${bank}.${i}`, records.slice(i * CHUNK_RECORDS, (i + 1) * CHUNK_RECORDS))
    const head = { version: 2, bank, chunks, deleted: next.deleted.slice(-LIMIT), options: next.options, legacyImported: next.legacyImported === true }
    await api.storage.set(STORE, head)
    journal = { ...head, records }
  }
  async function load() {
    requireApi()
    if (journal) return
    const head = await api.storage.get(STORE)
    const records = []
    if (head?.version === 2 && ['a', 'b'].includes(head.bank) && Number.isInteger(head.chunks) && head.chunks >= 0 && head.chunks <= Math.ceil(LIMIT / CHUNK_RECORDS)) {
      for (let i = 0; i < head.chunks; i++) {
        const chunk = await api.storage.get(`${STORE}.${head.bank}.${i}`)
        if (!Array.isArray(chunk)) throw Error('专注记录存储不完整，原数据已保留')
        records.push(...chunk)
      }
      journal = { ...head, options: normalizeOptions(head.options), records: legacyRecords(records), deleted: Array.isArray(head.deleted) ? head.deleted.filter(id => typeof id === 'string').slice(-LIMIT) : [] }
    } else if (head != null) throw Error('专注记录格式异常，原数据已保留')
    else journal = { bank: 'b', records: [], deleted: [], options: normalizeOptions(), legacyImported: false }
  }
  async function migrate() {
    if (journal.legacyImported) return
    const marker = await api.storage.get(LEGACY)
    if (!marker) { await save({ ...journal, legacyImported: true }); return }
    if (marker.version !== 1 || !Number.isInteger(marker.chunks) || marker.chunks < 1 || marker.chunks > 256) throw Error('旧专注记录迁移信息无效，原数据已保留')
    let json = ''
    for (let i = 0; i < marker.chunks; i++) {
      const chunk = await api.storage.get(`${LEGACY}.${i}`)
      if (typeof chunk !== 'string') throw Error('旧专注记录迁移不完整，原数据已保留')
      json += chunk
    }
    const legacy = JSON.parse(json), options = normalizeOptions(legacy?.state?.options)
    if (!legacy?.state || !Array.isArray(legacy.records)) throw Error('旧专注记录格式异常，原数据已保留')
    const records = [...new Map([...legacyRecords(legacy.records), ...journal.records].map(record => [record.id, record])).values()]
      .sort((a, b) => b.endedAt - a.endedAt).slice(0, LIMIT)
    if (!generic.task && ['running', 'paused'].includes(legacy.state.status)) {
      const plan = createPlan(options)
      const cycle = Math.round(bounded(legacy.state.cycle, 1, 1, 100000)) - 1
      const stepIndex = cycle % options.longBreakEvery * 2 + (legacy.state.phase === 'focus' ? 0 : 1)
      generic = await api.deadlineTasks.start({ ...plan, paused: true, cursor: { stepIndex,
        iteration: Math.floor(cycle / options.longBreakEvery), remainingMs: Math.round(bounded(legacy.state.remainingMs, plan.steps[stepIndex].durationMs, 0, plan.steps[stepIndex].durationMs)),
        startedAt: typeof legacy.state.startedAt === 'number' && legacy.state.startedAt > 0 && legacy.state.startedAt <= Date.now() ? Math.floor(legacy.state.startedAt) : null } })
    }
    await save({ ...journal, records, options, legacyImported: true })
  }
  function snapshot() {
    const task = generic.task, options = normalizeOptions(task?.plan?.data?.options || journal.options)
    const state = !task || ['idle', 'completed'].includes(task.status) ? initial(options) : {
      status: task.status, phase: task.plan.steps[task.stepIndex].data.phase,
      remainingMs: task.remainingMs, deadline: task.deadline, startedAt: task.startedAt,
      cycle: task.iteration * options.longBreakEvery + Math.floor(task.stepIndex / 2) + 1, options }
    return copy({ state, records: journal.records })
  }
  async function refresh() {
    await load()
    generic = await api.deadlineTasks.get(TASK)
    await migrate()
    const existing = new Map(journal.records.map(record => [record.id, record])), deleted = new Set(journal.deleted)
    let changed = false
    for (const receipt of generic.receipts) {
      if (existing.has(receipt.id) || deleted.has(receipt.id)) continue
      const record = receiptToRecord(receipt)
      if (record) { existing.set(record.id, record); changed = true }
    }
    if (changed) await save({ ...journal, records: [...existing.values()].sort((a, b) => b.endedAt - a.endedAt).slice(0, LIMIT) })
    return snapshot()
  }
  const operation = method => () => queued(async () => { await refresh(); generic = await api.deadlineTasks[method](TASK); return refresh() })
  return {
    get: () => queued(refresh),
    start: options => queued(async () => { await refresh(); generic = await api.deadlineTasks.start(createPlan(options)); return refresh() }),
    pause: operation('pause'), resume: operation('resume'), skip: operation('skip'), stop: operation('cancel'),
    updateRecord: (id, patch) => queued(async () => {
      await refresh()
      const record = journal.records.find(record => record.id === id)
      if (!record) throw Error('专注记录不存在')
      const next = copy(journal)
      if (patch.deleted === true) { next.records = next.records.filter(record => record.id !== id); next.deleted.push(id) }
      else {
        const target = next.records.find(record => record.id === id)
        if (typeof patch.task === 'string') target.task = patch.task.slice(0, 500)
        if (patch.durationMs !== undefined) {
          if (!Number.isFinite(patch.durationMs) || patch.durationMs < 0 || patch.durationMs > 10800000) throw Error('记录时长超出范围')
          target.durationMs = patch.durationMs
        }
        if (typeof patch.counted === 'boolean') target.counted = patch.counted && target.phase === 'focus' && target.outcome === 'completed'
      }
      await save(next); return snapshot()
    }),
    onChange(callback, onError = () => {}) {
      let disposed = false
      const off = api?.deadlineTasks?.onChange?.(({ taskId }) => {
        if (taskId === TASK) void queued(refresh).then(value => { if (!disposed) callback(value) }, error => { if (!disposed) onError(error) })
      })
      return () => { disposed = true; off?.() }
    },
    flush: () => serial,
  }
}
