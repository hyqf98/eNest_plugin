/**
 * SettingsDialog — 弹窗设置（pk-Dialog + 左导航四区）。
 * 渠道 / 保存位置 / 提示词模板 / 默认参数。密钥只写 vault（secretRef），编辑时留空 = 保持不变。
 * 偏好走 PluginKit prefs 管线（kit.setPref），模板存 KV `image-gen.templates.v1`。
 *
 * 宽度：pk-dialog-content 自带 max-width: min(480px, 92vw)，860px 宽弹窗会被压回 480px，
 * 左导航 182px 后表单只剩 280px（协议/模型被挤到换行、按钮互相叠）。这里显式放开。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogOverlay, DialogTitle, DialogDescription, Button, Input, Segmented } from '../ui/index.jsx'
import {
  AlertIcon, CheckIcon, ChevronDownIcon, FolderIcon, KeyIcon, PencilIcon, RotateIcon, SlidersIcon, TrashIcon, WandIcon, XIcon
} from '../ui/icons.jsx'
import { normalizeBaseUrl, upsertProvider, removeProvider, API_KIND, API_KINDS, getProtocol, isLikelyImageModel } from '../js/providers.mjs'
import { detectTarget, getStandard, isLlmConfigured, saveLlm, TARGETS, testLlm } from '../js/promptOptimizer.mjs'
import { pickSaveDirectory } from '../js/backendBridge.mjs'
import { SIZE_OPTIONS, QUALITY_OPTIONS } from '../js/params.mjs'

const SECTIONS = [
  { id: 'providers', label: '渠道', desc: '接入地址、模型与密钥。密钥只存宿主保险库，页面不留明文。', Icon: KeyIcon },
  { id: 'optimizer', label: '优化提示词', desc: '配置一门语言模型，输入框里一键把提示词按目标生图模型的标准扩写。', Icon: WandIcon },
  { id: 'saveDir', label: '保存位置', desc: '生成图默认落在插件资产库；选自定义目录后同时写一份到该目录。', Icon: FolderIcon },
  { id: 'templates', label: '提示词模板', desc: '常用提示词存成模板，在输入卡的模板菜单里一键追加。', Icon: PencilIcon },
  { id: 'defaults', label: '默认参数', desc: '新会话的初始生成参数，发送时可临时调整。', Icon: SlidersIcon }
]

const KIND_LABEL = { [API_KIND.IMAGES]: 'Images', [API_KIND.CHAT]: 'Chat', [API_KIND.RESPONSES]: 'Responses' }
const KIND_TAG = { [API_KIND.IMAGES]: 'IMG', [API_KIND.CHAT]: 'CHAT', [API_KIND.RESPONSES]: 'RESP' }
const KIND_DESC = {
  [API_KIND.IMAGES]: 'OpenAI Images 协议：/images/generations 与 /images/edits，支持 gpt-image 系列与兼容中转站，文生图直传尺寸与数量。',
  [API_KIND.CHAT]: 'Chat Completions 多模态协议：提示词与参考图走 messages，尺寸翻译成提示词后缀。',
  [API_KIND.RESPONSES]: 'Responses 协议：input 数组 + image_generation 工具，适合 gpt-4o 系原生图像生成。'
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
  const boxRef = useRef(null)

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

  /* 点外部/按 Esc 收起：原先只能再点一次「拉取」 */
  useEffect(() => {
    if (!open) return
    const onDown = (event) => {
      if (boxRef.current?.contains(event.target)) return
      setOpen(false)
    }
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, boxRef])

  const filtered = useMemo(() => showAll ? models : models.filter(isLikelyImageModel), [models, showAll])

  return (
    <div className="ig-combo" ref={boxRef}>
      <div className="ig-combo-field">
        <Input value={value} onChange={e => onChange(e.target.value)} placeholder={DEFAULT_MODEL_BY_KIND[apiKind]}
          aria-label="模型名称" />
        <Button size="sm" variant="ghost" disabled={loading || !provider?.baseUrl} onClick={fetchModels}
          title={provider?.baseUrl ? '从接口拉取模型列表' : '先填写接口地址'}>
          {loading ? <span className="ig-spin" aria-hidden="true" /> : '拉取列表'}
        </Button>
      </div>
      {error && <div className="ig-form-note" data-tone="error">{error}</div>}
      {open && (
        <>
          <div className="ig-combo-list" role="listbox" aria-label="可用模型">
            {filtered.length === 0 && <div className="ig-form-note" style={{ padding: 8 }}>没有匹配的模型</div>}
            {filtered.map(m => (
              <button key={m} type="button" role="option" aria-selected={m === value} className="ig-combo-row"
                onClick={() => { onChange(m); setOpen(false) }}>
                <span className="ig-combo-name">{m}</span>
                {isLikelyImageModel(m) && <span className="ig-combo-tag">图片</span>}
              </button>
            ))}
          </div>
          <label className="ig-combo-toggle">
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
  /* 一个渠道都没有时默认展开表单；否则列表优先，表单按需展开。
     这样第一屏永远是「已有渠道」，新增不会把列表挤到看不见。 */
  const [formOpen, setFormOpen] = useState(providers.length === 0)
  const formRef = useRef(null)

  const reset = () => {
    setDraft({ id: '', name: '', baseUrl: '', model: '', apiKind: API_KIND.IMAGES })
    setApiKey(''); setError('')
  }

  const openForm = (next) => {
    setDraft(next ?? { id: '', name: '', baseUrl: '', model: '', apiKind: API_KIND.IMAGES })
    setApiKey(''); setError('')
    setFormOpen(true)
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }

  const effectiveBase = draft.baseUrl ? normalizeBaseUrl(draft.baseUrl) : ''

  async function addOrUpdate({ skipTest = false } = {}) {
    setError('')
    if (!draft.name.trim() || !draft.baseUrl.trim()) { setError('名称与接口地址必填'); return }
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
      if (providers.length > 0) setFormOpen(false)
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
    <div className="ig-set-section">
      <div className="ig-prov-list">
        {providers.length === 0 && (
          <div className="ig-form-note">还没有渠道。填下面这张表加一个，添加时会自动测试连通性。</div>
        )}
        {providers.map(p => {
          const result = testResult?.id === p.id ? testResult : null
          return (
            <div key={p.id} className="ig-prov-row" data-default={p.isDefault ? '' : undefined}>
              <span className="ig-kind-tag">{KIND_TAG[p.apiKind] ?? 'N/A'}</span>
              <div className="ig-prov-main">
                <div className="ig-prov-title">
                  <span className="ig-prov-name" title={p.name}>{p.name}</span>
                  {p.isDefault && <span className="ig-prov-default">默认</span>}
                  {result && (result.ok
                    ? <span className="ig-prov-status" data-state="ok" title={`可用模型 ${result.modelCount} 个`}>
                        <CheckIcon size={12} />连接正常
                      </span>
                    : <span className="ig-prov-status" data-state="error" title={result.message}>
                        <AlertIcon size={12} />不可用
                      </span>)}
                </div>
                <div className="ig-prov-sub" title={`${p.baseUrl} · ${p.model}`}>{p.baseUrl} · {p.model}</div>
              </div>
              <div className="ig-prov-acts">
                {testing === p.id
                  ? <span className="ig-prov-status"><span className="ig-spin" /></span>
                  : <button type="button" className="ig-act-btn" title="测试连接" aria-label="测试连接"
                      onClick={() => test(p)}>测试</button>}
                {!p.isDefault && (
                  <button type="button" className="ig-act-btn"
                    onClick={async () => { await upsertProvider({ ...p, isDefault: true }); onChange() }}>设默认</button>
                )}
                <button type="button" className="ig-act-btn" aria-label="编辑渠道" title="编辑"
                  onClick={() => openForm({ id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, apiKind: p.apiKind, isDefault: p.isDefault, _hasKey: Boolean(p.secretRef) })}>编辑</button>
                {confirmDelete === p.id
                  ? <>
                      <button type="button" className="pk-btn pk-btn-sm pk-btn-danger"
                        onClick={async () => { await removeProvider(p.id); setConfirmDelete(''); onChange() }}>确认删除</button>
                      <button type="button" className="ig-act-btn" onClick={() => setConfirmDelete('')}>取消</button>
                    </>
                  : <button type="button" className="ig-act-btn" aria-label="删除渠道" title="删除"
                      onClick={() => setConfirmDelete(p.id)}><TrashIcon size={13} /></button>}
              </div>
            </div>
          )
        })}
      </div>

      <div className="ig-form-section" ref={formRef}>
        {formOpen ? (
          <>
            <div className="ig-form-section-head">
              <div className="ig-form-section-title" style={{ margin: 0 }}>{draft.id ? '编辑渠道' : '新增渠道'}</div>
              {providers.length > 0 && (
                <button type="button" className="ig-act-btn" onClick={() => { reset(); setFormOpen(false) }}>收起</button>
              )}
            </div>
            <div className="ig-form-grid">
              <label className="ig-form-label span2">协议
                <Segmented value={draft.apiKind} onChange={v => setDraft({ ...draft, apiKind: v, model: '' })}
                  options={API_KINDS.map(k => ({ label: KIND_LABEL[k], value: k }))} ariaLabel="协议类型" />
                <span className="ig-form-note">{KIND_DESC[draft.apiKind ?? API_KIND.IMAGES]}</span>
              </label>
              <label className="ig-form-label">名称
                <Input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
                  placeholder="OpenAI 官方 / 某中转站" />
              </label>
              <label className="ig-form-label">接口地址
                <Input value={draft.baseUrl} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1" spellCheck={false} />
                {effectiveBase && effectiveBase !== draft.baseUrl.trim() && (
                  <span className="ig-form-note">生效地址：{effectiveBase}</span>
                )}
              </label>
              <label className="ig-form-label span2">模型
                <ModelCombo value={draft.model} onChange={model => setDraft({ ...draft, model })}
                  provider={{ ...draft, secretRef: draft.id ? providers.find(p => p.id === draft.id)?.secretRef : '' }} apiKind={draft.apiKind} />
              </label>
              <label className="ig-form-label span2">
                API Key{draft.id ? '（留空即保持不变）' : ''}
                <Input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
                  placeholder="sk-…" autoComplete="off" spellCheck={false} />
                <span className="ig-form-note">写入宿主保险库，插件设置与日志里都不落明文。</span>
              </label>
            </div>
            {error && <div className="ig-form-note" data-tone="error" role="alert" style={{ marginTop: 8 }}>{error}</div>}
            <div className="ig-form-actions">
              {draft.id && <Button size="sm" variant="ghost" onClick={reset}>取消编辑</Button>}
              <Button size="sm" variant="primary" disabled={busy} onClick={() => addOrUpdate()}>
                {busy && <span className="ig-spin" />}
                {draft.id ? '保存修改' : '添加渠道'}
              </Button>
            </div>
          </>
        ) : (
          <div className="ig-form-section-head">
            <div className="ig-form-section-title" style={{ margin: 0 }}>接入新渠道</div>
            <Button size="sm" onClick={() => openForm()}>新增渠道</Button>
          </div>
        )}
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
    <div className="ig-set-section">
      <div className="ig-save-dir-row">
        <span className="ig-save-dir-icon" aria-hidden="true"><FolderIcon size={16} /></span>
        <span className="ig-save-dir-name">{saveDir ? '自定义目录' : '插件资产库'}</span>
        {saveDir && <span className="ig-save-dir-path" title={saveDir.displayPath}>{saveDir.displayPath}</span>}
        {!saveDir && <span className="ig-form-note" style={{ flex: 1 }}>eNest 数据根下的插件私有目录</span>}
      </div>
      <div className="ig-form-actions" style={{ justifyContent: 'flex-start' }}>
        <Button size="sm" disabled={busy} onClick={pick}>{saveDir ? '更换目录' : '选择目录'}</Button>
        {saveDir && <Button size="sm" variant="ghost" onClick={clear}>清除（回到资产库）</Button>}
      </div>
      <p className="ig-form-note" style={{ marginTop: 12 }}>
        目录句柄失效时该次自动落回资产库，不会丢图。
      </p>
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
    <div className="ig-set-section">
      {templates.length > 0 && (
        <div className="ig-row-list">
          {templates.map(t => (
            <div key={t.id} className="ig-tpl-row">
              <div className="ig-tpl-row-main">
                <div className="ig-tpl-row-title">{t.title}</div>
                <div className="ig-tpl-row-body" title={t.content}>{t.content}</div>
              </div>
              <button type="button" className="ig-act-btn" aria-label="编辑模板" title="编辑"
                onClick={() => setDraft({ id: t.id, title: t.title, content: t.content })}>
                <PencilIcon size={13} />
              </button>
              <button type="button" className="ig-act-btn" aria-label="删除模板" title="删除"
                onClick={() => save(templates.filter(x => x.id !== t.id))}>
                <TrashIcon size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {templates.length === 0 && <div className="ig-form-note">还没有模板。</div>}

      <div className="ig-form-section">
        <div className="ig-form-section-title">{draft.id ? '编辑模板' : '新增模板'}</div>
        <div className="ig-form-grid">
          <label className="ig-form-label">标题
            <Input value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })}
              placeholder="商品静物摄影" />
          </label>
          <label className="ig-form-label span2">内容
            <textarea className="pk-input ig-form-textarea" value={draft.content} rows={3}
              onChange={e => setDraft({ ...draft, content: e.target.value })}
              placeholder="白底棚拍，柔和顶光，居中构图，高细节" />
          </label>
        </div>
        <div className="ig-form-actions">
          {draft.id && (
            <Button size="sm" variant="ghost" onClick={() => setDraft({ id: '', title: '', content: '' })}>取消编辑</Button>
          )}
          <Button size="sm" variant="primary"
            disabled={!draft.title.trim() || !draft.content.trim()} onClick={upsert}>
            {draft.id ? '保存修改' : '添加模板'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/* —— 默认参数区 —— */
function DefaultsSection({ prefs, onChange }) {
  return (
    <div className="ig-form-grid">
      <label className="ig-form-label span2">默认尺寸
        <Segmented value={prefs.defaultSize} onChange={v => onChange({ ...prefs, defaultSize: v })}
          options={SIZE_OPTIONS.map(o => ({ label: o.label, value: o.value }))} ariaLabel="默认尺寸" />
      </label>
      <label className="ig-form-label">默认数量
        <Segmented value={String(prefs.defaultN)} onChange={v => onChange({ ...prefs, defaultN: Number(v) })}
          options={[1, 2, 3, 4].map(v => ({ label: String(v), value: String(v) }))} ariaLabel="默认数量" />
      </label>
      <label className="ig-form-label">默认质量
        <Segmented value={prefs.defaultQuality} onChange={v => onChange({ ...prefs, defaultQuality: v })}
          options={QUALITY_OPTIONS.map(o => ({ label: o.label, value: o.value }))} ariaLabel="默认质量" />
        <span className="ig-form-note">质量档位只对 gpt-image 类模型生效。</span>
      </label>
    </div>
  )
}

/**
 * OptimizerSection — 「优化提示词」用的语言模型。
 * 任何 OpenAI 兼容的 /chat/completions 都可以用（官方、中转站、本地模型）；密钥只写保险库。
 * 「优化标准」一栏如实写明每套标准的出处：只有 Gemini 那套来自厂商官方指南，其余是插件自撰。
 */
function OptimizerSection({ llm, imageModel, onChange, toast }) {
  const [draft, setDraft] = useState({ baseUrl: '', model: '', target: 'auto' })
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setDraft({
      baseUrl: llm?.baseUrl ?? '',
      model: llm?.model ?? '',
      // 存储里没有 target（或为空）= 跟随当前生图模型自动判断
      target: llm?.target || 'auto'
    })
  }, [llm])

  const autoTarget = detectTarget(imageModel)
  const activeTarget = draft.target === 'auto' ? autoTarget : draft.target
  const standard = getStandard(activeTarget)
  const hasKey = Boolean(llm?.secretRef)

  async function save() {
    setError('')
    if (!draft.baseUrl.trim() || !draft.model.trim()) { setError('接口地址与模型必填'); return }
    setBusy(true)
    try {
      const next = await saveLlm({
        baseUrl: draft.baseUrl, model: draft.model.trim(),
        secretRef: llm?.secretRef ?? '',
        // auto 不落盘：留空即「自动」，以后换了生图模型也跟着变
        target: draft.target === 'auto' ? '' : draft.target
      }, apiKey)
      setApiKey('')
      onChange(next)
      toast('语言模型已保存', 'success')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  async function test() {
    setTesting(true); setError('')
    try {
      await testLlm({
        baseUrl: draft.baseUrl, model: draft.model, secretRef: llm?.secretRef ?? ''
      }, { plainKey: apiKey })
      toast('连接正常', 'success')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setTesting(false) }
  }

  return (
    <div className="ig-set-section">
      <div className="ig-form-section">
        <div className="ig-form-section-head">
          <div className="ig-form-section-title" style={{ margin: 0 }}>语言模型</div>
          {isLlmConfigured(llm) && (
            <span className="ig-prov-status" data-state="ok"><CheckIcon size={12} />已配置{hasKey ? ' · 密钥已存' : ''}</span>
          )}
        </div>
        <div className="ig-form-grid">
          <label className="ig-form-label">接口地址
            <input className="pk-input" type="text" value={draft.baseUrl} spellCheck={false}
              placeholder="https://api.openai.com/v1"
              onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} />
          </label>
          <label className="ig-form-label">模型
            <input className="pk-input" type="text" value={draft.model} spellCheck={false}
              placeholder="gpt-4o-mini"
              onChange={e => setDraft({ ...draft, model: e.target.value })} />
          </label>
          <label className="ig-form-label span2">API Key
            <input className="pk-input" type="password" value={apiKey} spellCheck={false} autoComplete="off"
              placeholder={hasKey ? '已保存，留空表示不修改' : 'sk-…（本地模型可留空）'}
              onChange={e => setApiKey(e.target.value)} />
            <span className="ig-form-note">只存宿主保险库，页面与配置里不留明文。</span>
          </label>
        </div>
        <div className="ig-form-acts">
          {error && <span className="ig-form-error" role="alert">{error}</span>}
          {/* 次要按钮用共享 .pk-btn：与右侧「保存」同高（28px）。ig-act-btn 是 22px 的文字小按钮，
              用在卡片悬浮条/详情底部合适，和主按钮并排会矮一截 */}
          <button type="button" className="pk-btn" disabled={testing || busy || !isLlmConfigured(draft)} onClick={() => void test()}>
            {testing ? <span className="ig-spin" /> : '测试连接'}
          </button>
          <button type="button" className="pk-btn pk-btn-primary" disabled={busy} onClick={() => void save()}>保存</button>
        </div>
      </div>

      <div className="ig-form-section">
        <div className="ig-form-section-head">
          <div className="ig-form-section-title" style={{ margin: 0 }}>优化标准</div>
          <span className="ig-form-note">当前生图模型：{imageModel || '未选择'} → {standard.label}</span>
        </div>
        <div className="ig-form-grid">
          <label className="ig-form-label span2">目标生图模型
            <Segmented value={draft.target} onChange={v => setDraft({ ...draft, target: v })}
              options={[{ label: '自动', value: 'auto' }, ...TARGETS.map(t => ({ label: t.label, value: t.id }))]}
              ariaLabel="目标生图模型" />
            <span className="ig-form-note">
              {draft.target === 'auto'
                ? '按当前生图渠道的模型名自动选择。'
                : TARGETS.find(t => t.id === draft.target)?.hint}
            </span>
          </label>
        </div>
        <div className="ig-std-card">
          <div className="ig-std-head">
            <span className="ig-std-name">{standard.label}</span>
            <span className="ig-std-src" data-official={activeTarget === 'nano-banana' ? '' : undefined}>
              {activeTarget === 'nano-banana' ? '来源：Google 官方指南' : '来源：本插件整理'}
            </span>
          </div>
          <ol className="ig-std-rules">
            {standard.rules.map(rule => <li key={rule}>{rule}</li>)}
          </ol>
        </div>
        {activeTarget === 'gpt-image' && (
          <span className="ig-form-note">OpenAI 的官方提示词指南当时无法访问，以上是按通用原则整理的，不是 OpenAI 的官方文本。</span>
        )}
      </div>
    </div>
  )
}

export function SettingsDialog({ open, onOpenChange, section, onSectionChange, providers, onProvidersChanged, prefs, onPrefsChanged, saveDir, onSaveDirChanged, templates, onTemplatesChanged, toast, llm, onLlmChanged, imageModel }) {
  const [localTemplates, setLocalTemplates] = useState(templates)
  const [localSaveDir, setLocalSaveDir] = useState(saveDir)

  useEffect(() => { if (open) { setLocalTemplates(templates); setLocalSaveDir(saveDir) } }, [open, templates, saveDir])

  const active = SECTIONS.find(s => s.id === section) ?? SECTIONS[0]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogOverlay />
      <DialogContent className="ig-set-dialog" aria-label="AI 生图设置">
        <div className="ig-set-body">
          <nav className="ig-set-nav" aria-label="设置分组">
            <span className="ig-set-nav-title">设置</span>
            {SECTIONS.map(s => (
              <button key={s.id} type="button" className={`ig-set-nav-btn ${section === s.id ? 'active' : ''}`}
                aria-current={section === s.id ? 'page' : undefined}
                onClick={() => onSectionChange(s.id)}>
                <s.Icon size={15} /><span>{s.label}</span>
              </button>
            ))}
          </nav>
          <div className="ig-set-main">
            <div className="ig-set-head">
              <div className="ig-set-head-text">
                <DialogTitle className="ig-set-title">{active.label}</DialogTitle>
                <DialogDescription className="ig-set-desc">{active.desc}</DialogDescription>
              </div>
              <button type="button" className="ig-set-close" aria-label="关闭设置" title="关闭设置"
                onClick={() => onOpenChange(false)}>
                <XIcon size={15} />
              </button>
            </div>
            <div className="ig-set-content">
              {section === 'providers' && <ProviderSection providers={providers} onChange={onProvidersChanged} toast={toast} />}
              {section === 'optimizer' && (
                <OptimizerSection llm={llm} imageModel={imageModel} onChange={onLlmChanged} toast={toast} />
              )}
              {section === 'saveDir' && (
                <SaveDirSection saveDir={localSaveDir}
                  onChange={async next => { setLocalSaveDir(next); onSaveDirChanged(next) }}
                  toast={toast} />
              )}
              {section === 'templates' && (
                <TemplateSection templates={localTemplates}
                  onChange={next => { setLocalTemplates(next); onTemplatesChanged(next) }} />
              )}
              {section === 'defaults' && <DefaultsSection prefs={prefs} onChange={onPrefsChanged} />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export { loadTemplates, saveTemplates, loadSaveDir, saveSaveDir, SAVE_DIR_KEY, TEMPLATES_KEY }
