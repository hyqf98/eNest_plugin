import { useCallback, useEffect, useMemo, useState } from 'react'
import { call } from '../js/api.js'
import { notifyError, notifyOk } from '../js/notify.js'
import { ErrorBox, Loading } from './widgets.jsx'

/** 数据源页：源仓库（内置+官方+社区合并单列表，tag 区分，已装置顶）+ 手动添加 */
export function SourcesPage({ sources, onChanged }) {
  return (
    <div className="ch-sources">
      <RepoSection sources={sources} onChanged={onChanged} />
      <ImportSection onChanged={onChanged} />
    </div>
  )
}

/* ---------------- 源仓库（合并列表） ---------------- */
function RepoSection({ sources, onChanged }) {
  const [builtin, setBuiltin] = useState([])
  const [remote, setRemote] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyName, setBusyName] = useState('')

  const reload = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [bl, rm] = await Promise.all([
        call('sources.builtinList').then(l => l ?? [], () => []),
        call('sources.repos').then(async repoList => {
          const results = await Promise.allSettled(repoList.map(r =>
            call('sources.repoIndex', [r.url]).then(entries => entries.map(e => ({ ...e, origin: r.name })))
          ))
          return results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
        }),
      ])
      setBuiltin(bl)
      setRemote(rm)
    } catch (e) {
      notifyError(e)
      setError('在线仓库拉取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])


  // 合并条目：内置在前；按显示名（源声明中文名）去重，内置优先；已装置顶
  const entries = useMemo(() => {
    const byName = new Map()
    for (const b of builtin) {
      if (!b.name) continue
      byName.set(b.name, {
        name: b.name, version: b.version || '', description: b.adult ? '成人内容，请自行斟酌' : '', url: '', adult: b.adult,
        builtinKey: b.key, origin: '内置',
      })
    }
    for (const e of remote) {
      if (!e.name || byName.has(e.name)) continue
      byName.set(e.name, { ...e, origin: e.origin || '官方' })
    }
    const list = [...byName.values()]
    const installedNames = new Set(sources.map(s => s.name))
    const installedKeys = new Set(sources.map(s => s.key))
    return list.sort((a, b) => {
      const aOn = installedNames.has(a.name) || (a.builtinKey && installedKeys.has(a.builtinKey)) ? 0 : 1
      const bOn = installedNames.has(b.name) || (b.builtinKey && installedKeys.has(b.builtinKey)) ? 0 : 1
      return aOn - bOn
    })
  }, [builtin, remote, sources])

  const uninstall = async (key) => {
    setBusyName(key); setError('')
    try {
      const r = await call('sources.remove', [key])
      const c = r?.cleaned
      if (c) {
        const parts = []
        if (c.history) parts.push(`${c.history} 条历史`)
        if (c.favorites) parts.push(`${c.favorites} 个收藏`)
        if (c.progress) parts.push(`${c.progress} 条进度`)
        if (c.cache) parts.push(`${c.cache} 部缓存`)
        notifyOk(parts.length ? `已卸载，同时清除 ${parts.join('、')}` : '已卸载')
      }
      await onChanged()
    } catch (e) {
      notifyError(e)
    } finally { setBusyName('') }
  }

  const install = async (entry) => {
    setBusyName(entry.name); setError('')
    try {
      if (entry.builtinKey) await call('sources.installBuiltinOne', [entry.builtinKey])
      else {
        const installed = sources.find(s => s.name === entry.name)
        if (installed?.key) await call('sources.update', [installed.key]).catch(async err => {
          const msg = String(err?.message || '')
          if (msg.includes('更新地址')) await call('sources.installFromUrl', [entry.url, entry.name])
          else throw err
        })
        else await call('sources.installFromUrl', [entry.url, entry.name])
      }
      await onChanged()
    } catch (e) {
      notifyError(e)
    } finally { setBusyName('') }
  }

  const installedCount = sources.length

  return (
    <section className="ch-src-card">
      <h3>源仓库{installedCount ? <span className="pk-muted ch-src-count">已装 {installedCount}</span> : null}</h3>
      {loading && <Loading label="加载源列表中…" />}
      {error && <ErrorBox message={error} onRetry={() => void reload()} />}
      {!loading && !error && (
        <ul className="ch-repo-list">
          {entries.map(e => {
            const installed = sources.find(s => s.name === e.name || (e.builtinKey && s.key === e.builtinKey))
            const updatable = installed && e.version && e.version !== installed.version
            return (
              <li className="ch-repo-row" key={e.builtinKey || e.url}>
                <div className="ch-src-info">
                  <span className="ch-src-name">
                    {e.name}
                    <span className="pk-badge ch-origin-tag">{e.origin}</span>
                    {e.adult && <span className="pk-badge pk-badge-warn ch-adult-tag">成人</span>}
                    {updatable && <span className="pk-badge pk-badge-ok ch-adult-tag">可更新</span>}
                  </span>
                  <span className="ch-src-meta pk-muted">
                    {installed ? `已装 v${installed.version}${updatable ? ` → v${e.version}` : ''}` : (e.description || '')}
                  </span>
                </div>
                <div className="ch-src-actions">
                  <button
                    className={`pk-btn pk-btn-sm${updatable ? ' ch-update-btn' : ''}`}
                    disabled={!!busyName}
                    onClick={() => void install(e)}
                  >
                    {busyName === e.name ? '处理中…' : installed ? (updatable ? '更新' : '重装') : '安装'}
                  </button>
                  {installed && (
                    <button
                      className="pk-btn pk-btn-sm ch-danger"
                      disabled={!!busyName}
                      title={`卸载 ${installed.name}`}
                      onClick={() => {
                        if (confirm(`卸载数据源「${installed.name}」？\n\n该源的阅读历史、收藏、进度、缓存与私有数据也会一并清除，此操作不可撤销。`)) void uninstall(installed.key)
                      }}
                    >卸载</button>
                  )}
                </div>
              </li>
            )
          })}
          {!entries.length && <div className="ch-empty">仓库为空</div>}
        </ul>
      )}
      {!loading && !error && (
        <p className="pk-muted ch-note">「内置」随插件包离线可装；「官方 / 社区」为在线仓库，需联网拉取。成人源请自行斟酌安装。</p>
      )}
    </section>
  )
}

/* ---------------- 手动添加 ---------------- */
function ImportSection({ onChanged }) {
  const [mode, setMode] = useState('url')  // url | text
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')

  const submit = async () => {
    setBusy(true); setError(''); setOkMsg('')
    try {
      const meta = mode === 'url'
        ? await call('sources.installFromUrl', [url.trim()])
        : await call('sources.installFromText', [text])
      notifyOk(`已安装：${meta.name}`)
      setUrl(''); setText('')
      await onChanged()
    } catch (e) {
      notifyError(e)
      setError('添加失败')
    } finally { setBusy(false) }
  }

  return (
    <section className="ch-src-card">
      <h3>添加数据源</h3>
      {mode === 'url' ? (
        <form className="ch-import-form" onSubmit={e => { e.preventDefault(); void submit() }}>
          <input
            className="pk-input"
            type="url"
            placeholder="输入 .js 源或仓库 index.json 地址"
            value={url}
            onChange={e => setUrl(e.target.value)}
            aria-label="数据源地址"
          />
          <button className="pk-btn" type="submit" disabled={busy || !url.trim()}>
            {busy ? '添加中…' : '新增'}
          </button>
          <button type="button" className="ch-seg" onClick={() => setMode('text')}>粘贴脚本</button>
        </form>
      ) : (
        <form className="ch-import-form" onSubmit={e => { e.preventDefault(); void submit() }}>
          <textarea
            className="pk-input"
            rows={4}
            placeholder="粘贴源脚本（class X extends ComicSource {…}）"
            value={text}
            onChange={e => setText(e.target.value)}
            aria-label="源脚本"
          />
          <button className="pk-btn" type="submit" disabled={busy || !text.trim()}>
            {busy ? '添加中…' : '新增'}
          </button>
          <button type="button" className="ch-seg" onClick={() => setMode('url')}>改用地址</button>
        </form>
      )}
      {error && <ErrorBox message={error} />}
      <p className="pk-muted ch-note">仅支持 http(s) 地址；源脚本在插件后端的隔离沙箱中运行，仅按地址读取，不收集任何数据。</p>
    </section>
  )
}
