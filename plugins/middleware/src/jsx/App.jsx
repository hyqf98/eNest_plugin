/**
 * App.jsx — 中间件控制台 · React 壳（原 index.html 静态骨架的等价迁移）
 * DOM 结构 / 类名 / id 与原版完全一致，视觉零改变；
 * 动态区域（#tree / #conn-tabs / #subnav / #page-host / #status-bar）仍由
 * src/js 原引擎（el() 工厂 + simpleGrid）驱动 —— 与「dangerouslySetInnerHTML + 事件委托」
 * 同一密度：数据区 HTML 原样生成，React 不参与逐节点 diff。
 * boot 生命周期（主题 / store / 快捷键 / onEnter / onBeforeClose / onDestroy）
 * 在唯一 useEffect 中执行一次；业务核心与 mw.* 宿主调用层未改动。
 */
import { useEffect } from 'react'
import { boot, fatal } from '../js/workbench.js'

export function App() {
  useEffect(() => { boot().catch(fatal) }, [])
  return (
    <>
      <div className="app" id="app">
        <div className="workbench-head"><button id="nav-toggle" className="icon-button" aria-label="显示连接导航" aria-controls="tree" title="连接导航">☰</button><span>中间件</span><span className="workbench-head-hint">连接与消息工作台</span><button id="open-shell" className="btn sm" hidden>在桌面打开</button></div>
        <div className="app-body">
          <button id="nav-scrim" aria-label="收起连接导航" hidden></button>
          {/* 左：连接树（按类型分组） */}
          <aside className="tree" id="tree"></aside>
          <div className="resizer tree-resizer" id="resizer-tree" role="separator" aria-label="连接导航宽度" aria-orientation="vertical" tabIndex={0}></div>
          {/* 右：内容区（子导航 + 页面宿主） */}
          <main className="content">
            <div className="conn-tabs" id="conn-tabs" role="tablist" aria-label="工作标签"></div>
            <div className="subnav" id="subnav"></div>
            <div className="page-host" id="page-host"></div>
          </main>
        </div>
        <footer className="status-bar" id="status-bar"></footer>
      </div>
    </>
  )
}
