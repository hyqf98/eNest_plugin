/**
 * 数据库外壳 —— React 版
 * 只渲染原 index.html body 的静态骨架：结构 / 类名 / id / 注释与原版逐字一致，样式零改变。
 * 动态 UI（侧栏、编辑器、结果网格、工具栏、右栏、弹层）仍由 src/js 命令式渲染器
 * 写入对应容器（backend API 调用层与 Monaco 集成零改动）；本组件无任何 state，
 * 渲染产物不可变，不会与命令式写入发生协调冲突。
 */
export function App() {
  return (
    <>
      <div className="app" id="app">
        {/* 单条 chrome：侧栏开关 + 查询 Tab + 连接状态 + ⋯ */}
        <div className="workspace">
          <aside className="side" id="side"></aside>
          <div className="resizer left" id="resizer-left"></div>

          <div className="mid-col">
            <div className="mid-chrome">
              <button type="button" className="btn icon" id="side-toggle" title="展开/收起侧栏" aria-label="展开/收起侧栏" data-tip="展开/收起侧栏">≡</button>
              <div className="sql-tabs" id="editor-tabs" hidden></div>
              <div className="workspace-tabs" id="workspace-tabs" role="tablist" aria-label="工作标签"></div>
              <button type="button" className="btn icon" data-wb="newQuery" aria-label="新建查询" title="新建查询">＋</button>
              <button type="button" className="btn icon" data-wb="tabs" aria-label="所有标签" title="所有标签">⌄</button>
              <button type="button" className="btn" data-wb="openShell" hidden>桌面继续</button>
              <div className="mid-chip" id="toolbar"></div>
              <div className="spacer"></div>
              <button type="button" className="btn icon" id="top-more" title="更多操作" aria-label="更多操作" data-tip="更多操作">⋯</button>
            </div>
            <div className="query-surface" id="query-surface" role="tabpanel">
              <div className="editor-pane">
                <div className="editor-host" id="editor-host"></div>
                <div className="fab-dock" id="fab-dock">
                  <button type="button" className="fab-execute" id="fab-run" title="执行当前语句" aria-label="执行当前语句" data-tip="执行当前语句">▶</button>
                </div>
              </div>
              <div className="resizer bottom" id="resizer-bottom" hidden></div>
              <div className="results" id="results" hidden></div>
            </div>
          </div>

          <div className="resizer right" id="resizer-right"></div>
          <aside className="right-panel" id="right-panel" hidden></aside>
        </div>
      </div>

      <div id="modal-root"></div>
      <div id="local-toast" hidden></div>
    </>
  )
}
