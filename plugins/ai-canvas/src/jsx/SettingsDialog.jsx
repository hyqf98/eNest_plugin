/**
 * SettingsDialog — 弹框设置（pk-Dialog + 左侧窄图标导航）。
 * 分组：图像 API / 大模型 Chat / 默认参数 / 外观 / 存储。
 * 密钥只写 vault（secretRef），编辑时留空 = 保持不变。
 */
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogDescription, Button, Input, Segmented, Select, Slider } from '../ui/index.jsx'
import { normalizeBaseUrl, upsertProvider, removeProvider, PROVIDER_KIND } from '../js/providers.mjs'
import { openaiImagesProtocol, openaiChatProtocol } from '../js/providers.mjs'
import { PAPERS } from '../js/theme.mjs'
import { storageUsage } from '../js/assets.mjs'
import { listAssets, deleteAsset } from '../js/assets.mjs'

const SECTIONS = [
  { id: 'images', glyph: '✦', label: '图像 API' },
  { id: 'chat', glyph: '☄', label: '大模型' },
  { id: 'defaults', glyph: '⚙', label: '默认参数' },
  { id: 'appearance', glyph: '✎', label: '外观' },
  { id: 'storage', glyph: '▣', label: '存储' }
]

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

const KIND_META = {
  [PROVIDER_KIND.IMAGES]: {
    defaultModel: 'gpt-image-1',
    desc: 'OpenAI Images 协议（文生图 / 图生图）。地址填到根或 /v1 均可，软件自动拼接 /images/generations 与 /images/edits；one-api / new-api 等中转站同样适用。密钥仅存宿主保险库，页面不留明文。',
    test: provider => openaiImagesProtocol.test(provider)
  },
  [PROVIDER_KIND.CHAT]: {
    defaultModel: 'gpt-4o-mini',
    desc: 'OpenAI Chat Completions 协议，供「LLM 提示词优化」节点调用大模型。地址填到根或 /v1 均可，软件自动拼接 /chat/completions；兼容任意 OpenAI 风格中转站与自建网关。',
    test: provider => openaiChatProtocol.test(provider)
  }
}

/** 按 kind 复用的供应商 CRUD（images / chat 共用逻辑，只差路径与默认模型） */
function ProviderSection({ kind, providers, onChange }) {
  const meta = KIND_META[kind]
  const list = providers.filter(p => (p.kind ?? PROVIDER_KIND.IMAGES) === kind)
  const [draft, setDraft] = useState({ id: '', name: '', baseUrl: '', model: meta.defaultModel })
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState('')
  const [testResult, setTestResult] = useState(null)
  const [error, setError] = useState('')

  const reset = () => { setDraft({ id: '', name: '', baseUrl: '', model: meta.defaultModel }); setApiKey('') }

  async function addOrUpdate() {
    setError('')
    if (!draft.name.trim() || !draft.baseUrl.trim()) { setError('名称与地址必填'); return }
    setBusy(true)
    try {
      const id = draft.id || `p${Date.now().toString(36)}`
      const makingDefault = !list.length || !list.some(p => p.isDefault)
      await upsertProvider({ id, name: draft.name.trim(), baseUrl: draft.baseUrl, model: draft.model.trim() || meta.defaultModel, kind, isDefault: draft.isDefault || makingDefault }, apiKey)
      onChange()
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  async function test(provider) {
    setTesting(provider.id); setTestResult(null)
    try {
      await meta.test(provider)
      setTestResult({ id: provider.id, ok: true, message: '连接成功' })
    } catch (err) {
      setTestResult({ id: provider.id, ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally { setTesting('') }
  }

  return <div className="ac-set-section">
    <p className="ac-set-desc">{meta.desc}</p>
    <div className="ac-provider-list">
      {list.length === 0 && <div className="ac-provider-empty">还没有供应商，先在下方添加一个。</div>}
      {list.map(p => (
        <div key={p.id} className="ac-provider-row">
          <div className="ac-provider-main">
            <div className="ac-provider-title">
              <strong>{p.name}</strong>
              {p.isDefault && <span className="ac-tag">默认</span>}
              {testResult?.id === p.id && <span className={`ac-tag ${testResult.ok ? 'ac-tag-ok' : 'ac-tag-err'}`}>{testResult.message.slice(0, 60)}</span>}
            </div>
            <div className="ac-provider-sub" title={p.baseUrl}>{p.baseUrl} · {p.model}{p.secretRef ? ' · 密钥已保管' : ' · 未配密钥'}</div>
          </div>
          <div className="ac-provider-actions">
            <Button size="sm" variant="ghost" disabled={testing === p.id} onClick={() => test(p)}>{testing === p.id ? '测试中…' : '测试'}</Button>
            {!p.isDefault && <Button size="sm" variant="ghost" onClick={async () => { await upsertProvider({ ...p, isDefault: true }); onChange() }}>设为默认</Button>}
            <Button size="sm" variant="ghost" onClick={() => setDraft({ id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, isDefault: p.isDefault })}>编辑</Button>
            <Button size="sm" variant="danger" onClick={async () => { await removeProvider(p.id); onChange() }}>删除</Button>
          </div>
        </div>
      ))}
    </div>
    <div className="ac-provider-form">
      <div className="ac-provider-form-title">{draft.id ? '编辑供应商' : '添加供应商'}</div>
      <div className="ac-form-grid">
        <label>名称<Input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder={kind === PROVIDER_KIND.CHAT ? '如 OpenAI Chat / 某中转站' : '如 OpenAI 官方 / 某中转站'} /></label>
        <label>模型<Input value={draft.model} onChange={e => setDraft({ ...draft, model: e.target.value })} placeholder={meta.defaultModel} /></label>
        <label className="ac-form-wide">接口地址（baseUrl）<Input value={draft.baseUrl} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" /></label>
        <label className="ac-form-wide">API Key{draft.id ? '（留空 = 保持不变）' : ''}<Input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-…" autoComplete="off" /></label>
      </div>
      {error && <div className="ac-error" role="alert">{error}</div>}
      <div className="ac-form-actions">
        {draft.id && <Button size="sm" variant="ghost" onClick={reset}>取消编辑</Button>}
        <Button size="sm" variant="primary" disabled={busy} onClick={addOrUpdate}>{draft.id ? '保存修改' : '添加'}</Button>
      </div>
    </div>
  </div>
}

function DefaultsSection({ prefs, onChange }) {
  return <div className="ac-set-section">
    <p className="ac-set-desc">新生成/编辑类节点的初始参数（每个节点仍可单独调整）。</p>
    <div className="ac-form-grid">
      <label>默认尺寸
        <Select value={prefs.defaultSize} onChange={v => onChange({ ...prefs, defaultSize: v })} options={[
          { label: '自动', value: 'auto' }, { label: '1024 × 1024', value: '1024x1024' },
          { label: '1536 × 1024', value: '1536x1024' }, { label: '1024 × 1536', value: '1024x1536' }
        ]} />
      </label>
      <label>默认质量
        <Select value={prefs.defaultQuality} onChange={v => onChange({ ...prefs, defaultQuality: v })} options={[
          { label: '自动', value: 'auto' }, { label: '低', value: 'low' }, { label: '中', value: 'medium' }, { label: '高', value: 'high' }
        ]} />
      </label>
    </div>
  </div>
}

function AppearanceSection({ prefs, onChange }) {
  return <div className="ac-set-section">
    <p className="ac-set-desc">纸感主题与手绘抖动幅度（仅影响本插件画布）。选「跟随系统」时按系统明暗自动切换纸面。</p>
    <div className="ac-form-col">
      <label>纸面
        <Segmented value={prefs.paper} onChange={v => onChange({ ...prefs, paper: v })}
          options={PAPERS.map(p => ({ label: p.label, value: p.id }))} ariaLabel="纸面主题" />
      </label>
      <label>抖动幅度
        <span className="ac-slider-row"><Slider value={[prefs.roughness]} min={0} max={2} step={0.1}
          onValueChange={([v]) => onChange({ ...prefs, roughness: v })} /><em>{prefs.roughness.toFixed(1)}</em></span>
      </label>
      <label>点阵网格
        <Segmented value={prefs.grid} onChange={v => onChange({ ...prefs, grid: v })}
          options={[{ label: '点阵', value: 'dots' }, { label: '空白', value: 'none' }]} ariaLabel="点阵网格" />
      </label>
    </div>
  </div>
}

function StorageSection({ onChanged }) {
  const [usage, setUsage] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  async function refresh() { setUsage(await storageUsage()) }
  useEffect(() => { refresh() }, [])
  async function clearAll() {
    setBusy(true)
    try {
      for (const asset of await listAssets()) await deleteAsset(asset.assetId)
      await refresh(); onChanged?.()
    } finally { setBusy(false); setConfirming(false) }
  }
  return <div className="ac-set-section">
    <p className="ac-set-desc">生成图片存于 eNest 数据根下本插件私有目录（与其他插件相互隔离），配额 1 GB。</p>
    <div className="ac-storage-row">
      <span>{usage ? `${usage.count} 张 · ${formatBytes(usage.bytes)} / 1 GB` : '统计中…'}</span>
      {confirming
        ? <span className="ac-storage-confirm">
            <Button size="sm" variant="danger" disabled={busy} onClick={clearAll}>确认清空</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>取消</Button>
          </span>
        : <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} disabled={!usage?.count}>清空全部</Button>}
    </div>
  </div>
}

export function SettingsDialog({ open, onOpenChange, providers, onProvidersChanged, prefs, onPrefsChanged }) {
  const [section, setSection] = useState('images')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ac-dialog">
        <div className="ac-dialog-body">
          <nav className="ac-dialog-nav" role="navigation" aria-label="设置分组">
            {SECTIONS.map(s => (
              <button key={s.id} type="button" className={`ac-dialog-nav-btn ${section === s.id ? 'ac-dialog-nav-active' : ''}`}
                title={s.label} onClick={() => setSection(s.id)}>
                <span aria-hidden>{s.glyph}</span><span className="ac-dialog-nav-label">{s.label}</span>
              </button>
            ))}
          </nav>
          <div className="ac-dialog-main">
            <DialogTitle className="ac-dialog-title">AI 画布 · 设置</DialogTitle>
            <DialogDescription className="ac-dialog-desc">{SECTIONS.find(s => s.id === section)?.label}</DialogDescription>
            {section === 'images' && <ProviderSection kind={PROVIDER_KIND.IMAGES} providers={providers} onChange={onProvidersChanged} />}
            {section === 'chat' && <ProviderSection kind={PROVIDER_KIND.CHAT} providers={providers} onChange={onProvidersChanged} />}
            {section === 'defaults' && <DefaultsSection prefs={prefs} onChange={onPrefsChanged} />}
            {section === 'appearance' && <AppearanceSection prefs={prefs} onChange={onPrefsChanged} />}
            {section === 'storage' && <StorageSection onChanged={onProvidersChanged} />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
