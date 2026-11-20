import { useEffect, useState } from 'react'
import { call } from '../js/api.js'
import { loadSettings, saveSettings } from '../js/api.js'
import { notifyError, notifyOk } from '../js/notify.js'
import { Loading } from './widgets.jsx'

/** 设置页：阅读 / 缓存 / 数据 三组，全部走统一 storage 持久化 */
export function SettingsPage() {
  const [settings, setSettings] = useState(null)
  const [cacheInfo, setCacheInfo] = useState({ count: 0, bytes: 0 })
  const [busy, setBusy] = useState('')
  const [proxy, setProxy] = useState({ mode: 'shell', url: '', effective: '' })
  const [proxyUrlDraft, setProxyUrlDraft] = useState('')

  useEffect(() => {
    void loadSettings().then(setSettings).catch(() => setSettings({}))
    void call('net.getProxy').then(
      p => { setProxy(p); setProxyUrlDraft(p.url || '') },
      () => {}
    )
    void call('cache.list').then(
      list => setCacheInfo({
        count: list.length,
        bytes: list.reduce((s, e) => s + (e.bytes || 0), 0),
      }),
      () => {}
    )
  }, [])

  if (!settings) return <Loading label="加载设置中…" />

  const update = async (patch) => {
    setSettings(prev => ({ ...prev, ...patch }))
    try {
      await saveSettings(patch)
    } catch (e) { notifyError(e) }
  }

  const saveProxy = async (mode, url) => {
    try {
      const result = await call('net.setProxy', [mode, url ?? proxyUrlDraft])
      setProxy(result)
      notifyOk(mode === 'shell' ? '已恢复跟随壳代理' : mode === 'direct' ? '已切换为直连' : '代理已更新')
    } catch (e) { notifyError(e) }
  }

  const clearAllCache = async () => {
    if (!confirm('清空全部漫画缓存？收藏与历史不受影响。')) return
    setBusy('cache')
    try {
      await call('cache.remove', ['', ''])
      await call('cache.list').then(list => setCacheInfo({ count: list.length, bytes: 0 }), () => {})
      notifyOk('缓存已清空')
    } catch (e) { notifyError(e) }
    finally { setBusy('') }
  }

  const mb = Math.round(cacheInfo.bytes / 1048576)

  return (
    <div className="ch-settings">
      <section className="ch-src-card">
        <h3>阅读</h3>
        <div className="ch-set-row">
          <div className="ch-set-info">
            <div className="ch-set-label">页面间距</div>
            <div className="pk-muted ch-set-note">阅读时漫画页之间的留白</div>
          </div>
          <div className="ch-set-control">
            <input
              type="range" min="0" max="24" step="2"
              value={settings.readerGap}
              onChange={e => void update({ readerGap: Number(e.target.value) })}
              aria-label="页面间距"
            />
            <span className="pk-mono ch-set-value">{settings.readerGap}px</span>
          </div>
        </div>
        <div className="ch-set-row">
          <div className="ch-set-info">
            <div className="ch-set-label">向后预加载</div>
            <div className="pk-muted ch-set-note">阅读时预先下载后续页数</div>
          </div>
          <div className="ch-set-control">
            <input
              type="range" min="0" max="8" step="1"
              value={settings.preloadCount}
              onChange={e => void update({ preloadCount: Number(e.target.value) })}
              aria-label="预加载数"
            />
            <span className="pk-mono ch-set-value">{settings.preloadCount} 页</span>
          </div>
        </div>
        <div className="ch-set-row">
          <div className="ch-set-info">
            <div className="ch-set-label">阅读时自动缓存本章</div>
            <div className="pk-muted ch-set-note">看过的章节自动离线，断网可续读</div>
          </div>
          <div className="ch-set-control">
            <input
              type="checkbox"
              checked={!!settings.autoCache}
              onChange={e => void update({ autoCache: e.target.checked })}
              aria-label="自动缓存本章"
            />
          </div>
        </div>
      </section>

      <section className="ch-src-card">
        <h3>网络</h3>
        <div className="ch-set-row">
          <div className="ch-set-info">
            <div className="ch-set-label">代理方式</div>
            <div className="pk-muted ch-set-note">
              {proxy.mode === 'manual'
                ? `手动代理 · 当前生效 ${proxy.effective || proxy.url}`
                : proxy.mode === 'direct'
                  ? '直连（不经代理）'
                  : `跟随壳代理${proxy.effective ? ` · 当前生效 ${proxy.effective}` : ' · 未检测到代理'}`}
            </div>
          </div>
          <div className="ch-set-control ch-proxy-modes">
            <button className={proxy.mode === 'shell' ? 'ch-seg pk-active' : 'ch-seg'} onClick={() => void saveProxy('shell', '')}>跟随壳</button>
            <button className={proxy.mode === 'manual' ? 'ch-seg pk-active' : 'ch-seg'} onClick={() => { if (proxyUrlDraft) void saveProxy('manual') }}>手动</button>
            <button className={proxy.mode === 'direct' ? 'ch-seg pk-active' : 'ch-seg'} onClick={() => void saveProxy('direct', '')}>直连</button>
          </div>
        </div>
        {proxy.mode === 'manual' && (
          <div className="ch-set-row">
            <div className="ch-set-info">
              <div className="ch-set-label">代理地址</div>
              <div className="pk-muted ch-set-note">形如 http://127.0.0.1:7890</div>
            </div>
            <div className="ch-set-control">
              <input
                className="pk-input ch-proxy-input"
                type="url"
                placeholder="http://127.0.0.1:7890"
                value={proxyUrlDraft}
                onChange={e => setProxyUrlDraft(e.target.value)}
                aria-label="代理地址"
              />
              <button className="pk-btn pk-btn-sm" disabled={!proxyUrlDraft.trim()} onClick={() => void saveProxy('manual')}>应用</button>
            </div>
          </div>
        )}
      </section>

      <section className="ch-src-card">
        <h3>缓存</h3>
        <div className="ch-set-row">
          <div className="ch-set-info">
            <div className="ch-set-label">缓存总量上限</div>
            <div className="pk-muted ch-set-note">超过后按最旧整部自动清理</div>
          </div>
          <div className="ch-set-control">
            <input
              type="range" min="256" max="4096" step="256"
              value={settings.cacheLimitMB}
              onChange={e => void update({ cacheLimitMB: Number(e.target.value) })}
              aria-label="缓存上限"
            />
            <span className="pk-mono ch-set-value">{Math.round(settings.cacheLimitMB / 1024 * 10) / 10} GB</span>
          </div>
        </div>
        <div className="ch-set-row">
          <div className="ch-set-info">
            <div className="ch-set-label">当前缓存</div>
            <div className="pk-muted ch-set-note">{cacheInfo.count} 部 · {mb > 0 ? `${mb} MB` : '0'}{settings.cacheLimitMB ? ` / 上限 ${Math.round(settings.cacheLimitMB / 1024 * 10) / 10} GB` : ''}</div>
          </div>
          <div className="ch-set-control">
            <button className="pk-btn pk-btn-sm ch-danger" disabled={busy === 'cache' || !cacheInfo.count} onClick={() => void clearAllCache()}>
              {busy === 'cache' ? '清理中…' : '清空缓存'}
            </button>
          </div>
        </div>
      </section>

      <section className="ch-src-card">
        <h3>数据</h3>
        <div className="ch-set-row">
          <div className="ch-set-info">
            <div className="ch-set-label">历史上限</div>
            <div className="pk-muted ch-set-note">超过后自动淘汰最早的记录</div>
          </div>
          <div className="ch-set-control">
            <input
              type="range" min="50" max="500" step="50"
              value={settings.historyLimit}
              onChange={e => void update({ historyLimit: Number(e.target.value) })}
              aria-label="历史上限"
            />
            <span className="pk-mono ch-set-value">{settings.historyLimit} 条</span>
          </div>
        </div>
        <p className="pk-muted ch-note">收藏、历史、设置与源数据均通过宿主统一存储 API 持久化（storage.commit 原子提交），随插件数据迁移。</p>
      </section>
    </div>
  )
}
