/**
 * SSH 主界面 —— React 版（批 3「官方插件 React 化」）
 *
 * 迁移边界（与 SOP 一致，特殊于本插件）：
 * - 静态骨架（#app 侧栏/主区/抽屉/表单弹窗）由 React 复刻，DOM 结构 / 类名 / id
 *   与原 index.html 逐字一致，视觉零改变。
 * - 业务引擎原样复用（未改动）：api.js / dict.js / store.js / term.js（xterm 适配层）、
 *   app.js（会话/连接/SFTP/表单逻辑）、workbench.js（工作台 + Monaco 编辑器集成）、
 *   commandCompletion/sshCompletion/remoteCompletion/files/workspaceNavigation/
 *   completionSettings/commandActions/shortcutPolicy/tips-global。
 * - app.js / workbench.js 以「命令式引导脚本」方式在 React 提交后动态 import：
 *   它们按 id 查询静态节点并自举（boot → SshWorkbenchBridge → ssh-workbench-ready），
 *   与原版 script 标签顺序执行等价。xterm.open 容器、Terminal 实例管理、
 *   WebSocket/SSH 数据流（@enest/ssh-backend）与 Monaco 编辑器集成区零改动。
 * - vendor UMD（xterm.js / addon-fit.js）仍在 index.html 以 script 标签加载；
 *   xterm.css 保留在 head。
 * - 原生 <select> 保留（plugin-kit upgradeSelects 自动升级，SOP 踩坑约定）。
 * - 生成型 DOM（树/会话标签/SFTP 列表/右键菜单/补全浮层等）沿用批 1/2 验证过的
 *   等价 HTML 模式：引擎继续以 innerHTML 渲染到对应容器，React 不接管其子树。
 */
import { useEffect, useRef, useState } from 'react'
import { PanelView } from './PanelView.jsx'
import { sshIndexedView } from '@ssh/js/launch-index.js'

const host = window.enest || window.zapi
const initialMode = () => host?.getLaunchMode?.() || new URLSearchParams(location.search).get('mode') || 'shell'

/** 原版静态骨架逐字复刻（不含 vendor script 与模块脚本，二者由 entry/index.html 承担） */
function AppSkeleton() {
  return (
    <>
      {/* 手绘描边位移滤镜：隐藏 svg 供 paper-theme.css 的 ::before filter:url(#ink-rough) 引用。 */}
      <svg aria-hidden="true" focusable="false" width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          <filter id="ink-rough" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.02 0.028" numOctaves="3" seed="11" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="3.2" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="ink-rough-fine" x="-8%" y="-8%" width="116%" height="116%">
            <feTurbulence type="fractalNoise" baseFrequency="0.05 0.065" numOctaves="2" seed="5" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.6" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>
      <div className="app" id="app">
        {/* 左侧：可收起侧栏（收起后只剩 rail —— 搜索/抽屉/更多都住在这里） */}
        <aside className="sidebar" id="sidebar" data-collapsed="0">
          <div className="side-rail" id="side-rail">
            <button className="rail-btn" id="btn-toggle-side" title="展开侧栏" aria-label="展开侧栏" data-tip="展开侧栏">☰</button>
            <button className="rail-btn" id="rail-new" title="新建连接" aria-label="新建连接" data-tip="新建连接">＋</button>
            <button className="rail-btn" id="rail-search" title="搜索连接" aria-label="搜索连接" data-tip="搜索连接">⌕</button>
            <button className="rail-btn" id="rail-drawer" title="历史与常用" aria-label="历史与常用" data-tip="历史与常用">⏱</button>
            <div className="rail-spacer"></div>
            <button className="rail-btn" id="rail-more" title="更多操作" aria-label="更多操作" data-tip="更多操作">⋯</button>
          </div>

          <div className="side-body" id="side-body">
            <div className="side-head">
              <h1>SSH</h1>
              <div className="spacer"></div>
            </div>
            <div className="side-tools">
              <input id="search-input" type="search" placeholder="搜索" aria-label="搜索连接" />
              <div className="filter-row" id="filter-row"></div>
            </div>
            <div className="sel-bar" id="sel-bar" hidden></div>
            <div className="tree" id="tree">
              <div className="empty">加载中…</div>
            </div>
          </div>
        </aside>

        {/* 中央 */}
        <main className="main">
          <div className="topbar">
            <div className="top-status" id="top-status">
              <span className="status-dot" id="top-dot"></span>
              <span className="top-name" id="top-name">SSH</span>
              <span className="top-sub" id="top-sub"></span>
            </div>
            <div className="spacer"></div>
          </div>

          <div className="session-tabs" id="session-tabs"></div>

          <div className="workspace">
            <div className="view-chip" id="view-chip" hidden>
              <button className="icon-btn" id="btn-view-back" title="返回终端" aria-label="返回终端">←</button>
              <span id="view-chip-label">视图</span>
              <div className="spacer"></div>
              <button className="icon-btn" id="btn-view-close" title="关闭视图" aria-label="关闭">×</button>
            </div>

            <section className="panel active" id="panel-term">
              <div className="term-wrap" id="term-wrap">
                <div className="term-banner" id="term-banner"></div>
                <div className="term-empty" id="term-empty">选择连接后开始</div>
                <div id="term-host" className="term-host"></div>
                {/* 补全浮层叠在终端上，不再单独提供命令输入条 */}
                <div className="completion-list" id="completion-list"></div>
                <div className="hint-meta" id="hint-meta"></div>
              </div>
            </section>

            <section className="panel" id="panel-metrics">
              <div className="metrics-toolbar">
                <button className="btn sm" id="metrics-toggle">开启</button>
                <label className="field-inline">
                  <span>ms</span>
                  <input id="metrics-interval" type="number" min="2000" max="60000" step="1000" />
                </label>
                <span className="session-status" id="metrics-status"></span>
              </div>
              <div className="metrics-body" id="metrics-body">
                <div className="empty">未开启监控</div>
              </div>
            </section>

            <section className="panel" id="panel-sftp">
              <div className="sftp-toolbar">
                <input id="sftp-path" type="text" placeholder="路径" aria-label="远程路径" />
                <button className="icon-btn" id="btn-sftp-up" title="上一级" aria-label="上一级">↑</button>
                <button className="icon-btn" id="btn-sftp-refresh" title="刷新" aria-label="刷新">↻</button>
                <button className="icon-btn" id="btn-sftp-more" title="更多" aria-label="更多">⋯</button>
              </div>
              <div className="sftp-meta" id="sftp-meta"></div>
              <div className="sftp-list" id="sftp-list">
                <div className="empty">未连接</div>
              </div>
            </section>
          </div>
        </main>

        {/* 右侧浮层抽屉：历史 / 常用 */}
        <aside className="drawer" id="drawer" aria-hidden="true">
          <div className="drawer-head">
            <div className="drawer-tabs" role="tablist">
              <button data-tab="history" className="active" role="tab">历史</button>
              <button data-tab="snippets" role="tab">常用</button>
            </div>
            <button className="icon-btn" id="btn-drawer-close" title="关闭" aria-label="关闭">×</button>
          </div>
          <div className="drawer-tools">
            <input id="right-search" type="search" placeholder="过滤" aria-label="过滤" />
            <select id="right-scope" aria-label="范围">
              <option value="current">当前</option>
              <option value="all">全部</option>
            </select>
            <button className="icon-btn" id="btn-drawer-more" title="设置" aria-label="设置">⋯</button>
          </div>
          <div className="right-body" id="right-body">
            <div className="empty">加载中…</div>
          </div>
        </aside>
        <div className="drawer-scrim" id="drawer-scrim" hidden></div>
      </div>

      {/* 单一主操作 FAB */}
      <button className="fab" id="fab" title="新建连接" aria-label="新建连接" data-tip="新建连接">+</button>

      <div className="ctx-menu" id="ctx-menu" role="menu" hidden></div>

      {/* 连接表单：基础字段 + 高级折叠 */}
      <div className="modal-root" id="form-root">
        <div className="modal">
          <div className="modal-head">
            <h2 id="form-title">新建连接</h2>
            <button className="icon-btn" id="btn-form-cancel" title="关闭" aria-label="关闭">✕</button>
          </div>
          <div className="modal-body">
            <div className="form-error" id="f-form-error"></div>
            <div className="form-grid">
              <label className="field">名称 *
                <input id="f-name" type="text" placeholder="名称" />
              </label>
              <label className="field">环境
                <select id="f-env" aria-label="环境">
                  <option value="prod">生产</option>
                  <option value="staging">预发</option>
                  <option value="dev" selected>开发</option>
                  <option value="test">测试</option>
                  <option value="custom">自定义</option>
                </select>
              </label>
              <label className="field">主机 *
                <input id="f-host" type="text" placeholder="如 10.0.0.1 或 example.com" />
              </label>
              <label className="field">端口
                <input id="f-port" type="number" value="22" min="1" max="65535" />
              </label>
              <label className="field">用户名 *
                <input id="f-username" type="text" placeholder="如 root" />
              </label>
              <label className="field">认证
                <select id="f-auth" aria-label="认证方式">
                  <option value="password">密码</option>
                  <option value="key">私钥</option>
                  <option value="agent">SSH Agent</option>
                  <option value="keyboard-interactive">交互认证 / 双因素</option>
                </select>
              </label>
              <label className="field span2">标签（逗号分隔）<input id="f-tags" type="text" placeholder="production, api" /></label>
              <label className="field"><span><input id="f-favorite" type="checkbox" /> 收藏连接</span></label>
              <label className="field" id="f-password-wrap">密码
                <input id="f-password" type="password" placeholder="••••" autocomplete="new-password" />
              </label>
              <div className="field" id="f-keypath-wrap">
                <span className="field-lbl">私钥文件</span>
                <div className="input-row">
                  <input id="f-keypath" type="text" readOnly placeholder="通过宿主选择文件并授权" />
                  <button type="button" className="btn sm" id="btn-keypath-browse" title="从电脑选择私钥文件">选择文件</button>
                </div>
              </div>
              <label className="field" id="f-passphrase-wrap">口令
                <input id="f-passphrase" type="password" placeholder="••••" autocomplete="new-password" />
              </label>
              <div className="field span2 secret-state" id="secret-state"></div>
              <div className="field">
                <span className="field-lbl">分组</span>
                <button type="button" className="cs-trigger" id="f-group" data-value="" aria-haspopup="listbox" aria-expanded="false">
                  <span className="cs-label">未分组</span>
                  <span className="cs-caret">▾</span>
                </button>
              </div>
              <div className="field">
                <span className="field-lbl">颜色</span>
                <div className="color-pick">
                  <div className="color-swatches" id="f-color-swatches"></div>
                  <div className="color-custom">
                    <input id="f-color" type="text" className="color-hex" placeholder="#5b8cff" maxlength="9" spellcheck="false" />
                    <input id="f-color-native" type="color" className="color-native" value="#5b8cff" title="自定义颜色" aria-label="自定义颜色" />
                    <button type="button" className="btn sm ghost" id="btn-color-clear" title="清除颜色">清除</button>
                  </div>
                </div>
              </div>
              <label className="field span2">备注
                <textarea id="f-note" placeholder="备注"></textarea>
              </label>
            </div>
            <details className="adv-block" id="adv-block">
              <summary>高级</summary>
              <div className="form-grid adv-grid">
                <label className="field">保活（秒）
                  <input id="f-keepalive" type="number" value="30" min="0" />
                </label>
                <label className="field">超时（毫秒）
                  <input id="f-timeout" type="number" value="20000" min="1000" />
                </label>
                <label className="field">终端类型
                  <input id="f-term" type="text" value="xterm-256color" />
                </label>
                <label className="field">主机指纹策略
                  <select id="f-fp" aria-label="主机指纹策略">
                    <option value="tofu" selected>首次信任</option>
                    <option value="accept-new">自动接受新主机</option>
                    <option value="strict">严格校验</option>
                  </select>
                </label>
                <label className="field">列数
                  <input id="f-cols" type="number" value="120" />
                </label>
                <label className="field">行数
                  <input id="f-rows" type="number" value="32" />
                </label>
                <label className="field span2">SSH Agent<small>使用系统 SSH Agent，连接时由宿主请求单独授权。</small></label>
                <label className="field span2">此连接的网络代理
                  <select id="f-proxy-type" aria-label="网络代理类型"><option value="">直连</option><option value="http-connect">HTTP CONNECT</option><option value="socks5">SOCKS5</option></select>
                  <small>仅代理第一跳；有跳板时代理连接到首台跳板。不使用壳软件的 HTTP 代理设置。</small>
                </label>
                <div className="form-grid span2 wb-proxy-fields" id="f-proxy-fields" hidden>
                  <label className="field">代理主机<input id="f-proxy-host" type="text" placeholder="127.0.0.1" autocomplete="off" /></label>
                  <label className="field">代理端口<input id="f-proxy-port" type="number" min="1" max="65535" value="1080" /></label>
                  <label className="field">代理用户名<input id="f-proxy-user" type="text" placeholder="留空表示不认证" autocomplete="off" /></label>
                  <label className="field">代理密码<input id="f-proxy-password" type="password" placeholder="留空保留已保存密码" autocomplete="new-password" /></label>
                  <div className="field span2" id="proxy-secret-state"></div>
                  <small className="span2">密码仅保存在凭据库。HTTP CONNECT 使用 Basic 认证；SOCKS5 支持无认证和用户名密码认证。</small>
                </div>
                <label className="field span2">多级跳板链（每行一个已有连接名称，按连接顺序填写）<textarea id="f-jumps" rows="3" placeholder={'公网跳板\n内网跳板'}></textarea><small>填写后优先使用此链；最多 8 层，各跳板沿用其认证方式。</small></label>
                <div className="field span2">
                  <span className="field-lbl">单级跳板机</span>
                  <button type="button" className="cs-trigger" id="f-jump-profile" data-value="" aria-haspopup="listbox" aria-expanded="false">
                    <span className="cs-label">不使用跳板</span>
                    <span className="cs-caret">▾</span>
                  </button>
                </div>
                <label className="field">跳板主机
                  <input id="f-jump-host" type="text" placeholder="如 jump.example.com" />
                </label>
                <label className="field">跳板端口
                  <input id="f-jump-port" type="number" value="22" min="1" max="65535" />
                </label>
                <label className="field">跳板用户
                  <input id="f-jump-user" type="text" placeholder="默认同连接用户" />
                </label>
                <label className="field">跳板认证
                  <select id="f-jump-auth" aria-label="跳板认证方式">
                    <option value="password">密码</option>
                    <option value="key">私钥</option>
                    <option value="agent">SSH Agent</option>
                    <option value="keyboard-interactive">交互认证 / 双因素</option>
                  </select>
                </label>
                <div className="field span2" id="f-jump-keypath-wrap">
                  <span className="field-lbl">跳板私钥文件</span>
                  <div className="input-row">
                    <input id="f-jump-keypath" type="text" readOnly placeholder="通过宿主选择文件并授权" />
                    <button type="button" className="btn sm" id="btn-jump-key-browse" title="从电脑选择跳板私钥文件">选择文件</button>
                  </div>
                </div>
              </div>
            </details>
            <div className="host-status" id="form-test-status"></div>
          </div>
          <div className="modal-foot">
            <button className="btn ghost" id="btn-form-test" title="测试连接" aria-label="测试连接">测试</button>
            <button className="btn ghost" id="btn-form-cancel-foot" title="取消" aria-label="取消">取消</button>
            <button className="btn primary" id="btn-form-save" title="保存连接" aria-label="保存连接">保存</button>
          </div>
        </div>
      </div>

      <div className="modal-root" id="confirm-root">
        <div className="modal small">
          <div className="modal-head">
            <h2 id="confirm-title">确认</h2>
          </div>
          <div className="modal-body">
            <div id="confirm-body" className="confirm-body"></div>
          </div>
          <div className="modal-foot">
            <button className="btn ghost" id="confirm-cancel">取消</button>
            <button className="btn primary" id="confirm-ok">确定</button>
          </div>
        </div>
      </div>

      <div className="modal-root" id="prompt-root">
        <div className="modal small">
          <div className="modal-head">
            <h2 id="prompt-title">输入</h2>
          </div>
          <div className="modal-body">
            <input id="prompt-input" type="text" aria-label="输入" />
            <div className="prompt-note" id="prompt-note" aria-live="polite"></div>
          </div>
          <div className="modal-foot">
            <button className="btn ghost" id="prompt-cancel">取消</button>
            <button className="btn primary" id="prompt-ok">确定</button>
          </div>
        </div>
      </div>
    </>
  )
}

export function App() {
  const kitRef = useRef(null)
  const [mode, setMode] = useState(initialMode)
  // Keep live terminal DOM after its first mount; a cold panel never boots the workbench.
  const [workbenchMounted, setWorkbenchMounted] = useState(() => initialMode() !== 'panel')
  useEffect(() => {
    const kit = PluginKit.create({ title: 'SSH', height: 420 })
    kitRef.current = kit
    const changeMode = next => {
      setMode(next)
      if (next !== 'panel') setWorkbenchMounted(true)
      else {
        PluginKit.closeMenu({ restoreFocus: false })
        document.querySelectorAll('dialog.wb-dialog[open]').forEach(dialog => dialog.close())
      }
    }
    changeMode(kit.mode)
    const offMode = kit.onMode(changeMode)
    return () => { offMode(); kit.destroy() }
  }, [])

  /* 静态骨架就位后按原 script 执行顺序引导业务引擎（模块 import 去重，只会运行一次）。
     app.js 的 boot 依赖以上静态节点；workbench.js 等 ssh-workbench-ready 后自举。 */
  useEffect(() => {
    if (!workbenchMounted) { sshIndexedView.ready(); return }
    let alive = true
    void (async () => {
      await import('@ssh/js/tips-global.js')
      await import('@ssh/js/api.js')
      await import('@ssh/js/dict.js')
      await import('@ssh/js/store.js')
      await import('@ssh/js/commandCompletion.js')
      await import('@ssh/js/sshCompletion.js')
      if (!alive) return
      await import('@ssh/js/term.js')
      await import('@ssh/js/app.js')
      await import('@ssh/js/workbench.js')
    })().catch(error => sshIndexedView.fail(error))
    return () => { alive = false }
  }, [workbenchMounted])

  return <>
    {workbenchMounted && <div className="ssh-workbench-surface" hidden={mode === 'panel'}><AppSkeleton /></div>}
    {mode === 'panel' && <PanelView onOpenShell={() => Promise.resolve(host?.ui?.openInShell?.()).catch(error => kitRef.current?.toast(error.message, 'error'))} />}
  </>
}
