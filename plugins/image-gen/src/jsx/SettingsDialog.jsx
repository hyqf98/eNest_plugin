/**
 * SettingsDialog — 弹窗设置（pk-Dialog + 左导航四区）。
 * 渠道 / 保存位置 / 提示词模板 / 默认参数。密钥只写 vault（secretRef），编辑时留空 = 保持不变。
 * 偏好走 PluginKit prefs 管线（kit.setPref），模板存 KV `image-gen.templates.v1`。
 */
import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogDescription, Button, Input, Segmented } from '../ui/index.jsx'
import { normalizeBaseUrl, upsertProvider, removeProvider, API_KIND, API_KINDS, getProtocol, isLikelyImageModel } from '../js/providers.mjs'
import { pickSaveDirectory } from '../js/backendBridge.mjs'
import { SIZE_OPTIONS, QUALITY_OPTIONS } from '../js/params.mjs'

const SECTIONS = [
  { id: 'providers', glyph: '◇', label: '渠道' },
  { id: 'saveDir', glyph: '▣', label: '保存位置' },
  { id: 'templates', glyph: '✎', label: '提示词模板' },
  { id: 'defaults', glyph: '⚙', label: '默认参数' }
]

const KIND_LABEL = { [API_KIND.IMAGES]: 'Images', [API_KIND.CHAT]: 'Chat', [API_KIND.RESPONSES]: 'Responses' }
const KIND_DESC = {
  [API_KIND.IMAGES]: 'OpenAI Images 协议（/images/generations 与 /images/edits），支持 gpt-image 系列与兼容中转站；文生图直传尺寸与数量。',
  [API_KIND.CHAT]: 'Chat Completions 多模态协议：提示词与图片走 messages，响应解析 markdown 图片与 data: URI；尺寸翻译成提示词后缀。',
  [API_KIND.RESPONSES]: 'Responses 协议：input 数组 + image_generation 工具，适合 gpt-4o 系原生图像生成；输出取 image_generation_call 结果。'
}
const DEFAULT_MODEL_BY_KIND = { [API_KIND.IMAGES]: 'gpt-image-1', [API_KIND.CHAT]: 'gpt-4o', [API_KIND.RESPONSES]: 'gpt-4o' }

const TEMPLATES_KEY = 'image-gen.templates.v1'
const SAVE_DIR_KEY = 'image-gen.save-dir.v1'

function store() {
  return window.enest || window.zapi
}

async function loadTemplates() {
  try {
    const saved = await store().storage.get(TEMPLATES_KEY)
    if (Array.isArray(saved)) return saved
  } catch { /* 首次 */ }
  return []
}

async function saveTemplates(list) {
  await store().storage.set(TEMPLATES_KEY, list)
}

async function loadSaveDir() {
  try {
    const saved = await store().storage.get(SAVE_DIR_KEY)
    if (saved && typeof saved === 'object') return saved
  } catch { /* 首次 */ }
  return null
}

async function saveSaveDir(value) {
  const storage = store().storage
  if (value) await storage.set(SAVE_DIR_KEY, value)
  else await storage.remove(SAVE_DIR_KEY)
}

/* —— 模型 Combobox：手输 + 拉取列表，图片模型启发式过滤 + 显示全部开关 —— */
function ModelCombo({ value, onChange, provider, apiKind }) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState([])
  const [showAll, setShowAll] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const fetchModels = async () => {
    if (loading) return
    setLoading(true); setError('')
    try {
      const list = await getProtocol(apiKind).listModels({ ...provider, baseUrl: normalizeBaseUrl(provider.baseUrl) })
      setModels(list)
      setOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setLoading(false) }
  }

  const filtered = useMemo(() => showAll ? models : models.filter(isLikelyImageModel), [models, showAll])

  return (
    <div className="ig-combo">
      <div className="ig-combo-toolbar" style={{ padding: 0, marginTop: 0 }}>
        <Input value={value} onChange={e => onChange(e.target.value)} placeholder={DEFAULT_MODEL_BY_KIND[apiKind]}
          style={{ fontFamily: 'var(--font-mono, monospace)' }} />
        <Button size="sm" variant="ghost" disabled={loading || !provider?.baseUrl} onClick={fetchModels} title="从接口拉取模型列表">
          {loading ? <span className="ig-spin" aria-hidden="true" /> : '拉取'}
        </Button>
      </div>
      {error && <div className="ig-form-note" style={{ color: '#c0392f' }}>{error}</div>}
      {open && (
        <>
          <div className="ig-combo-list">
            {filtered.length === 0 && <div className="ig-form-note" style={{ padding: 8 }}>没有匹配的模型</div>}
            {filtered.map(m => (
              <button key={m} type="button" className="ig-combo-row" onClick={() => { onChange(m); setOpen(false) }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m}</span>
                {isLikelyImageModel(m) && <span className="ig-combo-tag">图片</span>}
              </button>
            ))}
          </div>
          <label className="ig-form-note" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
            显示全部模型
          </label>
        </>
      )}
    </div>
  )
}

/* —— 渠道区 —— */
function ProviderSection({ providers, onChange, toast }) {
  const [draft, setDraft] = useState({ id: '', name: '', baseUrl: '', model: '', apiKind: API_KIND.IMAGES })
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [testing, setTesting] = useState('')
  const [testResult, setTestResult] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState('')

  const reset = () => {
    setDraft({ id: '', name: '', baseUrl: '', model: '', apiKind: API_KIND.IMAGES })
    setApiKey(''); setError('')
  }

  const effectiveBase = draft.baseUrl ? normalizeBaseUrl(draft.baseUrl) : ''

  async function addOrUpdate({ skipTest = false } = {}) {
    setError('')
    if (!draft.name.trim() || !draft.baseUrl.trim()) { setError('名称与地址必填'); return }
    if (!draft.model.trim()) { setError('模型必填'); return }
    setBusy(true)
    try {
      const id = draft.id || `p${Date.now().toString(36)}`
      const makingDefault = !providers.length || !providers.some(p => p.isDefault) || draft.id === ''
      const record = await upsertProvider({
        id, name: draft.name.trim(), baseUrl: draft.baseUrl, model: draft.model.trim(),
        apiKind: draft.apiKind, isDefault: draft.isDefault || makingDefault
      }, apiKey)
      onChange()
      // 保存后自动测试：失败提示「保存但标记不可用」
      if (!skipTest) {
        try { await getProtocol(record.apiKind).test(record) }
        catch (err) {
          toast(`渠道已保存，但测试未通过：${err instanceof Error ? err.message : String(err)}`, 'error')
        }
      }
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  async function test(provider) {
    setTesting(provider.id); setTestResult(null)
    try {
      const { modelCount } = await getProtocol(provider.apiKind).test(provider)
      setTestResult({ id: provider.id, ok: true, modelCount })
    } catch (err) {
      setTestResult({ id: provider.id, ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally { setTesting('') }
  }

  return (
    <div>
      <div className="ig-set-title">渠道</div>
      <p className="ig-set-desc">{KIND_DESC[draft.apiKind ?? API_KIND.IMAGES]}密钥仅存宿主保险库，页面不留明文。</p>
      <div>
        {providers.length === 0 && <div className="ig-form-note" style={{ marginBottom: 10 }}>还没有渠道，在下方添加一个。</div>}
        {providers.map(p => (
          <div key={p.id} className="ig-prov-row">
            <span className="ig-kind-dot" data-kind={p.apiKind} title={KIND_LABEL[p.apiKind]} />
            <div className="ig-prov-main">
              <div className="ig-prov-title">
                <strong>{p.name}</strong>
                {p.isDefault && <span className="ig-prov-star" title="默认渠道">★</span>}
                <span className="ig-form-note">{KIND_LABEL[p.apiKind]}</span>
                {testResult?.id === p.id && (testResult.ok
                  ? <span className="ig-form-note" style={{ color: '#2f9e6e' }} title={`可用模型 ${testResult.modelCount} 个`}>连接正常</span>
                  : <span className="ig-form-note" style={{ color: '#c0392f' }} title={testResult.message}>不可用</span>)}
              </div>
              <div className="ig-prov-sub" title={`${p.baseUrl} · ${p.model}`}>{p.baseUrl} · {p.model}</div>
            </div>
            <div className="ig-prov-acts">
              {testing === p.id
                ? <span className="ig-prov-test"><span className="ig-spin" /></span>
                : <button type="button" className={`ig-prov-test ${testResult?.id === p.id ? (testResult.ok ? 'ok' : 'err') : ''}`}
                  title={testResult?.id === p.id && testResult.ok ? `可用模型 ${testResult.modelCount} 个` : '测试连接'}
                  aria-label="测试连接" onClick={() => test(p)}>测试</button>}
              {!p.isDefault && <Button size="sm" variant="ghost" onClick={async () => { await upsertProvider({ ...p, isDefault: true }); onChange() }}>设默认</Button>}
              <Button size="sm" variant="ghost" onClick={() => {
                setDraft({ id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, apiKind: p.apiKind, isDefault: p.isDefault, _hasKey: Boolean(p.secretRef) })
                setApiKey('')
              }}>编辑</Button>
              {confirmDelete === p.id
                ? <span style={{ display: 'inline-flex', gap: 4 }}>
                    <Button size="sm" variant="danger" onClick={async () => { await removeProvider(p.id); setConfirmDelete(''); onChange() }}>确认</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete('')}>取消</Button>
                  </span>
                : <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(p.id)}>删除</Button>}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16 }}>
        <div className="ig-set-title" style={{ fontSize: 13 }}>{draft.id ? '编辑渠道' : '新增渠道'}</div>
        <div className="ig-form-grid" style={{ marginTop: 10 }}>
          <label className="ig-form-label">名称
            <Input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="如 OpenAI 官方 / 某中转站" />
          </label>
          <label className="ig-form-label">协议
            <Segmented value={draft.apiKind} onChange={v => setDraft({ ...draft, apiKind: v, model: '' })}
              options={API_KINDS.map(k => ({ label: KIND_LABEL[k], value: k }))} ariaLabel="协议类型" />
          </label>
          <label className="ig-form-wide ig-form-label">接口地址
            <Input value={draft.baseUrl} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
            {effectiveBase && <span className="ig-form-note">生效地址：{effectiveBase}</span>}
          </label>
          <label className="ig-form-wide ig-form-label">模型
            <ModelCombo value={draft.model} onChange={model => setDraft({ ...draft, model })}
              provider={{ ...draft, secretRef: draft.id ? providers.find(p => p.id === draft.id)?.secretRef : '' }} apiKind={draft.apiKind} />
          </label>
          <label className="ig-form-wide ig-form-label">API Key{draft.id ? '（留空 = 保持不变）' : ''}
            <Input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-…" autoComplete="off" />
          </label>
        </div>
        {error && <div className="ig-form-note" style={{ color: '#c0392f', marginTop: 8 }} role="alert">{error}</div>}
        <div className="ig-form-actions">
          {draft.id && <Button size="sm" variant="ghost" onClick={reset}>取消编辑</Button>}
          <Button size="sm" variant="primary" disabled={busy} onClick={() => addOrUpdate()}>{draft.id ? '保存修改' : '添加'}</Button>
        </div>
      </div>
    </div>
  )
}

/* —— 保存位置区 —— */
function SaveDirSection({ saveDir, onChange, toast }) {
  const [busy, setBusy] = useState(false)
  const pick = async () => {
    setBusy(true)
    try {
      const dir = await pickSaveDirectory()
      if (dir) {
        const next = { handleId: dir.handleId, displayPath: dir.displayPath }
        await saveSaveDir(next)
        onChange(next)
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally { setBusy(false) }
  }
  const clear = async () => {
    await saveSaveDir(null)
    onChange(null)
  }
  return (
    <div>
      <div className="ig-set-title">保存位置</div>
      <p className="ig-set-desc">生成图的落盘位置：默认存插件资产库（eNest 数据根本插件私有目录）；选择自定义目录后每张生成图同时写入该目录。目录句柄失效时该次自动落回资产库。</p>
      <div className="ig-save-dir-row">
        <span className="ig-kind-dot" data-kind={saveDir ? 'images' : ''} style={{ background: saveDir ? '#2f9e6e' : 'var(--ig-muted)' }} />
        <span style={{ fontSize: 12.5 }}>{saveDir ? '自定义目录' : '插件资产库'}</span>
        {saveDir && <span className="ig-save-dir-path" title={saveDir.displayPath}>{saveDir.displayPath}</span>}
      </div>
      <div className="ig-form-actions" style={{ justifyContent: 'flex-start' }}>
        <Button size="sm" disabled={busy} onClick={pick}>{saveDir ? '更换目录' : '选择目录'}</Button>
        {saveDir && <Button size="sm" variant="ghost" onClick={clear}>清除（回到资产库）</Button>}
      </div>
    </div>
  )
}

/* —— 模板区 —— */
function TemplateSection({ templates, onChange }) {
  const [draft, setDraft] = useState({ id: '', title: '', content: '' })
  const save = async (list) => { await saveTemplates(list); onChange(list) }
  const upsert = async () => {
    if (!draft.title.trim() || !draft.content.trim()) return
    const id = draft.id || `t${Date.now().toString(36)}`
    const next = draft.id
      ? templates.map(t => (t.id === draft.id ? { ...t, title: draft.title.trim(), content: draft.content.trim() } : t))
      : [...templates, { id, title: draft.title.trim(), content: draft.content.trim() }]
    await save(next)
    setDraft({ id: '', title: '', content: '' })
  }
  return (
    <div>
      <div className="ig-set-title">提示词模板</div>
      <p className="ig-set-desc">常用提示词存成模板，在输入框 ⭐ 菜单里一键追加。</p>
      <div>
        {templates.length === 0 && <div className="ig-form-note" style={{ marginBottom: 10 }}>还没有模板。</div>}
        {templates.map(t => (
          <div key={t.id} className="ig-tpl-row">
            <div className="ig-tpl-row-main">
              <div className="ig-tpl-row-title">{t.title}</div>
              <div className="ig-tpl-row-body" title={t.content}>{t.content}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setDraft({ id: t.id, title: t.title, content: t.content })}>编辑</Button>
            <Button size="sm" variant="ghost" onClick={() => save(templates.filter(x => x.id !== t.id))}>删除</Button>
          </div>
        ))}
      </div>
      <div className="ig-form-grid" style={{ marginTop: 14 }}>
        <label className="ig-form-label">标题
          <Input value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="如 商品静物摄影" />
        </label>
        <label className="ig-form-wide ig-form-label">内容
          <Input value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })} placeholder="白底棚拍，柔和顶光，居中构图，高细节" />
        </label>
      </div>
      <div className="ig-form-actions">
        {draft.id && <Button size="sm" variant="ghost" onClick={() => setDraft({ id: '', title: '', content: '' })}>取消编辑</Button>}
        <Button size="sm" variant="primary" disabled={!draft.title.trim() || !draft.content.trim()} onClick={upsert}>{draft.id ? '保存修改' : '添加'}</Button>
      </div>
    </div>
  )
}

/* —— 默认参数区 —— */
function DefaultsSection({ prefs, onChange }) {
  return (
    <div>
      <div className="ig-set-title">默认参数</div>
      <p className="ig-set-desc">新会话的初始生成参数（发送时可临时调整）。质量档位对 gpt-image 类模型生效。</p>
      <div className="ig-form-grid">
        <label className="ig-form-label">默认尺寸
          <Segmented value={prefs.defaultSize} onChange={v => onChange({ ...prefs, defaultSize: v })}
            options={SIZE_OPTIONS.map(o => ({ label: o.label, value: o.value }))} ariaLabel="默认尺寸" />
        </label>
        <label className="ig-form-label">默认数量
          <Segmented value={String(prefs.defaultN)} onChange={v => onChange({ ...prefs, defaultN: Number(v) })}
            options={[1, 2, 3, 4].map(v => ({ label: String(v), value: String(v) }))} ariaLabel="默认数量" />
        </label>
        <label className="ig-form-wide ig-form-label">默认质量
          <Segmented value={prefs.defaultQuality} onChange={v => onChange({ ...prefs, defaultQuality: v })}
            options={QUALITY_OPTIONS.map(o => ({ label: o.label, value: o.value }))} ariaLabel="默认质量" />
        </label>
      </div>
    </div>
  )
}

export function SettingsDialog({ open, onOpenChange, section, onSectionChange, providers, onProvidersChanged, prefs, onPrefsChanged, saveDir, onSaveDirChanged, templates, onTemplatesChanged, toast }) {
  const [localTemplates, setLocalTemplates] = useState(templates)
  const [localSaveDir, setLocalSaveDir] = useState(saveDir)

  useEffect(() => { if (open) { setLocalTemplates(templates); setLocalSaveDir(saveDir) } }, [open, templates, saveDir])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ig-set-dialog">
        <div className="ig-set-body">
          <nav className="ig-set-nav" role="navigation" aria-label="设置分组">
            {SECTIONS.map(s => (
              <button key={s.id} type="button" className={`ig-set-nav-btn ${section === s.id ? 'active' : ''}`}
                onClick={() => onSectionChange(s.id)}>
                <span aria-hidden>{s.glyph}</span><span>{s.label}</span>
              </button>
            ))}
          </nav>
          <div className="ig-set-main">
            <DialogTitle className="ig-set-title" style={{ fontSize: 14 }}>AI 生图 · 设置</DialogTitle>
            <DialogDescription className="ig-set-desc">{SECTIONS.find(s => s.id === section)?.label}</DialogDescription>
            {section === 'providers' && <ProviderSection providers={providers} onChange={onProvidersChanged} toast={toast} />}
            {section === 'saveDir' && <SaveDirSection saveDir={localSaveDir} onChange={async next => { setLocalSaveDir(next); onSaveDirChanged(next) }} toast={toast} />}
            {section === 'templates' && <TemplateSection templates={localTemplates} onChange={next => { setLocalTemplates(next); onTemplatesChanged(next) }} />}
            {section === 'defaults' && <DefaultsSection prefs={prefs} onChange={onPrefsChanged} />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export { loadTemplates, saveTemplates, loadSaveDir, saveSaveDir, SAVE_DIR_KEY, TEMPLATES_KEY }
