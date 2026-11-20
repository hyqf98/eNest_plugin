import { useEffect, useRef, useState } from 'react'
import { call } from '../js/api.js'
import { createPlayer } from '../js/player.js'
import { ErrorBox, useKit } from './widgets.jsx'

/** 直播页：左双栏（分组→频道，搜索过滤）+ 右侧 Artplayer；多线路循环切换 */
export function LivePage({ onBack }) {
  const [sources, setSources] = useState([])
  const [sourceIndex, setSourceIndex] = useState(0)
  const [groups, setGroups] = useState([])
  const [groupIndex, setGroupIndex] = useState(0)
  const [channelKey, setChannelKey] = useState('')
  const [lineIndex, setLineIndex] = useState(0)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const containerRef = useRef(null)
  const artRef = useRef(null)
  const kit = useKit()

  // 直播源列表
  useEffect(() => {
    void (async () => {
      try {
        const result = await call('live.list')
        setSources(result.sources ?? [])
        if (result.inlineGroups?.length) setGroups(result.inlineGroups)
      } catch (e) {
        setError(e?.message || String(e))
      }
    })()
  }, [])

  // 拉取源分组
  useEffect(() => {
    if (!sources.length || groups.length) return
    void (async () => {
      setLoading(true); setError('')
      try {
        const list = await call('live.groups', [sourceIndex], { timeoutMs: 60_000 })
        setGroups(list)
        setGroupIndex(0)
      } catch (e) {
        setError(e?.message || String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [sources, sourceIndex, groups.length])

  const group = groups[groupIndex]
  const channels = (group?.channels ?? []).filter(c => !filter || c.name.toLowerCase().includes(filter.toLowerCase()))
  const channel = group?.channels.find(c => `${groupIndex}:${c.name}` === channelKey)
  const url = channel?.urls?.[lineIndex % (channel?.urls?.length || 1)]

  // 播放当前频道（Artplayer + hls，url 变化重建）
  useEffect(() => {
    if (!url || !containerRef.current) return
    artRef.current?.destroy()
    const art = createPlayer({
      container: containerRef.current,
      url,
      kind: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4',
      live: true,
      onError: (msg) => setError(`${msg}（可尝试切换线路）`),
    })
    artRef.current = art
    return () => { artRef.current?.destroy(); artRef.current = null }
  }, [url])

  useEffect(() => () => { artRef.current?.destroy() }, [])

  return (
    <div className="tb-live">
      <div className="tb-live-video">
        <div ref={containerRef} className="tb-player-art" />
        {!channel && !error ? <div className="tb-player-center" style={{ color: '#fff' }}>选择左侧频道开始观看</div> : null}
        {error ? (
          <div className="tb-player-center">
            <div style={{ fontSize: 13, maxWidth: 420, textAlign: 'center', lineHeight: 1.7 }}>{error}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {channel && channel.urls.length > 1 ? <button onClick={() => { setError(''); setLineIndex(i => i + 1) }}>换线路（{(lineIndex + 1) % channel.urls.length + 1}/{channel.urls.length}）</button> : null}
              <button onClick={() => { setError(''); setChannelKey('') }}>返回列表</button>
              <button onClick={() => onBack?.()}>退出直播</button>
            </div>
          </div>
        ) : null}
        {channel ? (
          <div style={{ position: 'absolute', top: 10, left: 14, color: '#fff', fontSize: 12.5, textShadow: '0 1px 3px #000' }}>
            {channel.name}
            {channel.urls.length > 1 ? <button style={{ marginLeft: 10 }} onClick={() => setLineIndex(i => i + 1)}>线路 {lineIndex % channel.urls.length + 1}/{channel.urls.length}</button> : null}
            <button style={{ marginLeft: 8 }} onClick={() => onBack?.()}>退出</button>
          </div>
        ) : null}
      </div>
      <div className="tb-live-sidebar">
        <div className="tb-live-groups">
          {sources.length > 1 ? (
            <select className="tb-live-search" style={{ margin: '8px 8px 4px' }} value={sourceIndex} onChange={e => { setSourceIndex(Number(e.target.value)); setGroups([]); setChannelKey('') }}>
              {sources.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
            </select>
          ) : null}
          {groups.map((g, i) => (
            <div key={`${g.name}-${i}`} className={`tb-live-group-item${i === groupIndex ? ' is-active' : ''}`} onClick={() => { setGroupIndex(i); setChannelKey('') }}>
              {g.name}
            </div>
          ))}
          {loading ? <div className="tb-muted" style={{ padding: 10 }}>加载分组…</div> : null}
        </div>
        <div className="tb-live-channels">
          <input className="pk-input tb-live-search" placeholder="过滤频道名…" value={filter} onChange={e => setFilter(e.target.value)} />
          {channels.map((c, i) => {
            const key = `${groupIndex}:${c.name}`
            return (
              <div key={`${c.name}-${i}`} className={`tb-live-channel${key === channelKey ? ' is-playing' : ''}`} onClick={() => { setChannelKey(key); setLineIndex(0); setError('') }}>
                <span>{c.name}</span>
                {c.urls.length > 1 ? <span className="tb-muted">{c.urls.length} 线路</span> : null}
              </div>
            )
          })}
          {!loading && !channels.length ? <div className="tb-muted" style={{ padding: 12 }}>没有频道{filter ? `匹配「${filter}」` : ''}</div> : null}
        </div>
      </div>
    </div>
  )
}
