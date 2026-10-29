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
import { disposeNavigation } from '../js/tree.js'

export function App() {
  useEffect(() => {
    void boot().catch(fatal)
    return () => disposeNavigation()
  }, [])
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
