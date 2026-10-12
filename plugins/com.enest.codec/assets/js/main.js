      const api = window.enest || window.zapi
      const $ = (id) => document.getElementById(id)
      let mode = 'base64'   // base64 | url | hex | unicode
      let dir = 'encode'    // encode | decode
      let lastResult = ''

      const MODE_NAMES = { base64: 'Base64', url: 'URL', hex: 'Hex', unicode: 'Unicode' }
      const toast = async (message, type = 'info') => {
        try { await api?.ui?.toast?.({ message, type }) } catch {}
      }
      const isPerm = (err) => String(err?.message || err).includes('permission denied')

      function showError(msg) {
        $('error-text').textContent = msg
        $('error').classList.add('show')
      }
      function clearError() {
        $('error-text').textContent = ''
        $('error').classList.remove('show')
      }

      function refreshDir() {
        const name = MODE_NAMES[mode]
        // 方向标签：当前模式名加粗高亮（name 为白名单值，可安全内联）
        $('dir-label').innerHTML = dir === 'encode'
          ? '文本 → <b>' + name + '</b>'
          : '<b>' + name + '</b> → 文本'
        $('btn-dir').title = dir === 'encode' ? '切换为解码' : '切换为编码'
        $('in-title').textContent = dir === 'encode' ? '输入 · 原文' : '输入 · ' + name
        $('out-title').textContent = dir === 'encode' ? '输出 · ' + name : '输出 · 原文'
        $('input').placeholder = dir === 'encode'
          ? '输入要编码的文本…'
          : '输入要解码的 ' + name + ' 字符串…'
      }

      // —— Base64：UTF-8 分块，中文安全 ——
      const b64encode = (s) => {
        const bytes = new TextEncoder().encode(s)
        let bin = ''
        const CHUNK = 0x8000
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
        }
        return btoa(bin)
      }
      const b64decode = (s) => {
        const bin = atob(s)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        return new TextDecoder().decode(bytes)
      }

      // —— URL ——
      const urlEncode = (s) => encodeURIComponent(s)
      const urlDecode = (s) => decodeURIComponent(s)

      // —— Hex：小写，逐字节 ——
      const hexEncode = (s) => {
        const bytes = new TextEncoder().encode(s)
        let out = ''
        for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
        return out
      }
      const hexDecode = (s) => {
        const clean = s.replace(/^0x/i, '').replace(/\s+/g, '')
        if (clean.length === 0) throw new Error('输入为空')
        if (clean.length % 2 !== 0) throw new Error('Hex 长度必须为偶数（当前 ' + clean.length + ' 位）')
        if (!/^[0-9a-f]+$/i.test(clean)) throw new Error('包含非法字符：只允许 0-9 / a-f')
        const bytes = new Uint8Array(clean.length / 2)
        for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16)
        return new TextDecoder().decode(bytes)
      }

      // —— Unicode：\uXXXX 代理对形式，中文安全 ——
      const unicodeEncode = (s) => {
        let out = ''
        for (const ch of s) {
          const cp = ch.codePointAt(0)
          if (cp > 0xffff) {
            // 星面字符 → 代理对
            const hi = Math.floor((cp - 0x10000) / 0x400) + 0xd800
            const lo = ((cp - 0x10000) % 0x400) + 0xdc00
            out += '\\u' + hi.toString(16).padStart(4, '0') + '\\u' + lo.toString(16).padStart(4, '0')
          } else {
            out += '\\u' + cp.toString(16).padStart(4, '0')
          }
        }
        return out
      }
      const unicodeDecode = (s) => {
        return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      }

      const ENCODERS = {
        base64: { encode: b64encode, decode: b64decode },
        url: { encode: urlEncode, decode: urlDecode },
        hex: { encode: hexEncode, decode: hexDecode },
        unicode: { encode: unicodeEncode, decode: unicodeDecode },
      }

      function fmtBytes(n) {
        if (n < 1024) return n + ' B'
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
        return (n / 1024 / 1024).toFixed(1) + ' MB'
      }

      // 输入侧字节数：跟随输入实时刷新（tabular-nums 右对齐展示）
      function refreshInCount() {
        const text = $('input').value
        const el = $('in-count')
        if (!text) { el.textContent = ''; el.classList.remove('live'); return }
        const bytes = new TextEncoder().encode(text).length
        el.textContent = text.length + ' 字符 · ' + fmtBytes(bytes)
        el.classList.add('live')
      }

      function resetOutput() {
        lastResult = ''
        $('output').textContent = '结果将显示在这里'
        $('output').classList.add('placeholder')
        $('out-count').textContent = ''
        $('out-count').classList.remove('live')
        $('meta').textContent = ''
        $('meta').hidden = true
      }

      function run() {
        const text = $('input').value
        clearError()
        if (!text) {
          resetOutput()
          return
        }
        const name = MODE_NAMES[mode]
        const fn = dir === 'encode' ? ENCODERS[mode].encode : ENCODERS[mode].decode
        try {
          const started = performance.now()
          const result = fn(text)
          const cost = performance.now() - started
          lastResult = result
          $('output').textContent = result === '' ? '（空结果）' : result
          $('output').classList.remove('placeholder')
          const inBytes = new TextEncoder().encode(text).length
          const outBytes = new TextEncoder().encode(result).length
          $('out-count').textContent = result.length + ' 字符 · ' + fmtBytes(outBytes)
          $('out-count').classList.add('live')
          // footer meta 已合并进面板标签行
          $('meta').textContent =
            '输入 ' + text.length + ' 字符 / ' + fmtBytes(inBytes) +
            ' · 输出 ' + result.length + ' 字符 / ' + fmtBytes(outBytes) +
            ' · ' + cost.toFixed(0) + ' ms'
          $('meta').hidden = false
        } catch (e) {
          let msg = String(e?.message || e)
          if (mode === 'base64' && dir === 'decode') {
            if (/invalid character|不能|InvalidCharacter/i.test(msg)) {
              msg = '不是合法的 Base64 字符串（仅允许 A-Z a-z 0-9 + / =，且长度需为 4 的倍数）'
            }
          } else if (mode === 'url' && dir === 'decode') {
            if (e instanceof URIError || /URI|malformed/i.test(msg)) {
              msg = '不是合法的 URL 编码字符串（% 序列格式错误）'
            }
          }
          showError((dir === 'encode' ? '编码' : '解码') + '失败：' + msg)
          if (isPerm(e)) toast('缺少相应权限', 'error')
        }
      }

      // 模式切换
      $('modes').addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-mode]')
        if (!btn) return
        mode = btn.dataset.mode
        for (const b of $('modes').querySelectorAll('button')) {
          b.classList.toggle('active', b === btn)
        }
        refreshDir()
        run()
      })

      // 方向切换
      $('btn-dir').onclick = () => {
        dir = dir === 'encode' ? 'decode' : 'encode'
        refreshDir()
        run()
      }

      // 执行
      $('btn-run').onclick = run
      document.addEventListener('keydown', (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
          ev.preventDefault()
          run()
        }
      })
      $('input').addEventListener('input', () => {
        clearError()
        refreshInCount()
      })

      // 粘贴 / 清空
      $('btn-paste').onclick = async () => {
        try {
          const text = await api.clipboard.readText()
          $('input').value = text || ''
          refreshInCount()
          run()
        } catch (e) {
          toast(isPerm(e) ? '缺少 clipboard.read 权限' : String(e?.message || e), 'error')
        }
      }
      $('btn-clear').onclick = () => {
        $('input').value = ''
        clearError()
        refreshInCount()
        resetOutput()
        $('input').focus()
      }

      // 复制
      async function copyOut() {
        if (!lastResult) { toast('暂无可复制的结果', 'info'); return }
        try {
          await api.clipboard.writeText(lastResult)
          toast('已复制结果', 'success')
        } catch (e) {
          toast(isPerm(e) ? '缺少 clipboard.write 权限' : String(e?.message || e), 'error')
        }
      }
      $('btn-copy').onclick = copyOut

      // 互换：输出 → 输入，并自动翻转方向
      $('btn-swap-panes').onclick = () => {
        if (!lastResult) { toast('暂无可互换的结果', 'info'); return }
        $('input').value = lastResult
        dir = dir === 'encode' ? 'decode' : 'encode'
        refreshDir()
        refreshInCount()
        run()
        $('input').focus()
      }

      // onEnter 预填（payload 带 type:'text'）
      api?.onEnter?.(({ payload }) => {
        let text = ''
        if (payload && typeof payload === 'object' && payload.type === 'text') {
          text = typeof payload.text === 'string' ? payload.text : ''
        } else if (typeof payload === 'string') {
          text = payload
        }
        if (text) {
          $('input').value = text
          refreshInCount()
          run()
        }
      })

      api?.ui?.setTitle?.('编解码')
      refreshDir()
      refreshInCount()
      $('input').focus()
