import { runDatabaseTask } from './operationTask.js'
/**
 * importExport.js — 结果导出 CSV/JSON/SQL/Markdown + CSV 导入向导（DB-G）
 */
import { saveTextFile, clipboardWrite, toast, DbHost } from './api.js'
import { escape } from './resultGrid.js'
import { enhanceSelect } from './dropdown.js'
import { createDialog } from '@enest/plugin-kit/workbench'

import { toCsv, toJson, toSql, toMarkdown, toTsv, buildExport } from './exportFormats.js'
export { toCsv, toJson, toSql, toMarkdown, toTsv, buildExport } from './exportFormats.js'

export async function exportResult(format, cols, rows, tableRef, uiPrefs, { file = false } = {}) {
  if (!cols?.length && !rows?.length) {
    await toast('没有可导出的数据', 'warn')
    return { ok: false }
  }
  const { filename, content } = buildExport(format, cols, rows, tableRef, uiPrefs)
  if (format === 'tsv' && !file) {
    if (await clipboardWrite(content) === false) throw new Error('复制失败，请检查剪贴板权限后重试')
    await toast('已复制 TSV', 'success')
    return { ok: true, via: 'clipboard' }
  }
  return saveTextFile(filename, content)
}

export async function copyResult(format, cols, rows, tableRef, options = {}) {
  if (!cols?.length && !rows?.length) {
    await toast('没有可复制的数据', 'warn')
    return
  }
  let text
  if (format === 'tsv') text = toTsv(cols, rows, { headers: options.headers !== false })
  else if (format === 'json') text = toJson(cols, rows)
  else if (format === 'sql') text = toSql(cols, rows, tableRef, options)
  else if (format === 'md') text = toMarkdown(cols, rows)
  else text = toCsv(cols, rows, { bom: false })
  if (await clipboardWrite(text) === false) throw new Error('复制失败，请检查剪贴板权限后重试')
  await toast(`已复制 ${format.toUpperCase()}`, 'success')
}

/** 解析 CSV 文本（最小可用：引号/换行） */
export function parseCsv(text, { delimiter = ',', hasHeader = true } = {}) {
  const rows = []
  let row = []
  let field = ''
  let inQ = false
  const s = String(text || '').replace(/^\uFEFF/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else inQ = false
      } else field += ch
      continue
    }
    if (ch === '"') {
      inQ = true
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      continue
    }
    field += ch
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  let header
  if (hasHeader) {
    header = rows.shift() || []
  } else {
    header = (rows[0] || []).map((_, i) => `col${i + 1}`)
  }
  return { header, rows: rows.filter((r) => r.some((c) => c !== '')) }
}

/** CSV 导入：选择来源、确认预览，再执行固定目标的导入任务。 */
export function createImportWizard(_root, ctx = {}) {
  const modal = createDialog({ title: 'CSV 导入', className: 'wb-import-dialog', content: `
    <p class="muted">选择来源并预览数据，确认目标表后执行导入。</p>
    <div class="form-grid">
      <label>目标表<input data-el="table" placeholder="Schema.表名" value="${escape(ctx.defaultTable || '')}" /></label>
      <label>分隔符<select data-el="delim"><option value=",">逗号 ,</option><option value=";">分号 ;</option><option value="tab">制表符 Tab</option></select></label>
    </div>
    <div class="form-row row">
      <label class="check"><input type="checkbox" data-el="hasHeader" checked /> 首行是表头</label>
      <label class="check"><input type="checkbox" data-el="upsert" /> 存在即更新</label>
    </div>
    <div class="form-row"><label for="db-import-csv">CSV 文本</label>
      <div class="row"><button type="button" class="btn" data-act="pick-csv">选择文件…</button><span class="muted sm" data-el="fileName"></span></div>
      <textarea id="db-import-csv" data-el="csv" rows="7" placeholder="粘贴 CSV 或选择文件"></textarea>
      <input type="hidden" data-el="fileHandleId" value="" />
    </div>
    <div class="form-actions"><button type="button" class="btn" data-act="preview">预览数据</button><span class="spacer"></span><button type="button" class="btn primary" data-act="run" disabled>确认导入</button></div>
    <p class="hint" data-el="hint" role="status">尚未预览</p><pre class="preview" data-el="preview" aria-label="导入预览"></pre>` })
  const root = modal.body, $ = (name) => root.querySelector(`[data-el=${name}]`)
  const hint = $('hint'), run = root.querySelector('[data-act=run]')
  const close = () => modal.close()
  let previewSignature = '', busy = false
  enhanceSelect($('delim'))
  const read = () => ({ table: $('table').value.trim(), csvText: $('csv').value, fileHandleId: $('fileHandleId').value.trim(), delimiter: $('delim').value === 'tab' ? '\t' : $('delim').value, hasHeader: $('hasHeader').checked, conflict: $('upsert').checked ? 'upsert' : 'insert' })
  const invalidate = () => { previewSignature = ''; run.disabled = true; hint.textContent = '来源或选项已修改，请重新预览' }
  const available = () => { if (!ctx.sessionKey || ctx.isCurrent?.() === false) throw new Error('连接已断开，请重新连接后打开导入') }
  const payloadFor = (input) => ({ sessionKey: ctx.sessionKey, table: parseTableRef(input.table), options: { delimiter: input.delimiter, hasHeader: input.hasHeader, conflict: input.conflict }, ...(input.csvText ? { csvText: input.csvText } : { fileHandleId: input.fileHandleId }) })
  const setBusy = (value) => { busy = value; root.querySelectorAll('input,textarea,select,button').forEach(element => { element.disabled = value }); run.disabled = value || !previewSignature }
  root.addEventListener('input', invalidate)
  root.addEventListener('change', invalidate)
  root.querySelector('[data-act=pick-csv]').onclick = async () => {
    if (busy) return
    try {
      const picked = await DbHost.pickImportFile()
      if (!picked?.id || !modal.dialog.open) return
      $('fileHandleId').value = picked.id; $('fileName').textContent = picked.name
      $('csv').value = ''; invalidate()
    } catch (error) { hint.textContent = String(error.message || error) }
  }
  root.querySelector('[data-act=preview]').onclick = async () => {
    if (busy) return
    const input = read(), signature = JSON.stringify(input)
    previewSignature = ''; run.disabled = true
    if (!input.table || (!input.csvText && !input.fileHandleId)) { hint.textContent = '请填写目标表，并粘贴 CSV 或选择文件'; return }
    setBusy(true); hint.textContent = '正在预览…'; $('preview').textContent = ''
    try {
      available()
      const payload = payloadFor(input); payload.options.sampleRows = 20
      const result = await DbHost.importPreview(payload)
      if (!modal.dialog.open || JSON.stringify(read()) !== signature) return
      available()
      const lines = []
      if (result?.columns?.length) lines.push(result.columns.join(' | '))
      if (result?.sampleRows?.length) lines.push(...result.sampleRows.slice(0, 20).map(row => row.map(value => value == null ? 'NULL' : String(value)).join(' | ')))
      if (result?.sqlPreview?.length) lines.push('', ...result.sqlPreview.slice(0, 3))
      if (!lines.length && input.csvText) {
        const parsed = parseCsv(input.csvText, input)
        lines.push(parsed.header.join(' | '), ...parsed.rows.slice(0, 20).map(row => row.join(' | ')))
      }
      $('preview').textContent = lines.join('\n')
      previewSignature = signature
      hint.textContent = `${result?.totalRowsEstimate ?? '?'} 行 · 预览就绪 · 目标 ${input.table}`
    } catch (error) { hint.textContent = `预览失败：${String(error.message || error).slice(0, 160)}` }
    finally { setBusy(false) }
  }
  run.onclick = async () => {
    if (busy) return
    const input = read()
    if (!previewSignature || previewSignature !== JSON.stringify(input)) { invalidate(); return }
    setBusy(true); hint.textContent = '正在导入…'
    try {
      available()
      const result = await runDatabaseTask({ kind: 'import', sessionKey: ctx.sessionKey, consoleId: ctx.consoleId, editorId: ctx.editorId, tabId: ctx.tabId }, () => DbHost.importRun({ ...payloadFor(input), confirmed: true }))
      const failed = result?.failed || 0
      await toast(`导入完成 · 成功 ${result?.inserted ?? 0}${failed ? ` · 失败 ${failed}` : ''}`, failed ? 'warn' : 'success')
      previewSignature = ''
      if (failed) {
        hint.textContent = '部分数据导入失败，请检查后重新预览'
        $('preview').textContent = (result.errors || []).slice(0, 5).join('\n')
      } else close()
    } catch (error) { hint.textContent = `导入失败：${String(error.message || error).slice(0, 160)}` }
    finally { setBusy(false) }
  }
  return { close, open: () => {} }
}

export function parseTableRef(name) {
  const parts = String(name).split('.').filter(Boolean)
  if (parts.length === 3) return { database: parts[0], schema: parts[1], table: parts[2] }
  if (parts.length === 2) return { schema: parts[0], table: parts[1] }
  return { table: parts[0] || name }
}

export async function exportConnections(connections) {
  if (!connections?.length) {
    await toast('没有可导出的连接', 'warn')
    return { ok: false }
  }
  const safe = connections.map((c) => {
    const { secretRef, ...rest } = c
    void secretRef
    return { ...rest, secretRef: c.secretRef ? '(preserved)' : undefined }
  })
  return saveTextFile(
    `db-connections-${Date.now()}.json`,
    JSON.stringify(safe, null, 2),
    { successMsg: '连接配置已导出' }
  )
}

export async function exportSessions(sessions) {
  if (!sessions?.length) {
    await toast('没有可导出的会话', 'warn')
    return { ok: false }
  }
  return saveTextFile(`db-sessions-${Date.now()}.json`, JSON.stringify(sessions || [], null, 2), {
    successMsg: '会话已导出'
  })
}

export async function exportHistory(history) {
  if (!history?.length) {
    await toast('没有可导出的历史', 'warn')
    return { ok: false }
  }
  const cols = ['ts', 'connectionId', 'sessionName', 'durationMs', 'rowCount', 'error', 'sql']
  const rows = (history || []).map((h) => [
    new Date(h.ts).toISOString(),
    h.connectionId || '',
    h.sessionName || '',
    h.durationMs ?? '',
    h.rowCount ?? '',
    h.error || '',
    h.sql || ''
  ])
  return saveTextFile(`db-history-${Date.now()}.csv`, toCsv(cols, rows), { successMsg: '历史已导出' })
}

export { escape }
