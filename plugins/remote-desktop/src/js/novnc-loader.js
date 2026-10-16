/**
 * novnc-loader — 把 vendored noVNC 1.5.0（CJS 构建最小集）挂载到 window.RFB
 * 结构：assets/vendor/novnc/lib/**（rfb.js 入口，相对 require 自动解析）
 * License：MPL-2.0 / BSD（见 LICENSE-noVNC.txt、LICENSE-pako.txt）
 *
 * 无构建 / 无 eval：每个 CJS 模块经 <script> 标签按依赖序加载，文件内容
 * 事先包一层 register 调用（bootstrap 阶段同步 XHR 取文本 → Blob URL script
 * 注入；Blob URL 继承页面 CSP 的 script-src，dev 服务器允许 'self'——blob:
 * 不在白名单时退化为 file 内联 data: 均不可行，故改用「同源 fetch + 包装文本
 * → Blob script」仅当 CSP 允许 blob:；Electron 插件页无此限制，dev-server
 * 冒烟用例见 tests/remote-desktop.ui.js（其下断言不依赖 noVNC 加载成功）。
 */
;(function (global) {
  'use strict'

  const BASE = 'assets/vendor/novnc/lib/'
  // 依赖序（rfb.js 的 require 树扁平展开）
  const ORDER = [
    'util/browser.js',
    'util/logging.js',
    'util/strings.js',
    'util/int.js',
    'util/events.js',
    'util/eventtarget.js',
    'util/element.js',
    'util/cursor.js',
    'input/util.js',
    'input/keysym.js',
    'input/keysymdef.js',
    'input/vkeys.js',
    'input/domkeytable.js',
    'input/xtscancodes.js',
    'input/fixedkeys.js',
    'input/keyboard.js',
    'input/gesturehandler.js',
    'vendor/pako/lib/zlib/deflate.js',
    'vendor/pako/lib/zlib/inflate.js',
    'vendor/pako/lib/zlib/zstream.js',
    'base64.js',
    'encodings.js',
    'deflator.js',
    'inflator.js',
    'display.js',
    'websock.js',
    'ra2.js',
    'crypto/bigint.js',
    'crypto/md5.js',
    'crypto/des.js',
    'crypto/aes.js',
    'crypto/dh.js',
    'crypto/rsa.js',
    'crypto/crypto.js',
    'decoders/raw.js',
    'decoders/copyrect.js',
    'decoders/rre.js',
    'decoders/hextile.js',
    'decoders/tight.js',
    'decoders/tightpng.js',
    'decoders/jpeg.js',
    'decoders/zrle.js',
    'rfb.js'
  ]

  const cache = new Map()
  const factories = new Map()

  // 模块注册协议：包装脚本调用 __novncRegister(path, module, exports, require) 后
  // 由 loader 执行工厂（eval-free：脚本本体经 Blob URL <script> 同源执行）
  global.__novncRegister = function (path, factory) {
    factories.set(path, factory)
  }

  function resolvePath(from, name) {
    const stack = from ? from.split('/').slice(0, -1) : []
    for (const part of name.split('/')) {
      if (part === '.' || part === '') continue
      if (part === '..') stack.pop()
      else stack.push(part)
    }
    return stack.join('/')
  }

  function loadModule(path) {
    if (cache.has(path)) return cache.get(path).exports
    const factory = factories.get(path)
    if (!factory) throw new Error('novnc module not registered: ' + path)
    const mod = { exports: {} }
    cache.set(path, mod)
    factory(requireFor(path), mod.exports, mod)
    return mod.exports
  }

  function requireFor(from) {
    const require = name => loadModule(resolvePath(from, name))
    return require
  }

  /** 同步取模块文本并包一层 register（CJS 头部补 module/exports/require 形参） */
  function wrapSource(path, source) {
    // 严格模式包裹会让 CJS 内的隐式全局（极少）报错；不开启严格模式，保持上游语义
    return '__novncRegister(' + JSON.stringify(path) + ', function (require, exports, module) {\n' +
      source +
      '\n});'
  }

  let preloadPromise = null
  function preload() {
    if (preloadPromise) return preloadPromise
    preloadPromise = (async () => {
      const texts = await Promise.all(ORDER.map(async path => {
        const response = await fetch(BASE + path)
        if (!response.ok) throw new Error('novnc load failed: ' + path + ' (' + response.status + ')')
        return [path, await response.text()]
      }))
      // 一次性合并为一个 Blob（单 script 执行，保持注册顺序）
      const combined = texts.map(([path, text]) => wrapSource(path, text)).join('\n')
      await runScript(combined)
    })()
    return preloadPromise
  }

  function runScript(code) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script')
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
      script.src = url
      script.onload = () => { URL.revokeObjectURL(url); resolve() }
      script.onerror = () => { URL.revokeObjectURL(url); reject(new Error('novnc script blocked (CSP)')) }
      document.head.append(script)
    })
  }

  /** 异步入口：加载完成后返回 noVNC RFB 构造器 */
  async function rfb() {
    await preload()
    const mod = loadModule('rfb.js')
    return mod && mod.default ? mod.default : mod
  }

  global.NovncLoader = { preload, rfb, factories }
})(window)
