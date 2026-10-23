/**
 * 批量重命名主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 业务核心 applyRules/hasBlocked 复用 core.mjs（未改动）；
 * fs.renameBatch / localFiles.fromDrop / localFiles.pick 调用管线原样保留。
 * 规则链每条规则的参数控件用受控原生元素（select/input/checkbox 由 kit upgradeSelects 接管外观）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { applyRules, hasBlocked } from '../js/core.mjs'

const api = window.enest || window.zapi

const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
// 公共前缀 / 后缀长度：diff 高亮用（只在两侧同展布时稳定）
const commonPrefix = (a, b) => {
  let i = 0
  const n = Math.min(a.length, b.length)
  while (i < n && a[i] === b[i]) i++
  return i
}
const commonSuffix = (a, b) => {
  let i = 0
  const n = Math.min(a.length, b.length) - commonPrefix(a, b)
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}

const RULE_LABEL = {
  replace: '查找替换', number: '序号', date: '日期', case: '大小写',
  insert: '插入', remove: '删除', ext: '扩展名',
}

function ruleTemplate(type) {
  switch (type) {
    case 'replace': return { type, find: '', replaceWith: '', caseSensitive: false, regex: false }
    case 'number': return { type, start: 1, step: 1, width: 2, position: 'prefix', separator: '_', keepBase: true }
    case 'date': return { type, source: 'mtime', pattern: 'YYYYMMDD', position: 'suffix', separator: '_' }
    case 'case': return { type, mode: 'upper' }
    case 'insert': return { type, text: '', position: 'head', at: 0 }
    case 'remove': return { type, position: 'start', start: 0, length: 1 }
    case 'ext': return { type, ext: '' }
    default: return null
  }
}

/* —— 预览名 diff 高亮（等价原 renderName：公共前后缀淡化、变化段着色） —— */
function PvName({ name, diff = false, against = '' }) {
  if (!diff || name === against) return <span className="pv-name" title={name}>{name}</span>
  const pre = commonPrefix(against, name)
  const suf = commonSuffix(against, name)
  const midTo = name.length - suf
  return (
    <span className="pv-name pv-new" title={name}>
      {pre > 0 ? <span className="pv-same">{name.slice(0, pre)}</span> : null}
      <span className="pv-diff">{name.slice(pre, midTo)}</span>
      {suf > 0 ? <span className="pv-same">{name.slice(midTo)}</span> : null}
    </span>
  )
}

export function App() {
  const kitRef = useRef(null)
  const appRef = useRef(null)
  const dropZoneRef = useRef(null)
  const dialogRef = useRef(null)
  const ruleAddRef = useRef(null)

  /* —— 与原版 state 对象等价 —— */
  const [files, setFiles] = useState([]) // { handleId, name, size, dir }
  const [rules, setRules] = useState([]) // 规则链（core.mjs 结构 + UI 状态）
  const [rows, setRows] = useState([]) // 预览行
  const [lastRun, setLastRun] = useState(null) // 撤销映射
  const [status, setStatus] = useState('')
  const [ruleError, setRuleError] = useState('')
  const [runDisabled, setRunDisabled] = useState(true)
  const [previewMeta, setPreviewMeta] = useState('')
  const [undoHidden, setUndoHidden] = useState(true)
  const [clearQueueHidden, setClearQueueHidden] = useState(true)
  const [fileListHidden, setFileListHidden] = useState(true)
  const [confirmSummary, setConfirmSummary] = useState('')
  const [confirmList, setConfirmList] = useState([])

  /* 命令式管线 ref 镜像 */
  const stateRef = useRef({})
  const rulesRef = useRef(rules)
  rulesRef.current = rules
  const filesRef = useRef(files)
  filesRef.current = files
  const rowsRef = useRef([])
  const dragIdxRef = useRef(-1)
  const previewTimerRef = useRef(0)
  const dropDepthRef = useRef(0)

  /* —— 文件队列 —— */
  const addFiles = useCallback(async (fileList, selected = false) => {
    const list = Array.from(fileList || [])
    if (!list.length) return
    try {
      const handles = selected ? list : await api.localFiles.fromDrop(list)
      let added = 0
      const next = [...filesRef.current]
      for (const h of handles) {
        if (h.kind !== 'file') continue
        if (next.some((f) => f.name === h.name && f.size === h.size)) continue
        next.push({ handleId: h.id, name: h.name, size: h.size, dir: '' })
        added++
      }
      filesRef.current = next
      setFiles(next)
      setStatusText(`已加入 ${added} 个文件`)
      renderAll(next, rulesRef.current)
    } catch (err) {
      kitRef.current?.toast(err?.message || '拖入失败', 'error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setStatusText = (text) => setStatus(text || '')

  /* —— 预览（等价原 renderPreview，120ms 防抖） —— */
  const renderPreview = useCallback((currentFiles, currentRules) => {
    setRuleError('')
    let computed = []
    try {
      // fromDrop 不回目录：同名冲突保守按同一目录分组（批量改名通常发生在同一目录）
      computed = applyRules(
        currentFiles.map((f) => ({ id: f.handleId, name: f.name, mtime: f.mtime, dir: '/batch' })),
        currentRules,
      )
    } catch (err) {
      setRuleError(`规则参数错误：${err.message}`)
      computed = currentFiles.map((f) => ({ id: f.handleId, oldName: f.name, newName: f.name, changed: false, error: null }))
    }
    rowsRef.current = computed
    setRows(computed)
    if (!currentFiles.length) {
      setPreviewMeta('')
      setRunDisabled(true)
      return
    }
    const blocked = hasBlocked(computed)
    const changed = computed.filter((r) => r.newName !== r.oldName && !r.error).length
    const conflictCount = computed.filter((r) => r.error?.startsWith('冲突')).length
    const invalidCount = computed.filter((r) => r.error && !r.error.startsWith('冲突')).length
    const parts = [`${changed} 个将改名`]
    if (conflictCount) parts.push(`${conflictCount} 个冲突`)
    if (invalidCount) parts.push(`${invalidCount} 个非法名`)
    if (blocked) parts.push('已禁止执行')
    setPreviewMeta(parts.join(' · '))
    setRunDisabled(blocked || changed === 0)
  }, [])

  const schedulePreview = useCallback(() => {
    clearTimeout(previewTimerRef.current)
    previewTimerRef.current = setTimeout(() => renderPreview(filesRef.current, rulesRef.current), 120)
  }, [renderPreview])

  const renderAll = useCallback(
    (currentFiles, currentRules) => {
      const has = currentFiles.length > 0
      setFileListHidden(!has)
      setClearQueueHidden(!has)
      setQueueCount(has ? `（${currentFiles.length}）` : '')
      setUndoHidden(!lastRunRef.current)
      renderPreview(currentFiles, currentRules)
    },
    [renderPreview],
  )
  const lastRunRef = useRef(null)
  const [queueCount, setQueueCount] = useState('')

  /* —— 规则参数更新（受控输入直改 rules 数组） —— */
  const updateRule = useCallback(
    (idx, key, value) => {
      setRules((prev) => {
        const next = prev.map((r, i) => (i === idx ? { ...r, [key]: value } : r))
        rulesRef.current = next
        return next
      })
      schedulePreview()
    },
    [schedulePreview],
  )

  /* —— 执行（确认摘要 → renameBatch）—— */
  const run = useCallback(async () => {
    const items = rowsRef.current
      .filter((r) => r.newName !== r.oldName && !r.error)
      .map((r) => ({ handleId: r.id, newName: r.newName }))
    if (!items.length) return
    const dlg = dialogRef.current
    const total = filesRef.current.length
    const skipped = total - items.length
    setConfirmSummary(
      `队列 ${total} 个，将改名 ${items.length} 个` +
        (skipped > 0 ? `，${skipped} 个保持不变` : '') +
        '（仅同目录，不移动）',
    )
    setConfirmList(items.slice(0, 60).map((item) => item.newName).concat(items.length > 60 ? [`… 共 ${items.length} 项`] : []))
    const choice = await new Promise((resolve) => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true })
      // React 重渲染不触碰 dialog（非受控原生元素），直接 showModal
      dlg.showModal()
    })
    if (choice !== 'ok') return
    setRunDisabled(true)
    try {
      const result = await api.fs.renameBatch({ items, confirmed: true })
      // 撤销映射：成功项记录 to → from（句柄在宿主侧已跟随新名）
      const mapping = result.results
        .filter((r) => r.ok)
        .map((r) => ({ handleId: r.handleId, from: r.oldName, to: r.newName }))
      lastRunRef.current = mapping
      setLastRun(mapping)
      setUndoHidden(false)
      if (result.failed > 0) {
        kitRef.current?.toast(`完成：成功 ${result.succeeded}，失败 ${result.failed}`, 'warn')
        const failedRows = result.results.filter((r) => !r.ok)
        setStatusText(`失败明细：${failedRows.map((r) => `${r.newName}（${r.error}）`).join('；')}`)
      } else {
        kitRef.current?.toast(`已改名 ${result.succeeded} 个文件`, 'success')
        setStatusText('')
      }
      await kitRef.current?.save('undoMap', mapping).catch(() => {})
      // 成功项移出队列
      const okIds = new Set(result.results.filter((r) => r.ok).map((r) => r.handleId))
      const next = filesRef.current.filter((f) => !okIds.has(f.handleId))
      filesRef.current = next
      setFiles(next)
      renderAll(next, rulesRef.current)
    } catch (err) {
      kitRef.current?.toast(err?.message || '执行失败', 'error')
      setRunDisabled(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderAll])

  /* —— 撤销 —— */
  const undo = useCallback(async () => {
    const mapping = lastRunRef.current
    if (!mapping?.length) return
    const items = mapping.map((m) => ({ handleId: m.handleId, newName: m.from }))
    try {
      const result = await api.fs.renameBatch({ items, confirmed: true })
      const undone = result.results.filter((r) => r.ok).length
      kitRef.current?.toast(
        undone === items.length ? `已撤销 ${undone} 个` : `撤销 ${undone}/${items.length}（其余文件已变化）`,
        undone === items.length ? 'success' : 'warn',
      )
      lastRunRef.current = null
      setLastRun(null)
      setUndoHidden(true)
      await kitRef.current?.save('undoMap', []).catch(() => {})
    } catch (err) {
      kitRef.current?.toast(err?.message || '撤销失败（文件可能已被移动）', 'error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* —— 规则链 UI（每条规则渲染对应参数控件，等价原 renderRules 的 switch） —— */
  const renderRuleControls = (rule, idx) => {
    const t = (value, key, placeholder) => (
      <input type="text" value={value ?? ''} placeholder={placeholder}
        onChange={(e) => updateRule(idx, key, e.target.value)} />
    )
    const num = (value, key, min, max) => (
      <input type="number" value={value} min={min !== undefined ? String(min) : undefined} max={max !== undefined ? String(max) : undefined}
        onChange={(e) => updateRule(idx, key, Number(e.target.value))} />
    )
    const check = (value, key, textContent) => (
      <label>
        <input type="checkbox" checked={value === true} onChange={(e) => updateRule(idx, key, e.target.checked)} />
        {textContent}
      </label>
    )
    const select = (value, key, options) => (
      <select value={value} onChange={(e) => updateRule(idx, key, e.target.value)}>
        {options.map(([v, label]) => (
          <option key={v} value={v}>{label}</option>
        ))}
      </select>
    )
    const field = (labelText, inputEl) => <label>{labelText}{inputEl}</label>
    switch (rule.type) {
      case 'replace':
        return (
          <>
            {field('查找', t(rule.find, 'find', '要替换的内容'))}
            {field('替换为', t(rule.replaceWith, 'replaceWith', '留空即删除'))}
            {check(rule.caseSensitive, 'caseSensitive', '区分大小写')}
            {check(rule.regex, 'regex', '正则')}
          </>
        )
      case 'number':
        return (
          <>
            {field('起始', num(rule.start, 'start', 0))}
            {field('步进', num(rule.step, 'step', 1))}
            {field('位数', num(rule.width, 'width', 1, 10))}
            {select(rule.position, 'position', [['prefix', '前缀'], ['suffix', '后缀']])}
            {field('分隔', t(rule.separator, 'separator', '_'))}
            {check(rule.keepBase !== false, 'keepBase', '保留原名')}
          </>
        )
      case 'date':
        return (
          <>
            {select(rule.source, 'source', [['mtime', '原文件时间'], ['now', '当前时间']])}
            {field('格式', t(rule.pattern, 'pattern', 'YYYYMMDD'))}
            {select(rule.position, 'position', [['prefix', '前缀'], ['suffix', '后缀']])}
            {field('分隔', t(rule.separator, 'separator', '_'))}
          </>
        )
      case 'case':
        return select(rule.mode, 'mode', [['upper', '全大写'], ['lower', '全小写'], ['title', '首字母大写']])
      case 'insert':
        return (
          <>
            {field('内容', t(rule.text, 'text', '要插入的片段'))}
            {select(rule.position, 'position', [['head', '开头'], ['tail', '结尾'], ['index', '指定位置']])}
            {rule.position === 'index' ? field('第 n 字符前', num(rule.at, 'at', 0)) : null}
          </>
        )
      case 'remove':
        return (
          <>
            {select(rule.position, 'position', [['start', '从开头数'], ['end', '从结尾数']])}
            {field('起始于', num(rule.start, 'start', 0))}
            {field('删除位数', num(rule.length, 'length', 1))}
          </>
        )
      case 'ext':
        return field('新扩展名', t(rule.ext, 'ext', '如 jpg（留空删除）'))
      default:
        return null
    }
  }

  /* —— 拖拽排序（等价原 dragstart/drop） —— */
  const onRuleDragStart = useCallback((e, idx) => {
    dragIdxRef.current = idx
    e.dataTransfer.setData('text/rule-idx', String(idx))
  }, [])
  const onRuleDrop = useCallback(
    (e, idx) => {
      e.preventDefault()
      const from = Number(e.dataTransfer.getData('text/rule-idx'))
      if (!Number.isInteger(from) || from === idx) return
      setRules((prev) => {
        const next = [...prev]
        const [moved] = next.splice(from, 1)
        next.splice(idx, 0, moved)
        rulesRef.current = next
        renderAllRef.current(filesRef.current, next)
        return next
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  /* —— 队列移除 —— */
  const removeFile = useCallback(
    (i) => {
      const next = filesRef.current.filter((_, j) => j !== i)
      filesRef.current = next
      setFiles(next)
      renderAll(next, rulesRef.current)
    },
    [renderAll],
  )

  const pickFiles = useCallback(() => {
    void api.localFiles
      .pick({ kind: 'file', access: 'read', multiple: true })
      .then((handles) => addFiles(handles, true))
      .catch((error) => kitRef.current?.toast(error.message, 'error'))
  }, [addFiles])

  const clearQueue = useCallback(() => {
    filesRef.current = []
    setFiles([])
    renderAll([], rulesRef.current)
  }, [renderAll])

  const onRuleAddChange = useCallback(
    (e) => {
      const type = e.target.value
      e.target.value = ''
      PluginKit.upgradeSelects() // 重置为占位项后同步自定义下拉触发器文案
      if (!type) return
      const rule = ruleTemplate(type)
      if (rule) {
        setRules((prev) => {
          const next = [...prev, rule]
          rulesRef.current = next
          renderAllRef.current(filesRef.current, next)
          return next
        })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const renderAllRef = useRef(renderAll)
  renderAllRef.current = renderAll

  const deleteRule = useCallback(
    (idx) => {
      setRules((prev) => {
        const next = prev.filter((_, i) => i !== idx)
        rulesRef.current = next
        renderAllRef.current(filesRef.current, next)
        return next
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  /* —— 双形态（等价原 kit.onMode） —— */
  useEffect(() => {
    const kit = PluginKit.create({ title: '批量重命名', height: 560 })
    kitRef.current = kit
    kit.onMode((mode) => {
      document.documentElement.dataset.mode = mode
      if (mode === 'quick') void api.ui.setHeight(filesRef.current.length ? 620 : 480).catch(() => {})
    })
    // 全区拖入（等价原 .rn-app dragover/dragleave/drop）
    const app = appRef.current
    const zone = dropZoneRef.current
    let depth = 0
    const onDragOver = (e) => {
      e.preventDefault()
      zone?.classList.add('armed')
    }
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1)
      if (!depth) zone?.classList.remove('armed')
    }
    const onDrop = (e) => {
      e.preventDefault()
      depth = 0
      zone?.classList.remove('armed')
      void addFilesRef.current(e.dataTransfer?.files)
    }
    app.addEventListener('dragover', onDragOver)
    app.addEventListener('dragleave', onDragLeave)
    app.addEventListener('drop', onDrop)
    // 启动：恢复撤销映射（等价原 loadUndo）
    void (async () => {
      const saved = await kit.load('undoMap', [])
      const mapping = Array.isArray(saved) && saved.length ? saved : null
      lastRunRef.current = mapping
      setLastRun(mapping)
      setUndoHidden(!mapping)
    })()
    return () => {
      app.removeEventListener('dragover', onDragOver)
      app.removeEventListener('dragleave', onDragLeave)
      app.removeEventListener('drop', onDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const addFilesRef = useRef(addFiles)
  addFilesRef.current = addFiles

  const hasFiles = files.length > 0

  return (
    <main className="rn-app" ref={appRef}>
      <header className="rn-head">
        <h1>批量重命名</h1>
        <p className="rn-sub">规则链实时预览 · 确认后执行 · 可撤销</p>
        <span className="rn-spacer"></span>
        <button id="undo-btn" className="ghost" hidden={undoHidden} onClick={() => void undo()}>撤销上次</button>
        <button id="run-btn" className="danger" disabled={runDisabled} onClick={() => void run()}>执行改名</button>
      </header>

      <div className="rn-workbench">
        {/* 左：文件队列 + 规则构建器 */}
        <aside className="rn-side">
          <section className="panel queue-panel">
            <div className="panel-head">
              <h2>文件队列 <span id="queue-count" className="pk-muted">{queueCount}</span></h2>
              <div className="head-actions">
                <button id="pick-btn" className="ghost" onClick={pickFiles}>添加文件</button>
                <button id="clear-queue" className="ghost" hidden={clearQueueHidden} onClick={clearQueue}>清空</button>
              </div>
            </div>
            <div id="drop-zone" className="drop-zone" ref={dropZoneRef} hidden={hasFiles}>
              <p>拖入要改名的文件（可多选）</p>
              <p className="pk-muted">改名只发生在原目录内；同名 / 非法目标不会执行</p>
            </div>
            <ul id="file-list" className="file-list" hidden={fileListHidden}>
              {files.map((f, i) => (
                <li key={f.handleId + i} data-row-actions>
                  <span className="f-index">{i + 1}</span>
                  <span className="f-name" title={f.name}>{f.name}</span>
                  <span className="f-size">{fmtBytes(f.size)}</span>
                  <span className="pk-row-actions">
                    <button onClick={() => removeFile(i)}>移除</button>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel rules-panel">
            <div className="panel-head">
              <h2>规则链 <span className="pk-muted">按序叠加</span></h2>
              <div className="head-actions">
                <select id="rule-add" aria-label="添加规则" ref={ruleAddRef} onChange={onRuleAddChange}>
                  <option value="">+ 添加规则…</option>
                  <option value="replace">查找替换</option>
                  <option value="number">序号</option>
                  <option value="date">日期</option>
                  <option value="case">大小写转换</option>
                  <option value="insert">插入片段</option>
                  <option value="remove">删除片段</option>
                  <option value="ext">扩展名替换</option>
                </select>
              </div>
            </div>
            <ol id="rule-list" className="rule-list">
              {!rules.length ? (
                <li className="rule-empty">还没有规则——添加一条开始预览</li>
              ) : (
                rules.map((rule, idx) => (
                  <li key={idx} className="rule-item" draggable
                    onDragStart={(e) => onRuleDragStart(e, idx)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => onRuleDrop(e, idx)}>
                    <span className="r-order" title="拖动调整顺序">{idx + 1}.</span>
                    <span className="r-kind">{RULE_LABEL[rule.type] || rule.type}</span>
                    {renderRuleControls(rule, idx)}
                    <span className="pk-row-actions">
                      <button className="r-del" onClick={() => deleteRule(idx)}>删除</button>
                    </span>
                  </li>
                ))
              )}
            </ol>
            <p id="rule-error" className="rule-error" role="alert" hidden={!ruleError}>{ruleError}</p>
          </section>
        </aside>

        {/* 右：实时预览（新名 vs 旧名 diff） */}
        <section className="panel preview-panel">
          <div className="panel-head">
            <h2>预览 <span id="preview-meta" className="pk-muted">{previewMeta}</span></h2>
          </div>
          <div className="preview-head">
            <span>原名</span><span></span><span>新名</span><span className="preview-head-note">状态</span>
          </div>
          <div id="preview-table" className="preview-table" role="list">
            {!hasFiles ? (
              <p className="rule-empty">加入文件后这里显示 原名 → 新名 预览</p>
            ) : (
              rows.map((row, i) => (
                <div key={i} className={'pv-row' + (row.error ? ' blocked' : '')} role="listitem">
                  <PvName name={row.oldName} />
                  <span className="pv-arrow">{row.newName === row.oldName ? '·' : '→'}</span>
                  <PvName name={row.newName} diff={row.newName !== row.oldName && !row.error} against={row.oldName} />
                  <span className="pv-note">{row.error || (row.newName === row.oldName ? '不变' : '')}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <p id="status" role="status" className="pk-muted">{status}</p>

      {/* 危险确认对话框：应用前摘要 */}
      <dialog id="confirm-dialog" ref={dialogRef}>
        <form method="dialog">
          <h3>确认执行改名？</h3>
          <p className="pk-muted" id="confirm-summary">{confirmSummary}</p>
          <ul id="confirm-list" className="confirm-list pk-mono">
            {confirmList.map((name, i) => (
              <li key={i}>{name}</li>
            ))}
          </ul>
          <menu>
            <button value="cancel" className="ghost">取消</button>
            <button value="ok" className="danger">确认执行</button>
          </menu>
        </form>
      </dialog>
    </main>
  )
}
