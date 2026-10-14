/* DshMain — 路由（main: quick|shell / settings）+ 启动装配 + 模式迁移 */
;(() => {
  const api = window.enest || window.zapi
  const { state, subscribe, boot, startPolling } = window.DshState
  let route = 'main' // main | settings

  const kit = window.PluginKit.create({
    title: 'DSH 驾驶舱',
    quickPlaceholder: '快速对话 / 查会话进度 · Enter 发送',
    height: 560,
    onQuery: (value) => {
      const input = document.getElementById('composer-input')
      if (input && value) {
        input.value = String(value).slice(0, 4000)
        input.focus()
      }
    },
    onAction: (action) => {
      if (action === 'submit') {
        const send = document.getElementById('composer-send')
        if (send) send.click()
      }
    }
  })

  function currentMode() {
    try {
      return kit.mode || api.getLaunchMode?.() || 'shell'
    } catch {
      return 'shell'
    }
  }

  function rerender() {
    if (route === 'settings') {
      window.DshSettings.render()
      return
    }
    const mode = currentMode()
    if (mode === 'quick') window.DshViews.renderCockpit()
    else window.DshViews.renderShell()
  }

  function go(next) {
    route = next
    rerender()
  }

  window.DshRouter = { go, rerender }

  // 模式迁移（quick ↔ shell 固定）不重载页面：重渲染
  try {
    api.onModeChange?.((mode) => {
      state.mode = mode
      rerender()
    })
  } catch {
    /* 旧宿主无 onModeChange */
  }

  // Escape 从设置台返回主视图
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && route === 'settings') {
      go('main')
    }
  })

  window.DshState.setNotify(() => {
    // 数据变化时：设置台不整页重绘（局部状态多），仅主视图重绘
    if (route === 'main') rerender()
  })
  subscribe(() => {
    if (route === 'main') rerender()
  })

  void boot(currentMode()).then(() => {
    rerender()
    startPolling()
    // quick：自动拉起 sdk 快速对话通道；shell：ensureWeb 由 renderShell 触发
    if (currentMode() === 'quick') void window.DshState.ensureSdk()
  })

  rerender()
})()
