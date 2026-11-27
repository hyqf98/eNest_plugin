import { useCallback, useEffect, useState } from 'react'
import { call } from '../js/api.js'
import { Empty, ErrorBox, useKit } from './widgets.jsx'

/**
 * 网盘源页（OpenList/AList）：
 * - 添加站点（URL 探测 → 打开登录页 → 粘贴 token 回填校验）
 * - 账号记录持久化；401 过期标红提示重新授权
 * - 目录浏览（文件夹下钻 + 视频文件直接播放）
 */
export function CloudPage() {
  const [accounts, setAccounts] = useState([])
  const [states, setStates] = useState({})
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [loginPrompt, setLoginPrompt] = useState(null)   // {id, loginUrl} 需要授权的账号
  const [browse, setBrowse] = useState(null)             // {account, path, items}
  const kit = useKit()

  const refresh = useCallback(async () => {
    setError('')
    try {
      const list = await call('openlist.accounts')
      setAccounts(list)
      const checks = {}
      await Promise.all(list.map(async a => {
        try { checks[a.id] = await call('openlist.check', [a.id]) } catch { checks[a.id] = { state: 'error' } }
      }))
      setStates(checks)
    } catch (e) {
      setError(e?.message || String(e))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const add = async () => {
    if (!url.trim() || busy) return
    setBusy(true); setError('')
    try {
      const account = await call('openlist.add', [url.trim(), token.trim(), name.trim()], { timeoutMs: 30_000 })
      setUrl(''); setName(''); setToken(''); setAdding(false)
      if (account.needLogin) setLoginPrompt(account)
      await refresh()
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const openFolder = async (account, path) => {
    setError('')
    try {
      const result = await call('openlist.list', [account.id, path, 1], { timeoutMs: 30_000 })
      setBrowse({ account, path, items: result.items ?? [] })
    } catch (e) {
      if (String(e?.message).includes('401')) {
        setStates(prev => ({ ...prev, [account.id]: { state: 'expired' } }))
        setLoginPrompt({ id: account.id })
      } else setError(e?.message || String(e))
    }
  }

  const playFile = async (account, path) => {
    try {
      const play = await call('openlist.play', [account.id, path], { timeoutMs: 30_000 })
      window.open(play.url, '_blank') // 简化：交给系统播放器/浏览器
    } catch (e) {
      if (String(e?.message).includes('401')) {
        setStates(prev => ({ ...prev, [account.id]: { state: 'expired' } }))
        setLoginPrompt({ id: account.id })
      } else kit?.toast(`播放失败：${e?.message || e}`)
    }
  }

  const submitToken = async () => {
    if (!loginPrompt || !token.trim()) return
    setBusy(true)
    try {
      await call('openlist.updateToken', [loginPrompt.id, token.trim()], { timeoutMs: 30_000 })
      setToken(''); setLoginPrompt(null)
      kit?.toast('授权成功')
      await refresh()
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const stateBadge = (id) => {
    const s = states[id]?.state
    if (s === 'ok') return <span style={{ color: 'var(--ok, #3a9d5d)', fontSize: 11.5 }}>已授权</span>
    if (s === 'expired') return <span style={{ color: 'var(--danger, #c33d3d)', fontSize: 11.5 }}>已过期（401），请重新授权</span>
    if (s === 'need-login') return <span style={{ color: 'var(--text-3, #9aa1ab)', fontSize: 11.5 }}>未授权（公开模式）</span>
    return null
  }

  return (
    <div className="tb-empty-page">
      <div className="tb-section-title" style={{ marginTop: 0 }}>
        网盘源
        <span className="tb-more">OpenList / AList 标准协议，添加后可在搜索中聚合网盘资源</span>
        <span style={{ flex: 1 }} />
        <button className="pk-btn pk-btn-sm" onClick={() => setAdding(!adding)}>{adding ? '取消' : '+ 添加网盘'}</button>
      </div>
      <ErrorBox error={error} onRetry={refresh} />

      {adding ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <input className="pk-input tb-flat-input" style={{ flex: 2, minWidth: 240 }} placeholder="OpenList 地址 https://pan.example.com" value={url} onChange={e => setUrl(e.target.value)} />
          <input className="pk-input tb-flat-input" style={{ flex: 1, minWidth: 120 }} placeholder="名称（可选）" value={name} onChange={e => setName(e.target.value)} />
          <input className="pk-input tb-flat-input" style={{ flex: 2, minWidth: 200 }} placeholder="Token（可选；去站点设置→其他→令牌复制）" value={token} onChange={e => setToken(e.target.value)} />
          <button className="pk-btn" disabled={busy || !url.trim()} onClick={add}>{busy ? '验证中…' : '添加'}</button>
        </div>
      ) : null}

      <div className="tb-config-list">
        {accounts.map(a => (
          <div key={a.id} className="tb-config-item">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="name">{a.name}</div>
              <div className="url">{a.url}</div>
            </div>
            {stateBadge(a.id)}
            {states[a.id]?.state !== 'ok' && a.token ? (
              <button className="pk-btn pk-btn-sm" onClick={() => setLoginPrompt({ id: a.id })}>重新授权</button>
            ) : null}
            {!a.token ? (
              <button className="pk-btn pk-btn-sm" onClick={() => setLoginPrompt({ id: a.id })}>去授权</button>
            ) : null}
            <button className="pk-btn pk-btn-sm" onClick={() => openFolder(a, '/')}>浏览</button>
            <button className="pk-btn pk-btn-sm" onClick={async () => {
              if (!window.confirm(`删除网盘「${a.name}」？`)) return
              try { await call('openlist.remove', [a.id]); await refresh() } catch (e) { setError(e?.message || String(e)) }
            }}>删除</button>
          </div>
        ))}
        {!accounts.length && !error ? <Empty title="暂无网盘源" hint="添加网盘后，可在搜索中查看网盘内容。" /> : null}
      </div>

      {/* 登录/授权弹窗：打开登录页 + 粘贴 token */}
      {loginPrompt ? (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgb(0 0 0 / .35)' }} onClick={() => setLoginPrompt(null)} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 71, width: 460, maxWidth: '92%', background: 'var(--surface, #fff)', border: '1px solid var(--border, #d8d5cf)', borderRadius: 14, boxShadow: '0 16px 44px rgb(0 0 0 / .2)', padding: 18 }}>
            <div style={{ fontSize: 14.5, fontWeight: 650, marginBottom: 6 }}>网盘授权</div>
            <div className="tb-muted" style={{ marginBottom: 12, lineHeight: 1.7 }}>
              1. 点「打开登录页」在浏览器登录你的网盘站点<br />
              2. 登录后进入 设置 → 其他 → 复制「令牌」<br />
              3. 粘贴到下方回填
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <button className="pk-btn pk-btn-sm" onClick={async () => {
                try { const u = await call('openlist.loginUrl', [loginPrompt.id]); window.open(u, '_blank') } catch (e) { setError(e?.message || String(e)) }
              }}>打开登录页</button>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="pk-input tb-flat-input" style={{ flex: 1 }} autoFocus placeholder="粘贴 token（alg:…）" value={token} onChange={e => setToken(e.target.value)} />
              <button className="pk-btn" disabled={busy || !token.trim()} onClick={submitToken}>{busy ? '校验中…' : '完成授权'}</button>
            </div>
          </div>
        </>
      ) : null}

      {/* 目录浏览弹层 */}
      {browse ? (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgb(0 0 0 / .35)' }} onClick={() => setBrowse(null)} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 71, width: 640, maxWidth: '94%', maxHeight: '76vh', display: 'flex', flexDirection: 'column', background: 'var(--surface, #fff)', border: '1px solid var(--border, #d8d5cf)', borderRadius: 14, boxShadow: '0 16px 44px rgb(0 0 0 / .2)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border, #d8d5cf)', fontSize: 13, fontWeight: 600 }}>
              <span>{browse.account.name}</span>
              <span className="tb-muted" style={{ fontWeight: 400 }}>{browse.path}</span>
              <span style={{ flex: 1 }} />
              <button className="pk-btn pk-btn-sm" onClick={() => setBrowse(null)}>关闭</button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>
              {browse.items.map((f, i) => (
                <div key={`${f.name}-${i}`} className="tb-live-channel" onClick={() => {
                  const next = browse.path === '/' ? `/${f.name}` : `${browse.path}/${f.name}`
                  if (f.isDir) void openFolder(browse.account, next)
                  else void playFile(browse.account, next)
                }}>
                  <span>{f.isDir ? '📁' : '🎬'} {f.name}</span>
                  {!f.isDir ? <span className="tb-muted">{f.sizeText}</span> : null}
                </div>
              ))}
              {!browse.items.length ? <div className="tb-muted" style={{ padding: 14 }}>空目录</div> : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
