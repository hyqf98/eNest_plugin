import { useCallback, useEffect, useState } from 'react'
import { call, clearHistory, loadFavorites, loadHistory, removeHistoryEntry } from '../js/api.js'
import { extractQuality } from './HomePage.jsx'
import { Empty, ErrorBox, useKit } from './widgets.jsx'

/** 配置/设置页：数据源直接展开（当前配置的全部站点，可启停）+ 配置地址管理 + 多仓线路 */
export function ConfigPage({ onConfigChanged }) {
  const [list, setList] = useState([])
  const [sites, setSites] = useState([])
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [depot, setDepot] = useState(null)   // 多仓线路选择
  const [notice, setNotice] = useState('')
  const kit = useKit()

  const refresh = useCallback(async () => {
    setError('')
    try {
      setList(await call('config.list'))
      const current = await call('config.current')
      setNotice(current?.notice ?? '')
      setSites(await call('site.list'))
    } catch (e) {
      setError(e?.message || String(e))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const addConfig = async () => {
    if (!url.trim() || busy) return
    setBusy(true); setError('')
    try {
      const result = await call('config.add', [url.trim(), name.trim()], { timeoutMs: 90_000 })
      if (result?.depot?.length && !result?.id) {
        // 多仓入口：展示线路选择
        setDepot(result.depot)
      } else {
        await call('config.use', [result.id])
        setUrl(''); setName(''); setAdding(false)
        onConfigChanged?.()
      }
      await refresh()
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const useDepotLine = async lineUrl => {
    setBusy(true); setError('')
    try {
      const result = await call('config.add', [lineUrl, ''], { timeoutMs: 90_000 })
      if (result?.id) await call('config.use', [result.id])
      setDepot(null); setUrl(''); setAdding(false)
      onConfigChanged?.()
      await refresh()
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tb-body">
      {/* 数据源（单一管理卡）：站点直接展开 + 右侧「添加数据源」 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0 12px' }}>
        <span style={{ fontSize: 14, fontWeight: 650 }}>数据源</span>
        <span className="tb-muted" style={{ flex: 1 }}>{sites.length ? `${sites.length} 个站点 · 勾选启停` : ''}</span>
        <button className="pk-btn pk-btn-sm" onClick={() => setAdding(!adding)}>{adding ? '取消添加' : '+ 添加数据源'}</button>
      </div>
      <ErrorBox error={error} onRetry={refresh} />
      {notice ? <div className="tb-error" style={{ marginBottom: 10 }}>{notice}</div> : null}

      {adding ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <input className="pk-input tb-flat-input" style={{ flex: 2, minWidth: 260 }} placeholder="配置地址 https://…/tvbox.json（导入 TVBox/影视仓配置或多仓线路）" value={url} onChange={e => setUrl(e.target.value)} />
          <input className="pk-input tb-flat-input" style={{ flex: 1, minWidth: 120 }} placeholder="名称（可选）" value={name} onChange={e => setName(e.target.value)} />
          <button className="pk-btn" disabled={busy || !url.trim()} onClick={addConfig}>{busy ? '导入中…' : '导入'}</button>
        </div>
      ) : null}

      {depot ? (
        <div className="tb-config-list" style={{ marginBottom: 12 }}>
          <div className="tb-muted" style={{ padding: 4 }}>该地址是多仓入口，选择一条线路：</div>
          {depot.map((line, i) => (
            <div key={i} className="tb-config-item">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="name">{line.name}</div>
                <div className="url">{line.url}</div>
              </div>
              <button className="pk-btn pk-btn-sm" disabled={busy} onClick={() => useDepotLine(line.url)}>使用</button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="tb-config-list">
        {/* 自定义配置：切换/重载/删除（当前配置的站点在其下方展开） */}
        {list.filter(c => c.url).map(c => (
          <div key={c.id} className={`tb-config-item${c.current ? ' is-current' : ''}`} style={{ marginTop: 14, borderTop: '1px solid var(--border, #d8d5cf)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="name">{c.name}{c.current ? '（当前）' : ''}</div>
              <div className="url">{c.url} · {c.sites} 站点</div>
            </div>
            {!c.current ? <button className="pk-btn pk-btn-sm" onClick={async () => { try { await call('config.use', [c.id]); onConfigChanged?.(); await refresh() } catch (e) { setError(e?.message || String(e)) } }}>切换</button> : null}
            {c.current ? <button className="pk-btn pk-btn-sm" onClick={async () => { try { await call('config.reload'); onConfigChanged?.(); await refresh() } catch (e) { setError(e?.message || String(e)) } }}>重载</button> : null}
            <button className="pk-btn pk-btn-sm" onClick={async () => {
              if (!window.confirm(`删除配置「${c.name}」？`)) return
              try { await call('config.remove', [c.id]); onConfigChanged?.(); await refresh() } catch (e) { setError(e?.message || String(e)) }
            }}>删除</button>
          </div>
        ))}
        {/* 站点（当前配置的数据源） */}
        {sites.map(s => (
          <div key={s.key} className={`tb-config-item${s.disabled ? '' : ' is-current'}`} style={{ opacity: s.disabled ? .55 : 1 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="name">{s.name}</div>
              <div className="url">{s.error ? `⚠ ${s.error}` : `t${s.type}${s.searchable !== 0 ? ' · 可搜索' : ' · 仅浏览'}`}</div>
            </div>
            {s.changeable !== 0 ? (
              <input
                type="checkbox"
                checked={!s.disabled}
                onChange={async e => {
                  const disabled = !e.target.checked
                  setSites(prev => prev.map(x => x.key === s.key ? { ...x, disabled } : x))
                  try { await call('site.setEnabled', [s.key, disabled]) } catch (err) { kit?.toast(err?.message || String(err)) }
                }}
              />
            ) : null}
          </div>
        ))}
        {!sites.length && !error ? <Empty>还没有数据源；点右上「添加数据源」导入配置地址</Empty> : null}
      </div>
    </div>
  )
}

/** 收藏 / 历史：卡片墙（封面 + 副行；历史按时间倒序，点卡片续播/进详情） */
export function ListPage({ mode, onOpenVod, onPlayResume }) {
  const [list, setList] = useState(null)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    setError('')
    try {
      const raw = mode === 'history' ? await loadHistory() : await loadFavorites()
      // 历史按观看时间倒序（saveHistoryEntry 头插已近似，这里显式按 at 排序兜底）
      setList([...raw].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)))
    } catch (e) {
      setError(e?.message || String(e))
    }
  }, [mode])

  useEffect(() => { setList(null); void refresh() }, [refresh])

  return (
    <div className="tb-body">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0 12px' }}>
        <span style={{ fontSize: 14, fontWeight: 650 }}>{mode === 'history' ? '观看历史' : '我的收藏'}</span>
        <span className="tb-muted" style={{ flex: 1 }}>{list?.length ? `${list.length} 部` : ''}</span>
        {mode === 'history' && list?.length ? <button className="pk-btn pk-btn-sm" onClick={async () => { await clearHistory(); await refresh() }}>清空</button> : null}
      </div>
      <ErrorBox error={error} onRetry={refresh} />
      {list ? (
        <>
          <div className="tb-grid">
            {list.map(h => (
              <ListCard
                key={`${h.siteKey}-${h.vodId}`}
                item={h}
                mode={mode}
                onOpen={() => (mode === 'history' ? onPlayResume?.(h) : onOpenVod?.(h))}
                onRemove={mode === 'history' ? async e => { e.stopPropagation(); await removeHistoryEntry(h.siteKey, h.vodId); await refresh() } : null}
              />
            ))}
          </div>
          {!list.length ? <Empty>{mode === 'history' ? '还没有观看记录' : '还没有收藏，去详情页点收藏吧'}</Empty> : null}
        </>
      ) : <div className="tb-muted" style={{ padding: 20 }}>加载中…</div>}
    </div>
  )
}

/** 历史/收藏卡片：封面 + 名称 + 副行（历史：看到哪集/进度；收藏：站点/备注） */
function ListCard({ item, mode, onOpen, onRemove }) {
  const [src, setSrc] = useState('')
  const [hover, setHover] = useState(false)
  useEffect(() => {
    let alive = true
    void import('../js/api.js').then(async ({ loadPoster }) => {
      const url = await loadPoster(item.vodPic, item.siteKey)
      if (alive) setSrc(url)
    })
    return () => { alive = false }
  }, [item.vodPic, item.siteKey])
  const sub = mode === 'history'
    ? [item.episodeName, item.positionSec > 10 ? `看到 ${Math.floor(item.positionSec / 60)} 分` : '', item.siteName].filter(Boolean).join(' · ')
    : [item.siteName, item.remarks].filter(Boolean).join(' · ')
  return (
    <div
      className="tb-card"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={item.vodName}
    >
      <div className="tb-card-poster">
        {src ? <img src={src} alt={item.vodName} loading="lazy" /> : <div className="tb-card-fallback">🎬</div>}
        {(() => {
          const q = item.quality ? { label: item.quality, cls: item.quality === 'HD' ? 'hd' : '' } : extractQuality(item.vodName, item.remarks)
          return q ? <span className={`tb-card-quality ${q.cls}`}>{q.label}</span> : null
        })()}
        {mode === 'history' && item.positionSec > 10 ? <span className="tb-card-remark">{item.episodeName || Math.floor(item.positionSec / 60) + '分'}</span> : null}
        {mode === 'keep' && item.remarks ? <span className="tb-card-remark">{item.remarks}</span> : null}
        {hover && onRemove ? (
          <button
            className="tb-card-remove"
            title="移除该记录"
            onClick={e => { e.stopPropagation(); void onRemove(e) }}
          >✕</button>
        ) : null}
      </div>
      <div className="tb-card-info">
        <div className="tb-card-name">{item.vodName || item.vod_name}</div>
        {sub ? <div className="tb-card-sub">{sub}</div> : null}
        <div className="tb-card-sub" style={{ color: 'var(--text-3, #9aa1ab)' }}>{new Date(item.at).toLocaleDateString()}</div>
      </div>
    </div>
  )
}
