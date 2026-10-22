/**
 * com.github.eNest.ssh — 终端适配层
 * 优先 vendored xterm.js；不可用时降级为 textarea+pre 流式终端（仍可交互）。
 */
;(function (global) {
  function cssVar(name, fallback) {
    try {
      return (
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
      )
    } catch {
      return fallback
    }
  }

  function stripAnsi(s) {
    return String(s)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, '')
      .replace(/\r(?!\n)/g, '\n')
  }

  function termThemeFromCss() {
    const appearance = document.documentElement.hasAttribute('data-appearance-layout')
    return {
      background: cssVar(appearance ? '--surface' : '--term-bg', '#0b0f14'),
      foreground: cssVar(appearance ? '--text' : '--term-fg', '#e8eef7'),
      cursor: cssVar(appearance ? '--accent' : '--term-cursor', '#e8ecf4'),
      cursorAccent: cssVar(appearance ? '--surface' : '--term-bg', '#0b0f14'),
      selectionBackground: cssVar('--accent-soft', 'rgba(232,236,244,0.22)'),
      black: '#1c2330',
      red: '#ff6b7a',
      green: '#3dd68c',
      yellow: '#f5b942',
      blue: '#5b8cff',
      magenta: '#c792ea',
      cyan: '#56c8d8',
      white: '#e8eef7',
      brightBlack: '#6b7789',
      brightRed: '#ff8b98',
      brightGreen: '#6ee7b0',
      brightYellow: '#ffd27a',
      brightBlue: '#8eb0ff',
      brightMagenta: '#d7b3f5',
      brightCyan: '#8adce8',
      brightWhite: '#ffffff',
    }
  }

  /** 本地 PTY 尺寸估算（xterm 不可用时） */
  function estimateSize(el) {
    const w = el.clientWidth || 800
    const h = el.clientHeight || 400
    const fontSize = Number(SshStore?.state?.ui?.fontSize) || 13
    const charW = Math.max(7, Math.floor(fontSize * 0.6))
    const charH = Math.max(12, Math.floor(fontSize * 1.25))
    return {
      cols: Math.max(20, Math.floor(w / charW) - 2),
      rows: Math.max(8, Math.floor(h / charH) - 1),
    }
  }

  /* —— search addon 动态加载（index.html 不可改，运行时注入 script）—— */
  const searchAddonState = { promise: null, Ctor: null, failed: false }

  /** 加载 assets/vendor/xterm/addon-search.js（UMD → window.SearchAddon）；幂等 */
  function loadSearchAddon() {
    if (searchAddonState.Ctor) return Promise.resolve(searchAddonState.Ctor)
    if (searchAddonState.promise) return searchAddonState.promise
    const fallbackCtor =
      (global.SearchAddon && (global.SearchAddon.SearchAddon || global.SearchAddon)) || null
    if (fallbackCtor) {
      searchAddonState.Ctor = fallbackCtor
      return Promise.resolve(fallbackCtor)
    }
    searchAddonState.promise = new Promise((resolve) => {
      try {
        const s = document.createElement('script')
        s.src = 'assets/vendor/xterm/addon-search.js'
        s.async = false
        s.onload = () => {
          const Ctor = (global.SearchAddon && (global.SearchAddon.SearchAddon || global.SearchAddon)) || null
          searchAddonState.Ctor = Ctor
          resolve(Ctor)
        }
        s.onerror = () => {
          searchAddonState.failed = true
          resolve(null)
        }
        document.head.appendChild(s)
      } catch {
        searchAddonState.failed = true
        resolve(null)
      }
    })
    return searchAddonState.promise
  }

  /**
   * createTerminal(container, handlers)
   * handlers: { onData(data), onResize(cols, rows), onSelection() }
   * returns TerminalHandle
   */
  function createTerminal(container, handlers) {
    const opts = SshStore?.state?.ui || {}
    const fontSize = Number(opts.fontSize) || 13
    const fontFamily =
      cssVar('--mono', 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "PingFang SC", monospace')

    const TermCtor = global.Terminal
    const FitClass =
      (global.FitAddon && (global.FitAddon.FitAddon || global.FitAddon)) ||
      global.FitAddon ||
      null

    container.innerHTML = ''

    if (typeof TermCtor === 'function') {
      const term = new TermCtor({
        cursorBlink: true,
        fontSize,
        fontFamily,
        scrollback: 5000,
        convertEol: false,
        theme: termThemeFromCss(),
        allowProposedApi: true,
      })
      let fit = null
      if (typeof FitClass === 'function') {
        try {
          fit = new FitClass()
          term.loadAddon(fit)
        } catch {
          fit = null
        }
      }
      term.open(container)
      // OSC shell integration is session-local. Never infer password/TUI input as commands.
      let prompt = null
      let cwd = ''
      let commandRevision = 0, promptId = 0, parsing = 0, composing = false, pendingEcho = null, disposed = false
      const notifyCommandState = reason => handlers?.onCommandState?.({ reason, revision: commandRevision })
      term.parser.registerOscHandler(133, (data) => {
        const kind = data.split(';')[0]
        commandRevision++
        if (kind === 'B') { prompt = { row: term.buffer.active.baseY + term.buffer.active.cursorY, column: term.buffer.active.cursorX }; promptId++; pendingEcho = null }
        else if (kind === 'A' || kind === 'C' || kind === 'D') { prompt = null; pendingEcho = null }
        return true
      })
      term.parser.registerOscHandler(7, (data) => {
        try { cwd = decodeURIComponent(new URL(data).pathname) } catch { /* nonstandard shell */ }
        return true
      })
      const readBufferCommand = () => {
        const buffer = term.buffer.active
        if (!prompt || buffer.type === 'alternate') return null
        const row = buffer.baseY + buffer.cursorY
        if (row < prompt.row || row - prompt.row > 20) return null
        let text = '', cursor = 0, endRow = row
        while (endRow - prompt.row < 20 && buffer.getLine(endRow + 1)?.isWrapped) endRow++
        for (let y = prompt.row; y <= endRow; y++) {
          const line = buffer.getLine(y)
          if (!line) return null
          const start = y === prompt.row ? prompt.column : 0
          let end = term.cols
          if (buffer.getLine(y + 1)?.isWrapped) {
            // xterm leaves a null-width-one cell when a wide glyph cannot fit at the right edge.
            // It is layout padding, not a typed space. Keep real spaces and wide-glyph continuation cells.
            while (end > start) {
              const cell = line.getCell?.(end - 1)
              if (!cell || cell.getWidth() !== 1 || cell.getCode() !== 0) break
              end--
            }
          }
          if (y <= row) cursor += line.translateToString(false, start, y === row ? buffer.cursorX : end).length
          text += line.translateToString(false, start, end)
        }
        // Spaces before the cursor are input, including the space that opens subcommand suggestions.
        text = text.slice(0, Math.max(cursor, text.trimEnd().length))
        return { text, cursor: Math.min(cursor, text.length), cwd, promptId, revision: commandRevision }
      }
      const readCommand = () => !parsing && !composing && !pendingEcho ? readBufferCommand() : null
      const signature = snapshot => snapshot ? JSON.stringify([snapshot.promptId, snapshot.text, snapshot.cursor]) : ''
      const invalidateCommand = () => { prompt = null; pendingEcho = null; commandRevision++; notifyCommandState('invalidated') }
      const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
      const expectEcho = snapshots => {
        const unique = [...new Map(snapshots.map(snapshot => [signature(snapshot), snapshot])).values()].slice(0, 16)
        pendingEcho = { expected: unique[0], alternatives: unique.slice(1) }
      }
      const noteInput = data => {
        const before = pendingEcho?.expected || readBufferCommand()
        const expected = pendingEcho?.expected ? [pendingEcho.expected, ...(pendingEcho.alternatives || [])] : before ? [before] : []
        commandRevision++
        // Submission, interrupts and multiline paste retire the prompt before remote output arrives.
        if (/[\r\n\x03\x04]/.test(data)) { invalidateCommand(); return }
        if (before && before.cursor === before.text.length && !/[\x00-\x1f\x7f-\x9f]/.test(data)) {
          expectEcho(expected.map(snapshot => ({ ...snapshot, text: snapshot.text + data, cursor: snapshot.cursor + data.length })))
        } else if (before && before.cursor === before.text.length && data === '\x7f') {
          // Readline implementations delete either one code point or one complete grapheme.
          // Accept only those exact echoed outcomes; never clear the barrier on arbitrary output.
          expectEcho(expected.flatMap(snapshot => {
            const endings = [[...snapshot.text].slice(0, -1).join('')]
            if (graphemes && snapshot.text) {
              const last = [...graphemes.segment(snapshot.text)].at(-1)
              endings.push(snapshot.text.slice(0, last.index))
            }
            return endings.map(text => ({ ...snapshot, text, cursor: text.length }))
          }))
        } else if (pendingEcho) {
          // A navigation key racing unacknowledged text has no trustworthy append target.
          invalidateCommand(); return
        } else pendingEcho = { previous: signature(before) }
        notifyCommandState('input')
      }
      const afterWrite = () => {
        parsing = Math.max(0, parsing - 1)
        if (disposed) return
        const current = readBufferCommand()
        if (pendingEcho && current) {
          if (pendingEcho.expected && [pendingEcho.expected, ...(pendingEcho.alternatives || [])].some(expected => signature(current) === signature(expected)) || pendingEcho.previous !== undefined && signature(current) !== pendingEcho.previous) pendingEcho = null
        }
        notifyCommandState('output')
      }
      const onCompositionStart = () => { composing = true; commandRevision++; notifyCommandState('composition') }
      const onCompositionEnd = () => { composing = false; commandRevision++; notifyCommandState('composition') }
      const onPaste = () => { commandRevision++; notifyCommandState('paste') }
      container.addEventListener('compositionstart', onCompositionStart, true)
      container.addEventListener('compositionend', onCompositionEnd, true)
      container.addEventListener('paste', onPaste, true)
      term.attachCustomKeyEventHandler(event => handlers?.onKeyEvent?.(event) !== false)
      term.onScroll(() => { commandRevision++; notifyCommandState('scroll') })

      /* —— search addon：注入成功后挂载；失败则 search() 返回 { ok:false } 由 UI 降级 —— */
      const searchBox = { addon: null, disposed: false, onResults: null }
      void loadSearchAddon().then((Ctor) => {
        if (!Ctor || searchBox.disposed) return
        try {
          const addon = new Ctor()
          term.loadAddon(addon)
          searchBox.addon = addon
          // 透传 { resultIndex, resultCount }（decorations 生效时 addon 会 fire）。
          // addon.onDidChangeResults 是 event getter 返回的订阅函数（非对象），直接调用订阅
          if (typeof addon.onDidChangeResults === 'function') {
            addon.onDidChangeResults((r) => {
              if (!searchBox.disposed && typeof searchBox.onResults === 'function') searchBox.onResults(r)
            })
          }
        } catch {
          searchBox.addon = null
        }
      })

      /** 统一搜索入口：addon 优先，其次 __enestSearch 钩子，最后 { ok:false } 降级 */
      const doSearch = (term, q, opts) => {
        const o = opts || {}
        try {
          if (searchBox.addon && typeof searchBox.addon.findNext === 'function') {
            return Boolean(searchBox.addon.findNext(q, {
              caseSensitive: !!o.caseSensitive,
              wholeWord: !!o.wholeWord,
              regex: !!o.regex,
              decorations: o.highlight === false
                ? undefined
                : {
                    matchOverviewRuler: '#5b8cff',
                    activeMatchColorOverviewRuler: '#f5b942',
                  },
            }))
          }
          if (term.__enestSearch && typeof term.__enestSearch.findNext === 'function') {
            return Boolean(term.__enestSearch.findNext(q))
          }
        } catch {
          /* ignore */
        }
        return false
      }

      const resizeNow = () => {
        const previousCols = term.cols
        try {
          if (fit) fit.fit()
        } catch { /* ignore */ }
        const cols = term.cols || 80
        const rows = term.rows || 24
        if (previousCols !== cols) invalidateCommand()
        if (handlers && handlers.onResize) handlers.onResize(cols, rows)
      }

      const syncAppearance = () => {
        term.options.theme = termThemeFromCss()
        term.options.fontFamily = cssVar('--mono', fontFamily)
        const base = parseFloat(cssVar('--font-size-base', '13'))
        const scale = Number.isFinite(base) ? Math.min(1.3, Math.max(.85, base / 13)) : 1
        term.options.fontSize = (Number(SshStore?.state?.ui?.fontSize) || fontSize) * scale
        resizeNow()
      }
      const appearanceObserver = new MutationObserver(syncAppearance)
      appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'data-appearance-layout'] })
      syncAppearance()

      // 延迟 fit，确保布局完成
      requestAnimationFrame(() => resizeNow())

      let ro
      try {
        ro = new ResizeObserver(() => resizeNow())
        ro.observe(container)
      } catch {
        window.addEventListener('resize', resizeNow)
      }

      term.onData((data) => {
        if (handlers && handlers.onData) handlers.onData(data)
      })

      const selTimer = { t: null }
      term.onSelectionChange(() => {
        handlers?.onSelectionState?.()
        if (!SshStore?.state?.ui?.selectCopy) return
        clearTimeout(selTimer.t)
        selTimer.t = setTimeout(() => {
          try {
            const sel = term.getSelection()
            if (sel && handlers && handlers.onSelection) handlers.onSelection(sel)
          } catch { /* ignore */ }
        }, 120)
      })

      return {
        kind: 'xterm',
        readCommand,
        invalidateCommand,
        noteInput,
        getCwd() { return cwd },
        cursorRect() {
          const screen = container.querySelector('.xterm-screen')
          if (!screen) return null
          const rect = screen.getBoundingClientRect(), b = term.buffer.active
          return { left: rect.left + b.cursorX * rect.width / term.cols, top: rect.top + (b.baseY + b.cursorY - b.viewportY + 1) * rect.height / term.rows, cellHeight: rect.height / term.rows }
        },
        el: container,
        write(data) {
          commandRevision++; parsing++; notifyCommandState('output-pending')
          try {
            term.write(typeof data === 'string' ? data : new Uint8Array(data), afterWrite)
          } catch {
            try { term.write(String(data), afterWrite) } catch { afterWrite() }
          }
        },
        writeln(data) {
          invalidateCommand()
          try { term.writeln(String(data)) } catch { /* ignore */ }
        },
        focus() { try { term.focus() } catch { /* ignore */ } },
        revealCommand() {
          if (!readCommand()) return false
          // xterm updates viewportY and fires onScroll synchronously. Callers must
          // capture the command again afterwards because scrolling changes its revision.
          term.scrollToBottom()
          return true
        },
        clear() { invalidateCommand(); try { term.clear() } catch { /* ignore */ } },
        fit: resizeNow,
        getSize() {
          return { cols: term.cols || 80, rows: term.rows || 24 }
        },
        setTheme() {
          try { syncAppearance() } catch { /* ignore */ }
        },
        setFontSize(px) {
          try {
            const base = parseFloat(cssVar('--font-size-base', '13'))
            term.options.fontSize = px * (Number.isFinite(base) ? Math.min(1.3, Math.max(.85, base / 13)) : 1)
            resizeNow()
          } catch { /* ignore */ }
        },
        getSelection() {
          try { return term.getSelection() } catch { return '' }
        },
        /* —— 搜索：addon-search 优先；__enestSearch 钩子次之；均无则 ok:false 降级 —— */
        search(q, opts) {
          if (!q) return { ok: false }
          const hit = doSearch(term, String(q), opts)
          return { ok: hit }
        },
        searchPrev(q, opts) {
          if (!q) return { ok: false }
          let hit = false
          try {
            if (searchBox.addon && typeof searchBox.addon.findPrevious === 'function') {
              hit = Boolean(searchBox.addon.findPrevious(String(q), {
                caseSensitive: !!(opts && opts.caseSensitive),
                decorations: {
                  matchOverviewRuler: '#5b8cff',
                  activeMatchColorOverviewRuler: '#f5b942',
                },
              }))
            } else if (term.__enestSearch && typeof term.__enestSearch.findNext === 'function') {
              hit = Boolean(term.__enestSearch.findNext(String(q)))
            }
          } catch {
            hit = false
          }
          return { ok: hit }
        },
        clearSearch() {
          try {
            if (searchBox.addon && typeof searchBox.addon.clearDecorations === 'function') {
              searchBox.addon.clearDecorations()
            } else if (term.__enestSearch && term.__enestSearch.clear) {
              term.__enestSearch.clear()
            }
          } catch { /* ignore */ }
        },
        hasSearch() {
          return !!searchBox.addon
        },
        /** 搜索结果计数回调：onResults({ resultIndex, resultCount }) */
        setOnSearchResults(fn) {
          searchBox.onResults = typeof fn === 'function' ? fn : null
        },
        /** 旧兼容入口（true=找到） */
        searchNext(q) {
          if (!q) return false
          return doSearch(term, String(q), {}) || false
        },
        dispose() {
          disposed = true; invalidateCommand()
          appearanceObserver.disconnect()
          container.removeEventListener('compositionstart', onCompositionStart, true)
          container.removeEventListener('compositionend', onCompositionEnd, true)
          container.removeEventListener('paste', onPaste, true)
          window.removeEventListener('resize', resizeNow)
          clearTimeout(selTimer.t)
          searchBox.disposed = true
          try { ro && ro.disconnect() } catch { /* ignore */ }
          try { term.dispose() } catch { /* ignore */ }
          container.innerHTML = ''
        },
        raw: term,
      }
    }

    /* —— fallback：pre 输出 + 隐藏 input 键入 —— */
    const pre = document.createElement('pre')
    pre.className = 'term-fallback'
    pre.tabIndex = 0
    pre.setAttribute('aria-label', '终端输出（降级模式）')
    const hidden = document.createElement('textarea')
    hidden.setAttribute('aria-hidden', 'true')
    hidden.style.cssText =
      'position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;left:-9999px;'
    container.appendChild(pre)
    container.appendChild(hidden)

    let buffer = ''
    const MAX = 200000

    /* —— 降级模式本地搜索计数：文本包含式命中 + 序号推进 —— */
    const fallbackSearch = { onResults: null, idx: 0, count: 0, lastQ: '' }
    function fallbackCount(q) {
      const text = stripAnsi(buffer).toLowerCase()
      const needle = String(q).toLowerCase()
      if (!needle) return 0
      let n = 0
      let pos = text.indexOf(needle)
      while (pos !== -1) {
        n++
        pos = text.indexOf(needle, pos + needle.length)
      }
      return n
    }
    function fallbackReport(q, dir) {
      if (q !== fallbackSearch.lastQ) {
        fallbackSearch.lastQ = q
        fallbackSearch.idx = 0
        fallbackSearch.count = fallbackCount(q)
      }
      if (!fallbackSearch.count) {
        fallbackSearch.idx = 0
      } else if (dir === 'prev') {
        fallbackSearch.idx = (fallbackSearch.idx - 1 + fallbackSearch.count) % fallbackSearch.count
      } else {
        fallbackSearch.idx = (fallbackSearch.idx + 1) % fallbackSearch.count
      }
      if (typeof fallbackSearch.onResults === 'function') {
        fallbackSearch.onResults({
          resultIndex: fallbackSearch.count ? fallbackSearch.idx : -1,
          resultCount: fallbackSearch.count,
        })
      }
    }

    function render() {
      let text = stripAnsi(buffer)
      if (text.length > MAX) text = text.slice(-MAX)
      pre.textContent = text
      pre.scrollTop = pre.scrollHeight
    }

    function append(data) {
      buffer += typeof data === 'string' ? data : String(data)
      render()
    }

    function send(data) {
      if (handlers && handlers.onData) handlers.onData(data)
    }

    function resizeNow() {
      const size = estimateSize(pre.parentElement || container)
      if (handlers && handlers.onResize) handlers.onResize(size.cols, size.rows)
    }

    const roFallback = (() => {
      try {
        const r = new ResizeObserver(() => resizeNow())
        r.observe(container)
        return r
      } catch {
        window.addEventListener('resize', resizeNow)
        return null
      }
    })()

    const onKeyDown = (ev) => {
      // 字符级转发，兼容密码提示
      if (ev.key === 'Enter') {
        ev.preventDefault()
        append('\n')
        send('\r')
        return
      }
      if (ev.key === 'Backspace') {
        ev.preventDefault()
        send('\x7f')
        return
      }
      if (ev.key === 'Tab') {
        ev.preventDefault()
        send('\t')
        return
      }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); send('\x1b[A'); return }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); send('\x1b[B'); return }
      if (ev.key === 'ArrowRight') { ev.preventDefault(); send('\x1b[C'); return }
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); send('\x1b[D'); return }
      if (ev.ctrlKey && ev.key.length === 1) {
        ev.preventDefault()
        const code = ev.key.toUpperCase().charCodeAt(0)
        if (code >= 64 && code <= 95) send(String.fromCharCode(code - 64))
        return
      }
      if (ev.metaKey || ev.altKey) return
      if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey) {
        ev.preventDefault()
        send(ev.key)
      }
    }

    pre.addEventListener('keydown', onKeyDown)
    pre.addEventListener('paste', (ev) => {
      ev.preventDefault()
      const text = (ev.clipboardData || window.clipboardData).getData('text')
      if (text) send(text)
    })
    pre.addEventListener('click', () => pre.focus())
    requestAnimationFrame(() => resizeNow())

    return {
      kind: 'fallback',
      el: container,
      write: append,
      writeln(data) { append(String(data) + '\n') },
      focus() { pre.focus() },
      clear() { buffer = ''; render() },
      fit: resizeNow,
      getSize() { return estimateSize(pre.parentElement || container) },
      setTheme() { /* CSS 变量已生效 */ },
      setFontSize(px) {
        pre.style.fontSize = px + 'px'
        resizeNow()
      },
      getSelection() {
        try { return String(window.getSelection() || '') } catch { return '' }
      },
      search(q, opts) {
        if (!q) return { ok: false }
        const ok = stripAnsi(buffer).toLowerCase().includes(String(q).toLowerCase())
        fallbackReport(q, (opts && opts.dir) || 'next')
        return { ok }
      },
      searchPrev(q) {
        if (!q) return { ok: false }
        const ok = stripAnsi(buffer).toLowerCase().includes(String(q).toLowerCase())
        fallbackReport(q, 'prev')
        return { ok }
      },
      clearSearch() {
        /* 降级模式无高亮；仅重置计数游标 */
        fallbackSearch.idx = 0
        fallbackSearch.count = 0
        fallbackSearch.lastQ = ''
      },
      hasSearch() { return false },
      /** 降级模式的计数回调（与 addon 模式 setOnSearchResults 同构） */
      setOnSearchResults(fn) {
        fallbackSearch.onResults = typeof fn === 'function' ? fn : null
      },
      searchNext(q) {
        if (!q) return false
        return stripAnsi(buffer).toLowerCase().includes(String(q).toLowerCase())
      },
      dispose() {
        try { roFallback && roFallback.disconnect() } catch { /* ignore */ }
        pre.removeEventListener('keydown', onKeyDown)
        container.innerHTML = ''
      },
      raw: null,
    }
  }

  global.SshTerm = {
    createTerminal,
    termThemeFromCss,
    stripAnsi,
    loadSearchAddon,
  }
})(window)
