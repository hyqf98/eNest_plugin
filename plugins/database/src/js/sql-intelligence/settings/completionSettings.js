import { DEFAULT_CONFIG, normalizeConfig, validateConfig, fingerprintConfig, mergeConfig, configConnectionIds, CONFIG_LIMITS } from '@db/sql-intelligence/configuration/index.js'
import { clone, esc, options } from './formMarkup.js'
import { settingsMarkup } from './settingsMarkup.js'
import { mountColumnSetEditor } from './columnSetEditor.js'
import { mountTemplateEditor } from './templateEditor.js'
import { mountCompletionPlayground } from './completionPlayground.js'
import { mountFunctionEditor } from './functionEditor.js'
import { mountEnumEditor } from './enumEditor.js'
import { mountProfileEditor } from './profileEditor.js'

/** Settings owns a draft. Only an acknowledged save publishes that draft. */
export function mountCompletionSettings(root, callbacks) {
  let draft
  let initialIssue = ''
  try { draft = normalizeConfig(callbacks.getConfig?.() || {}) }
  catch (error) { draft = clone(callbacks.getConfig?.() || {}); initialIssue = error.message }
  let savedFingerprint = fingerprintConfig(draft)
  let saving = false
  let destroyed = false
  let jsonDirty = false
  let pendingImport = null
  let parts = []
  const context = {
    ...callbacks,
    getDraft: () => draft,
    getConnections: () => callbacks.getConnections?.() || [],
    getScope: () => callbacks.getScope?.() || {},
    changed
  }

  function render() {
    parts.forEach(part => part.destroy()); parts = []
    root.classList.add('sql-completion-settings')
    root.innerHTML = settingsMarkup(draft, { initialIssue, canClearUsage: !!callbacks.clearUsage })
    // Malformed persisted data stays visible in JSON for repair, rather than being erased.
    const hasLists = !validateConfig(draft).length && ['columnSets', 'templates', 'profiles', 'functions', 'enums'].every(name => Array.isArray(draft[name]))
    if (hasLists) {
      parts.push(mountColumnSetEditor(root.querySelector('[data-column-sets]'), context))
      parts.push(mountTemplateEditor(root.querySelector('[data-query-templates]'), context))
      parts.push(mountFunctionEditor(root.querySelector('[data-custom-functions]'), context))
      parts.push(mountEnumEditor(root.querySelector('[data-static-enums]'), context))
      parts.push(mountProfileEditor(root.querySelector('[data-scoped-profiles]'), context))
    }
    parts.push(mountCompletionPlayground(root.querySelector('[data-completion-playground]'), context))
  }

  function changed() {
    initialIssue = ''
    const issues = draftIssues()
    const status = root.querySelector('[data-save-state]')
    status.textContent = issues.length ? `尚未保存 · ${issues[0].path} ${issues[0].message}` : fingerprintConfig(draft) === savedFingerprint ? '已保存' : '有未保存的修改'
    status.dataset.error = issues.length ? 'true' : 'false'
    if (!jsonDirty) root.querySelector('[data-completion-json]').value = JSON.stringify(draft, null, 2)
    parts.forEach(part => part.refreshDependencies?.())
    parts.at(-1)?.refresh()
  }

  // A number that is still being typed is not publishable JSON. Editors keep
  // that text locally and contribute issues without coercing it to null/zero.
  function draftIssues() { return [...validateConfig(draft), ...parts.flatMap(part => part.getIssues?.() || [])] }

  async function save() {
    if (saving) return
    const status = root.querySelector('[data-save-state]')
    if (jsonDirty) { status.textContent = '高级 JSON 尚未应用。请先校验并应用到草稿。'; return }
    const issues = draftIssues()
    if (issues.length) { status.textContent = `无法保存：${issues[0].path} ${issues[0].message}`; status.dataset.error = 'true'; return }
    const snapshot = normalizeConfig(draft)
    const fingerprint = fingerprintConfig(snapshot)
    saving = true
    const button = root.querySelector('[data-save-completion]')
    button.disabled = true; status.textContent = '正在保存…'
    try {
      await callbacks.saveConfig(snapshot)
      if (destroyed) return
      savedFingerprint = fingerprint
      status.textContent = fingerprintConfig(draft) === fingerprint ? '已保存，查询编辑器立即生效。' : '已保存提交时的配置，当前还有新的修改。'
      status.dataset.error = 'false'
    } catch (error) {
      if (!destroyed) { status.textContent = `保存失败，草稿仍保留：${error.message || error}`; status.dataset.error = 'true' }
    } finally { saving = false; if (!destroyed) button.disabled = false }
  }

  function applyJson() {
    const status = root.querySelector('[data-json-issues]')
    try {
      const text = root.querySelector('[data-completion-json]').value
      if (new TextEncoder().encode(text).length > CONFIG_LIMITS.bytes) throw new Error('配置不能超过 256 KB')
      const next = JSON.parse(text)
      const issues = validateConfig(next)
      if (issues.length) { status.textContent = issues.map(item => `${item.path}：${item.message}`).slice(0, 8).join('\n'); return }
      draft = normalizeConfig(next); jsonDirty = false
      render(); changed()
      root.querySelector('[data-completion-json]').closest('details').open = true
      root.querySelector('[data-json-issues]').textContent = '校验通过，已应用到草稿。保存后生效。'
    } catch (error) { status.textContent = `配置无效：${error.message || error}` }
  }

  async function importFile(file) {
    if (!file) return
    const status = root.querySelector('[data-json-issues]')
    try {
      if (file.size > CONFIG_LIMITS.bytes) throw new Error('文件不能超过 256 KB')
      const input = JSON.parse(await file.text())
      if (destroyed) return
      const issues = validateConfig(input)
      if (issues.length) throw new Error(`${issues[0].path}：${issues[0].message}`)
      pendingImport = input
      const connections = context.getConnections()
      const connectionIds = configConnectionIds(input)
      const conflicts = ['columnSets', 'templates', 'functions', 'enums', 'profiles'].flatMap(key => (input[key] || []).filter(item => draft[key]?.some(previous => previous.id === item.id)).map(item => item.id))
      const preview = root.querySelector('[data-import-preview]')
      preview.hidden = false
      preview.innerHTML = `<h4>导入预览</h4><p>${Object.values(input).filter(Array.isArray).reduce((sum, list) => sum + list.length, 0)} 条规则；${conflicts.length} 个 ID 与当前配置重叠。</p>${conflicts.length ? `<p class="muted">${esc(conflicts.slice(0, 12).join('、'))}</p>` : ''}<label>相同 ID 的处理<select data-import-strategy>${options([['replace', '使用导入值覆盖'], ['keep', '保留当前值']], 'replace')}</select></label>${connectionIds.map(id => `<label>连接映射：${esc(id)}<select data-map-connection="${esc(id)}">${options([['', '请选择本机连接'], ...connections.map(connection => [connection.id, connection.name || connection.id])], connections.some(connection => connection.id === id) ? id : '')}</select></label>`).join('')}<div class="sql-inline-actions"><button class="btn" data-apply-import>合并到草稿</button><button class="btn" data-cancel-import>取消导入</button></div>`
      status.textContent = connectionIds.length ? '确认连接映射后合并；不会自动连接数据库。' : '确认冲突处理后合并；保存后才会生效。'
    } catch (error) { status.textContent = `导入失败：${error.message || error}` }
  }

  function applyImport() {
    if (!pendingImport) return
    const mapping = new Map([...root.querySelectorAll('[data-map-connection]')].map(select => [select.dataset.mapConnection, select.value]))
    if ([...mapping.values()].some(value => !value)) { root.querySelector('[data-json-issues]').textContent = '存在未映射的连接，请先选择本机连接。'; return }
    const mapped = clone(pendingImport)
    const visit = value => {
      if (!value || typeof value !== 'object') return
      if (value.scope?.connectionId && mapping.has(value.scope.connectionId)) value.scope.connectionId = mapping.get(value.scope.connectionId)
      Object.values(value).forEach(child => { if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child) })
    }
    visit(mapped)
    draft = normalizeConfig(mergeConfig(draft, mapped, root.querySelector('[data-import-strategy]').value))
    jsonDirty = false; pendingImport = null; render(); changed()
  }

  async function exportConfig() {
    const status = root.querySelector('[data-json-issues]')
    if (draftIssues().length) { status.textContent = '请先修正配置，再导出。'; return }
    const text = JSON.stringify(draft, null, 2)
    try {
      if (callbacks.exportConfig) {
        const result = await callbacks.exportConfig(text)
        if (result?.canceled) { if (!destroyed) status.textContent = '已取消导出。'; return }
        if (result?.ok === false) throw new Error(result.error || '保存失败')
      }
      else {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
        const link = document.createElement('a'); link.href = url; link.download = 'enest-sql-completion.json'; link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      if (!destroyed) status.textContent = '配置已导出。'
    } catch (error) { if (!destroyed) status.textContent = `导出失败：${error.message || error}` }
  }

  function change(event) {
    const target = event.target
    if (target.dataset.config) {
      const [section, key] = target.dataset.config.split('.')
      draft[section] ||= {}
      draft[section][key] = target.type === 'checkbox' ? target.checked : target.type === 'number' ? Number(target.value) : target.value
      parts.filter(part => part !== parts.at(-1)).forEach(part => part.refresh?.())
      changed()
    }
    if (target.hasAttribute('data-import-file')) { void importFile(target.files?.[0]); target.value = '' }
  }
  function input(event) {
    if (event.target.hasAttribute('data-completion-json')) { jsonDirty = true; root.querySelector('[data-json-issues]').textContent = 'JSON 有未应用的修改。' }
  }
  function click(event) {
    const target = event.target.closest('button')
    if (!target) return
    if (target.hasAttribute('data-save-completion')) void save()
    if (target.hasAttribute('data-apply-completion-json')) applyJson()
    if (target.hasAttribute('data-export-completion')) void exportConfig()
    if (target.hasAttribute('data-import-completion')) root.querySelector('[data-import-file]').click()
    if (target.hasAttribute('data-apply-import')) applyImport()
    if (target.hasAttribute('data-cancel-import')) { pendingImport = null; root.querySelector('[data-import-preview]').hidden = true }
    if (target.hasAttribute('data-reset-completion')) { draft = clone(DEFAULT_CONFIG); jsonDirty = false; render(); changed() }
    if (target.hasAttribute('data-clear-completion-usage')) Promise.resolve(callbacks.clearUsage?.()).then(() => { if (!destroyed) root.querySelector('[data-save-state]').textContent = '补全学习记录已清除。' }).catch(error => { if (!destroyed) root.querySelector('[data-save-state]').textContent = `清除失败：${error.message || error}` })
  }
  root.addEventListener('change', change); root.addEventListener('input', input); root.addEventListener('click', click)
  render()
  return {
    getDraft: () => clone(draft),
    setDraft(config) { draft = normalizeConfig(config); jsonDirty = false; render(); changed() },
    destroy() { destroyed = true; parts.forEach(part => part.destroy()); root.removeEventListener('change', change); root.removeEventListener('input', input); root.removeEventListener('click', click) }
  }
}
