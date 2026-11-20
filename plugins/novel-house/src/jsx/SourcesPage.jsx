import { useCallback, useEffect, useMemo, useState } from 'react'
import { call } from '../js/api.js'
import { notifyError, notifyOk } from '../js/notify.js'
import { ErrorBox } from './widgets.jsx'

/** 书源页：源仓库（内置+在线合并单列表，tag 区分，已装置顶）+ 手动导入 */
export function SourcesPage({ sources, onChanged }) {
  return (
    <div className="nh-sources">
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

  // 合并条目：内置在前；按显示名去重，内置优先；已装置顶
  const entries = useMemo(() => {
    const byName = new Map()
    for (const b of builtin) {
      if (!b.name) continue
      byName.set(b.name, {
        name: b.name, version: b.version || '', description: b.group || '', url: '',
        builtinKey: b.key, origin: '内置',
      })
    }
    for (const e of remote) {
      if (!e.name || byName.has(e.name)) continue
      byName.set(e.name, { ...e, origin: e.origin || '在线' })
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
      await call('sources.remove', [key])
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
        // 在线仓库条目：整仓批量导入（按 bookSourceUrl 去重幂等）
        await call('sources.installFromUrl', [entry.url])
      }
      await onChanged()
      notifyOk(`书源「${entry.name}」已就绪`)
    } catch (e) {
      notifyError(e)
    } finally { setBusyName('') }
  }

  const installedCount = sources.length

  return (
    <section className="nh-src-card">
      <h3>书源仓库{installedCount ? <span className="pk-muted nh-src-count">已装 {installedCount}</span> : null}</h3>
      <p className="pk-muted nh-note">兼容 Legado（阅读3.0）书源格式：仓库导入为整仓批量，自动按源地址去重。</p>
      {loading && <div className="nh-empty">加载书源列表…</div>}
      {error && <ErrorBox message={error} onRetry={() => void reload()} />}
      {!loading && !error && (
        <ul className="nh-repo-list">
          {entries.map(e => {
            const installed = sources.find(s => s.name === e.name || (e.builtinKey && s.key === e.builtinKey))
            return (
              <li className="nh-repo-row" key={e.builtinKey || e.url + e.originUrl}>
                <div className="nh-src-info">
                  <span className="nh-src-name">
                    {e.name}
                    <span className="pk-badge nh-origin-tag">{e.origin}</span>
                  </span>
                  <span className="nh-src-meta pk-muted">
                    {installed ? `已装 · ${installed.group || '无分组'}` : (e.description || '')}
                  </span>
                </div>
                <div className="nh-src-actions">
                  <button
                    className="pk-btn pk-btn-sm"
                    disabled={!!busyName}
                    onClick={() => void install(e)}
                  >
                    {busyName === e.name ? '处理中…' : installed ? (e.builtinKey ? '重装' : '更新') : '安装'}
                  </button>
                  {installed && (
                    <button
                      className="pk-btn pk-btn-sm nh-danger"
                      disabled={!!busyName}
                      title={`卸载 ${installed.name}`}
                      onClick={() => { if (confirm(`卸载书源「${installed.name}」？`)) void uninstall(installed.key) }}
                    >卸载</button>
                  )}
                </div>
              </li>
            )
          })}
          {!entries.length && <div className="nh-empty">仓库为空</div>}
        </ul>
      )}
    </section>
  )
}

/* ---------------- 手动导入 ---------------- */
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
      const r = mode === 'url'
        ? await call('sources.installFromUrl', [url.trim()])
        : await call('sources.installFromText', [text])
      notifyOk(`已导入 ${r.installed} 个书源${r.failed ? `（${r.failed} 个跳过）` : ''}`)
      setUrl(''); setText('')
      await onChanged()
    } catch (e) {
      notifyError(e)
      setError('导入失败')
    } finally { setBusy(false) }
  }

  return (
    <section className="nh-src-card">
      <h3>导入书源</h3>
      {mode === 'url' ? (
        <form className="nh-import-form" onSubmit={e => { e.preventDefault(); void submit() }}>
          <input
            className="pk-input"
            type="url"
            placeholder="书源 JSON 地址（对象或数组）"
            value={url}
            onChange={e => setUrl(e.target.value)}
            aria-label="书源地址"
          />
          <button className="pk-btn" type="submit" disabled={busy || !url.trim()}>
            {busy ? '导入中…' : '导入'}
          </button>
          <button type="button" className="nh-seg" onClick={() => setMode('text')}>粘贴 JSON</button>
        </form>
      ) : (
        <form className="nh-import-form" onSubmit={e => { e.preventDefault(); void submit() }}>
          <textarea
            className="pk-input"
            rows={4}
            placeholder="粘贴 Legado 书源 JSON（单个对象或数组，可批量）"
            value={text}
            onChange={e => setText(e.target.value)}
            aria-label="书源 JSON"
          />
          <button className="pk-btn" type="submit" disabled={busy || !text.trim()}>
            {busy ? '导入中…' : '导入'}
          </button>
          <button type="button" className="nh-seg" onClick={() => setMode('url')}>改用地址</button>
        </form>
      )}
      {error && <ErrorBox message={error} />}
      <p className="pk-muted nh-note">书源规则在插件后端的隔离沙箱中解析执行；出网请求由后端统一代理转发，不收集任何数据。</p>
    </section>
  )
}
