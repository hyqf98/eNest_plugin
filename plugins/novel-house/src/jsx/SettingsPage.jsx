import { useEffect, useState } from 'react'
import { call, loadSettings, saveSettings } from '../js/api.js'
import { notifyError, notifyOk } from '../js/notify.js'

/** 阅读主题选项（与阅读器 nh-reader[data-theme] 对应） */
const READER_THEMES = [
  { value: 'paper', label: '纸张', sample: '#f4ecd8' },
  { value: 'white', label: '纯白', sample: '#ffffff' },
  { value: 'green', label: '护眼', sample: '#c7edcc' },
  { value: 'dark', label: '夜间', sample: '#16171c' },
]

/** 设置页：阅读 / 网络 / 缓存 / 数据 四组，全部走统一 storage 持久化 */
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

  if (!settings) return <div className="nh-empty">加载设置…</div>

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
    if (!confirm('清空全部小说缓存？书架与历史不受影响。')) return
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
    <div className="nh-settings">
      <section className="nh-src-card">
        <h3>阅读</h3>
        <div className="nh-set-row">
          <div className="nh-set-info">
            <div className="nh-set-label">正文字号</div>
            <div className="pk-muted nh-set-note">阅读器内 ⌘/Ctrl + 滚轮也可调整</div>
          </div>
          <div className="nh-set-control">
            <input
              type="range" min="12" max="28" step="1"
              value={settings.fontSize}
              onChange={e => void update({ fontSize: Number(e.target.value) })}
              aria-label="正文字号"
            />
            <span className="pk-mono nh-set-value">{settings.fontSize}px</span>
          </div>
        </div>
        <div className="nh-set-row">
          <div className="nh-set-info">
            <div className="nh-set-label">行距</div>
            <div className="pk-muted nh-set-note">正文行高倍数</div>
          </div>
          <div className="nh-set-control">
            <input
              type="range" min="1.4" max="2.6" step="0.1"
              value={settings.lineHeight}
              onChange={e => void update({ lineHeight: Number(e.target.value) })}
              aria-label="行距"
            />
            <span className="pk-mono nh-set-value">{settings.lineHeight}</span>
          </div>
        </div>
        <div className="nh-set-row">
          <div className="nh-set-info">
            <div className="nh-set-label">段间距</div>
            <div className="pk-muted nh-set-note">段落之间的留白</div>
          </div>
          <div className="nh-set-control">
            <input
              type="range" min="4" max="32" step="2"
              value={settings.paraGap}
              onChange={e => void update({ paraGap: Number(e.target.value) })}
              aria-label="段间距"
            />
            <span className="pk-mono nh-set-value">{settings.paraGap}px</span>
          </div>
        </div>
        <div className="nh-set-row">
          <div className="nh-set-info">
            <div className="nh-set-label">版心宽度</div>
            <div className="pk-muted nh-set-note">正文最大列宽</div>
          </div>
          <div className="nh-set-control">
            <input
              type="range" min="480" max="1080" step="40"
              value={settings.readerWidth}
              onChange={e => void update({ readerWidth: Number(e.target.value) })}
              aria-label="版心宽度"
            />
            <span className="pk-mono nh-set-value">{settings.readerWidth}px</span>
          </div>
        </div>
        <div className="nh-set-row">
          <div className="nh-set-info">
            <div className="nh-set-label">阅读底色</div>
            <div className="pk-muted nh-set-note">纸张 / 纯白 / 护眼 / 夜间</div>
          </div>
          <div className="nh-set-control nh-theme-picker">
            {READER_THEMES.map(t => (
              <button
                key={t.value}
                className={`nh-theme-swatch${settings.readerTheme === t.value ? ' pk-active' : ''}`}
                style={{ background: t.sample }}
                onClick={() => void update({ readerTheme: t.value })}
                title={t.label}
                aria-label={t.label}
                aria-pressed={settings.readerTheme === t.value}
              >
                {settings.readerTheme === t.value ? '✓' : ''}
              </button>
            ))}
          </div>
        </div>
        <div className="nh-set-row">
          <div className="nh-set-info">
            <div className="nh-set-label">阅读时自动缓存本章</div>
            <div className="pk-muted nh-set-note">看过的章节自动离线，断网可续读</div>
          </div>
          <div className="nh-set-control">
            <input
              type="checkbox"
              checked={!!settings.autoCache}
              onChange={e => void update({ autoCache: e.target.checked })}
              aria-label="自动缓存本章"
            />
          </div>
        </div>
      </section>

      <section className="nh-src-card">
        <h3>网络</h3>
        <div className="nh-set-row">
          <div className="nh-set-info">
            <div className="nh-set-label">代理方式</div>
            <div className="pk-muted nh-set-note">
              {proxy.mode === 'manual'
                ? `手动代理 · 当前生效 ${proxy.effective || proxy.url}`
                : proxy.mode === 'direct'
                  ? '直连（不经代理）'
                  : `跟随壳代理${proxy.effective ? ` · 当前生效 ${proxy.effective}` : ' · 未检测到代理'}`}
            </div>
          </div>
          <div className="nh-set-control nh-proxy-modes">
            <button className={proxy.mode === 'shell' ? 'nh-seg pk-active' : 'nh-seg'} onClick={() => void saveProxy('shell', '')}>跟随壳</button>
            <button className={proxy.mode === 'manual' ? 'nh-seg pk-active' : 'nh-seg'} onClick={() => { if (proxyUrlDraft) void saveProxy('manual') }}>手动</button>
            <button className={proxy.mode === 'direct' ? 'nh-seg pk-active' : 'nh-seg'} onClick={() => void saveProxy('direct', '')}>直连</button>
          </div>
        </div>
        {proxy.mode === 'manual' && (
          <div className="nh-set-row">
            <div className="nh-set-info">
              <div className="nh-set-label">代理地址</div>
              <div className="pk-muted nh-set-note">形如 http://127.0.0.1:7890</div>
            </div>
            <div className="nh-set-control">
              <input
                className="pk-input nh-proxy-input"
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

      <section className="nh-src-card">
        <h3>缓存</h3>
        <div className="nh-set-row">
          <div className="nh-set-info">
            <div className="nh-set-label">当前缓存</div>
            <div className="pk-muted nh-set-note">{cacheInfo.count} 本 · {mb > 0 ? `${mb} MB` : '0'}</div>
          </div>
          <div className="nh-set-control">
            <button className="pk-btn pk-btn-sm nh-danger" disabled={busy === 'cache' || !cacheInfo.count} onClick={() => void clearAllCache()}>
              {busy === 'cache' ? '清理中…' : '清空缓存'}
            </button>
          </div>
        </div>
      </section>

      <section className="nh-src-card">
        <h3>数据</h3>
        <div className="nh-set-row">
          <div className="nh-set-info">
            <div className="nh-set-label">历史上限</div>
            <div className="pk-muted nh-set-note">超过后自动淘汰最早的记录</div>
          </div>
          <div className="nh-set-control">
            <input
              type="range" min="50" max="500" step="50"
              value={settings.historyLimit}
              onChange={e => void update({ historyLimit: Number(e.target.value) })}
              aria-label="历史上限"
            />
            <span className="pk-mono nh-set-value">{settings.historyLimit} 条</span>
          </div>
        </div>
        <p className="pk-muted nh-note">书架、历史、设置与书源数据均通过宿主统一存储 API 持久化（storage.commit 原子提交），随插件数据迁移。</p>
      </section>
    </div>
  )
}
