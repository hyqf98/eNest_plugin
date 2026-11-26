(() => {
  'use strict'
  function post(action) {
    const message = JSON.stringify(action)
    if (window.chrome?.webview) window.chrome.webview.postMessage(message)
    else window.webkit?.messageHandlers?.desktop?.postMessage(message)
  }
  const surface = window.FreeDesktopSurface(document.querySelector('#desk'), post, true)
  window.enestDesktopReceive = message => {
    if (message.op === 'render') surface.render(message.state)
    else if (message.op === 'wallpaper') surface.wallpaper(message.data)
    else if (message.op === 'notice') surface.notice(message.text)
  }
  post({action: 'ready'})
})()
