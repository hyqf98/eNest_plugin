/**
 * markdown v2 —— 设置页（code=settings）：图床四提供方、自定义 JS 脚本编辑器、
 * 主题管理（导入 Typora CSS）、数据目录展示。
 */
import { useCallback, useEffect, useState } from 'react'
import { call } from '../js/rpc.js'

const SAMPLE_SCRIPTS = {
  '兰空图床': `// 兰空图床 v2：Token + /api/v1/upload
module.exports = async (ctx) => {
  const form = new FormData()
  form.append('file', new Blob([ctx.bytes], { type: ctx.mime }), ctx.fileName)
  const res = await fetch('https://你的兰空域名/api/v1/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + ctx.config.token, Accept: 'application/json' },
    body: form,
  })
  const data = await res.json()
  ctx.log('lsky: ' + JSON.stringify(data).slice(0, 120))
  return data.data.links.url
}
`,
  'SM.MS': `// SM.MS 图床
module.exports = async (ctx) => {
  const form = new FormData()
  form.append('smfile', new Blob([ctx.bytes], { type: ctx.mime }), ctx.fileName)
  const res = await fetch('https://smms.app/api/v2/upload', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(ctx.config.token).toString('base64') },
    body: form,
  })
  const data = await res.json()
  return data.data.url
}
`,
  'Chevereto': `// Chevereto 通用（图床 key + /api/1/upload）
module.exports = async (ctx) => {
  const b64 = Buffer.from(ctx.bytes).toString('base64')
  const res = await fetch('https://你的chevereto域名/api/1/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: ctx.config.token, action: 'upload', format: 'base64', source: b64 }),
  })
  const data = await res.json()
  return data.image.url
}
`,
}

const SHORTCUT_GROUPS = [
  {
    title: '格式',
    items: [
      ['加粗', ['⌘', 'B']],
      ['斜体', ['⌘', 'I']],
      ['行内代码', ['⌘', 'E']],
      ['插入链接', ['⌘', 'K']],
      ['插入图片', ['⇧', '⌘', 'K']],
      ['一级标题', ['⌘', '1']],
      ['二级标题', ['⌘', '2']],
      ['三级标题', ['⌘', '3']],
      ['无序列表', ['⌘', '⇧', '8']],
      ['有序列表', ['⌘', '⇧', '9']],
      ['任务清单', ['⌘', '⇧', '7']],
      ['引用', ['⌘', '⇧', 'U']],
      ['代码块', ['⌘', '⇧', 'L']],
      ['插入表格', ['⌘', '⇧', 'G']],
    ],
  },
  {
    title: '文件',
    items: [
      ['新建', ['⌘', 'N']],
      ['保存', ['⌘', 'S']],
      ['打开 / 另存为', ['菜单 ⋯']],
    ],
  },
  {
    title: '搜索与替换',
    items: [
      ['查找', ['⌘', 'F']],
      ['替换', ['查找面板展开后自动显示']],
      ['查找下一个 / 上一个', ['⌘', 'G / ⇧⌘G']],
      ['选中下一个匹配（多光标）', ['⌘', 'D']],
      ['关闭查找', ['Esc']],
    ],
  },
  {
    title: '视图与编辑',
    items: [
      ['打字机模式', ['F8']],
      ['专注模式', ['F9']],
      ['切换侧栏', ['⌘', '\\']],
      ['撤销 / 重做', ['⌘', 'Z / ⇧⌘Z']],
      ['表格右键', ['增删行列 / 重置列宽']],
      ['表格悬停', ['拖动列边界调列宽']],
      ['粘贴图片', ['⌘', 'V']],
    ],
  },
]

export function SettingsPage({ onBack, themeList, activeTheme, onThemeChange }) {
  const [section, setSection] = useState('uploaders')
  const [cfg, setCfg] = useState(null)
  const [script, setScript] = useState('')
  const [token, setToken] = useState('')
  const [testing, setTesting] = useState('')
  const [testResult, setTestResult] = useState(null)
  const [newThemeName, setNewThemeName] = useState('')
  const [newThemeCss, setNewThemeCss] = useState('')
  const [paths, setPaths] = useState(null)

  useEffect(() => {
    void call('uploader.config').then((c) => {
      setCfg(c.uploaders)
      setScript(c.uploaders?.script?.code ?? '')
      setToken(c.uploaders?.github?.token ?? '')
    }).catch(() => {})
    void call('info.paths').then(setPaths).catch(() => {})
  }, [])

  const save = useCallback(async (patch) => {
    try {
      await call('uploader.saveConfig', patch)
    } catch (e) {
      alert(`保存失败：${e.message}`)
    }
  }, [])

  const setActive = async (active) => {
    setCfg({ ...cfg, active })
    await save({ active })
  }

  const test = async (which) => {
    setTesting(which)
    setTestResult(null)
    // 脚本测试前先保存当前编辑器内容
    if (which === 'script' && script) await save({ script: { code: script } })
    try {
      const r = await call('uploader.test', which)
      setTestResult({ which, ok: true, message: `连通，测试图地址：${String(r.url).slice(0, 72)}` })
    } catch (e) {
      setTestResult({ which, ok: false, message: e.message })
    } finally {
      setTesting('')
    }
  }

  const importTheme = async () => {
    const name = newThemeName.trim()
    if (!name || !newThemeCss.trim()) return
    try {
      await call('theme.write', name, newThemeCss)
      setNewThemeName('')
      setNewThemeCss('')
      onThemeChange(name.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))
    } catch (e) {
      alert(`导入失败：${e.message}`)
    }
  }

  const deleteTheme = async (id) => {
    if (!confirm(`删除主题「${id}」？`)) return
    await call('theme.delete', id).catch(() => {})
    onThemeChange('enest-minimal')
  }

  const field = (label, node, hint) => (
    <label className="md-set-field">
      <span className="md-set-label">{label}</span>
      {node}
      {hint && <span className="md-set-hint">{hint}</span>}
    </label>
  )

  return (
    <main className="md-app md-settings md-scope">
      <header className="md-settings-head">
        <button className="pk-btn pk-btn-sm" onClick={onBack}>← 返回编辑器</button>
        <h2>Markdown 编辑器设置</h2>
      </header>
      <nav className="md-settings-nav">
        <button className={section === 'uploaders' ? 'is-active' : ''} onClick={() => setSection('uploaders')}>图床</button>
        <button className={section === 'themes' ? 'is-active' : ''} onClick={() => setSection('themes')}>主题</button>
        <button className={section === 'shortcuts' ? 'is-active' : ''} onClick={() => setSection('shortcuts')}>快捷键</button>
        <button className={section === 'data' ? 'is-active' : ''} onClick={() => setSection('data')}>数据</button>
      </nav>

      {section === 'uploaders' && cfg && (
        <div className="md-settings-body">
          <section className="md-set-section">
            <h3>当前图床</h3>
            <div className="md-uploader-choice" role="radiogroup">
              {[
                { id: 'local', label: '本地 assets（零配置）' },
                { id: 'piclist', label: 'PicList（本机 API）' },
                { id: 'github', label: 'GitHub 仓库' },
                { id: 'script', label: '自定义脚本' },
              ].map((u) => (
                <label key={u.id} className={`md-uploader-option ${cfg.active === u.id ? 'is-active' : ''}`}>
                  <input type="radio" name="uploader" checked={cfg.active === u.id} onChange={() => void setActive(u.id)} />
                  <span>{u.label}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="md-set-section">
            <h3>PicList</h3>
            {field('服务地址', (
              <input className="pk-input" type="text" value={cfg.piclist?.server ?? ''} placeholder="http://127.0.0.1:36677"
                onChange={(e) => setCfg({ ...cfg, piclist: { ...cfg.piclist, server: e.target.value } })}
                onBlur={(e) => void save({ piclist: { server: e.target.value } })} />
            ), 'PicList 桌面端默认监听 36677；保持 PicList 开启并允许 API')}
            <div className="md-set-actions">
              <button className="pk-btn pk-btn-sm" disabled={testing === 'piclist'} onClick={() => void test('piclist')}>{testing === 'piclist' ? '测试中…' : '测试连通'}</button>
              {testResult?.which === 'piclist' && <span className={testResult.ok ? 'md-test-ok' : 'md-test-fail'}>{testResult.message}</span>}
            </div>
          </section>

          <section className="md-set-section">
            <h3>GitHub 仓库图床</h3>
            {field('仓库（owner/repo）', (
              <input className="pk-input" type="text" value={cfg.github?.repo ?? ''} placeholder="username/images"
                onChange={(e) => setCfg({ ...cfg, github: { ...cfg.github, repo: e.target.value } })}
                onBlur={(e) => void save({ github: { repo: e.target.value } })} />
            ))}
            {field('分支', (
              <input className="pk-input" type="text" value={cfg.github?.branch ?? 'main'}
                onChange={(e) => setCfg({ ...cfg, github: { ...cfg.github, branch: e.target.value } })}
                onBlur={(e) => void save({ github: { branch: e.target.value } })} />
            ))}
            {field('Token（PAT）', (
              <input className="pk-input" type="password" value={token} placeholder={token === '(已配置)' ? '已配置（留空保留）' : 'ghp_… 或 github_pat_…'}
                onChange={(e) => setToken(e.target.value)}
                onBlur={() => { if (token && token !== '(已配置)') void save({ github: { token } }) }} />
            ), '需要 contents:write 权限；保存后明文不再回显')}
            {field('路径模板', (
              <input className="pk-input" type="text" value={cfg.github?.pathTemplate ?? 'images/{date}/{name}'}
                onChange={(e) => setCfg({ ...cfg, github: { ...cfg.github, pathTemplate: e.target.value } })}
                onBlur={(e) => void save({ github: { pathTemplate: e.target.value } })} />
            ), '可用 {date} 与 {name}')}
            {field('CDN 域名（可选）', (
              <input className="pk-input" type="text" value={cfg.github?.cdn ?? ''} placeholder="https://cdn.jsdelivr.net/gh/user/repo@main"
                onChange={(e) => setCfg({ ...cfg, github: { ...cfg.github, cdn: e.target.value } })}
                onBlur={(e) => void save({ github: { cdn: e.target.value } })} />
            ))}
            <div className="md-set-actions">
              <button className="pk-btn pk-btn-sm" disabled={testing === 'github'} onClick={() => void test('github')}>{testing === 'github' ? '测试中…' : '测试上传'}</button>
              {testResult?.which === 'github' && <span className={testResult.ok ? 'md-test-ok' : 'md-test-fail'}>{testResult.message}</span>}
            </div>
          </section>

          <section className="md-set-section">
            <h3>自定义上传脚本</h3>
            <p className="md-set-hint">契约：<code>module.exports = async (ctx) =&gt; url 或 {'{ url, markdown }'}</code>。可用全局：fetch/FormData/Blob/Buffer/crypto/URL；无 require/process/fs；15s 超时。Token 等配置写在脚本里自己读取。</p>
            <div className="md-script-templates">
              {Object.keys(SAMPLE_SCRIPTS).map((k) => (
                <button key={k} className="pk-btn pk-btn-sm" onClick={() => setScript(SAMPLE_SCRIPTS[k])}>{k} 模板</button>
              ))}
            </div>
            <textarea
              className="pk-input md-script-editor"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              spellCheck={false}
              rows={14}
              placeholder="// module.exports = async (ctx) => url"
            />
            <div className="md-set-actions">
              <button className="pk-btn pk-btn-sm" onClick={() => void save({ script: { code: script } }).then(() => alert('脚本已保存'))}>保存脚本</button>
              <button className="pk-btn pk-btn-sm" disabled={testing === 'script'} onClick={() => void test('script')}>{testing === 'script' ? '测试中…' : '测试脚本'}</button>
              {testResult?.which === 'script' && <span className={testResult.ok ? 'md-test-ok' : 'md-test-fail'}>{testResult.message}</span>}
            </div>
          </section>
        </div>
      )}

      {section === 'themes' && (
        <div className="md-settings-body">
          <section className="md-set-section">
            <h3>可用主题</h3>
            <div className="md-theme-list">
              {themeList.map((t) => (
                <div key={t.id} className={`md-theme-item ${t.id === activeTheme ? 'is-active' : ''}`}>
                  <button className="md-theme-name" onClick={() => onThemeChange(t.id)}>{t.name}</button>
                  {t.source === 'user' && <button className="pk-btn pk-btn-sm" onClick={() => void deleteTheme(t.id)}>删除</button>}
                </div>
              ))}
            </div>
          </section>
          <section className="md-set-section">
            <h3>导入 Typora 主题</h3>
            <p className="md-set-hint">把 Typora 主题 CSS（如 github.css）内容粘贴到这里。选择器面向 #write 的规则会直接生效；html/body/:root 级规则自动改写为本页作用域。</p>
            {field('主题名', (
              <input className="pk-input" type="text" value={newThemeName} placeholder="github" onChange={(e) => setNewThemeName(e.target.value)} />
            ))}
            <textarea
              className="pk-input md-script-editor"
              value={newThemeCss}
              onChange={(e) => setNewThemeCss(e.target.value)}
              spellCheck={false}
              rows={12}
              placeholder="/* 粘贴 Typora 主题 CSS */"
            />
            <div className="md-set-actions">
              <button className="pk-btn pk-btn-sm" onClick={() => void importTheme()} disabled={!newThemeName.trim() || !newThemeCss.trim()}>导入并应用</button>
            </div>
          </section>
        </div>
      )}

      {section === 'shortcuts' && (
        <div className="md-settings-body">
          <section className="md-set-section">
            <h3>快捷键</h3>
            <p className="md-set-hint">macOS 用 ⌘（Command），Windows/Linux 用 Ctrl。格式类快捷键在光标位于任意源码态块内时生效；Esc/⌘Enter/⌘K 由壳子保留。</p>
            <table className="md-kbd-table">
              <tbody>
                {SHORTCUT_GROUPS.map((group) => group.items.map(([label, keys], i) => (
                  <tr key={group.title + label}>
                    {i === 0 && <td className="md-kbd-group" rowSpan={group.items.length}>{group.title}</td>}
                    <td>{label}</td>
                    <td className="md-kbd-keys">{keys.map((k) => <kbd key={k}>{k}</kbd>)}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </section>
        </div>
      )}

      {section === 'data' && paths && (
        <div className="md-settings-body">
          <section className="md-set-section">
            <h3>数据目录</h3>
            <p className="md-set-hint">配置（config.json）· 主题（themes/）· 速记收件箱（inbox/）· 图片缓存（cache/）。</p>
            <ul className="md-paths">
              <li><code>{paths.dataRoot}</code></li>
              <li><code>{paths.themesDir}</code></li>
              <li><code>{paths.inboxDir}</code></li>
            </ul>
            <p className="md-set-hint">也可以直接把 .css 丢进主题目录，重启后出现在主题列表。</p>
          </section>
          <section className="md-set-section">
            <h3>粘贴图片默认动作等开关</h3>
            <p className="md-set-hint">HTML 渲染开关、Mermaid 风格、打字机/专注模式、自动保存等在 eNest 系统设置 → Markdown 编辑器中调整。</p>
          </section>
        </div>
      )}
    </main>
  )
}
