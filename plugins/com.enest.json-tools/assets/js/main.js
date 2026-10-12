      const api = window.enest || window.zapi
      const $ = (id) => document.getElementById(id)

      // >2MB 提示可能卡顿；>8MB 拒绝处理
      const SOFT_LIMIT = 2 * 1024 * 1024
      const HARD_LIMIT = 8 * 1024 * 1024

      const toast = async (message, type = 'info') => {
        try { await api?.ui?.toast?.({ message, type }) } catch {}
      }
      const isPerm = (err) => String(err?.message || err).includes('permission denied')

      function fmtBytes(n) {
        return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'
      }

      // 输入守卫：返回 true 表示可继续处理
      function guardInput() {
        const len = new Blob([$('input').value]).size
        if (len > HARD_LIMIT) {
          toast('输入超过 8MB，已拒绝处理', 'error')
          return false
        }
        if (len > SOFT_LIMIT) toast('输入超过 2MB，处理可能卡顿', 'warn')
        return true
      }

      // —— 校验错误定位：at position N → 行:列 ——
      // 新版 V8 的 "Unexpected token" 报错不含 position，用迷你扫描器兜底定位
      function scanJsonError(s) {
        let i = 0
        const n = s.length
        const HEX = /[0-9a-fA-F]/
        function ws() { while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++ }
        function string() {
          i++
          while (i < n) {
            if (s[i] === '"') { i++; return -1 }
            if (s[i] === '\\') {
              if (i + 1 >= n) return i + 1
              const e = s[i + 1]
              if (e === 'u') {
                let j = i + 2
                let taken = 0
                while (j < n && taken < 4 && HEX.test(s[j])) { j++; taken++ }
                if (taken < 4) return Math.min(j, n - 1)
                i = j
                continue
              }
              if (e === '"' || e === '\\' || e === '/' || e === 'b' || e === 'f' || e === 'n' || e === 'r' || e === 't') { i += 2; continue }
              return i + 1
            }
            i++
          }
          return n
        }
        function number() {
          if (s[i] === '-') i++
          if (i < n && s[i] === '0') i++
          else if (i < n && s[i] >= '1' && s[i] <= '9') { while (i < n && s[i] >= '0' && s[i] <= '9') i++ }
          else return i
          if (i < n && s[i] === '.') {
            i++
            if (!(i < n && s[i] >= '0' && s[i] <= '9')) return i
            while (i < n && s[i] >= '0' && s[i] <= '9') i++
          }
          if (i < n && (s[i] === 'e' || s[i] === 'E')) {
            i++
            if (i < n && (s[i] === '+' || s[i] === '-')) i++
            if (!(i < n && s[i] >= '0' && s[i] <= '9')) return i
            while (i < n && s[i] >= '0' && s[i] <= '9') i++
          }
          return -1
        }
        function value() {
          ws()
          if (i >= n) return i
          const c = s[i]
          if (c === '"') return string()
          if (c === '{') return object()
          if (c === '[') return array()
          if (s.startsWith('true', i)) { i += 4; return -1 }
          if (s.startsWith('false', i)) { i += 5; return -1 }
          if (s.startsWith('null', i)) { i += 4; return -1 }
          return number()
        }
        function array() {
          i++
          ws()
          if (i < n && s[i] === ']') { i++; return -1 }
          for (;;) {
            const r = value()
            if (r !== -1) return r
            ws()
            if (i < n && s[i] === ',') { i++; continue }
            if (i < n && s[i] === ']') { i++; return -1 }
            return i
          }
        }
        function object() {
          i++
          ws()
          if (i < n && s[i] === '}') { i++; return -1 }
          for (;;) {
            ws()
            if (i >= n || s[i] !== '"') return i
            const r = string()
            if (r !== -1) return r
            ws()
            if (i >= n || s[i] !== ':') return i
            i++
            const rv = value()
            if (rv !== -1) return rv
            ws()
            if (i < n && s[i] === ',') { i++; continue }
            if (i < n && s[i] === '}') { i++; return -1 }
            return i
          }
        }
        const r = value()
        if (r !== -1) return r
        ws()
        return i < n ? i : -1
      }

      function lineColOf(text, pos) {
        const before = text.slice(0, pos)
        const line = (before.match(/\n/g) || []).length + 1
        const lastNl = before.lastIndexOf('\n')
        const col = pos - lastNl // lastNl=-1 时恰为 pos+1（1-based 列）
        return { line, col }
      }

      function locateError(text, err) {
        const raw = String(err?.message || err)
        const m = /position (\d+)/.exec(raw)
        let pos = -1
        if (m) {
          pos = Math.min(Number(m[1]), text.length) // EOF 错误 position == length，保留
        } else {
          const scanned = scanJsonError(text)
          if (scanned >= 0) pos = scanned
        }
        if (pos < 0) return { line: 0, col: 0, msg: raw, pos: -1 }
        const { line, col } = lineColOf(text, pos)
        const msg = raw.replace(/\s*in JSON at position \d+.*$/s, '').trim() || 'Unexpected token'
        return { line, col, msg: msg.length > 90 ? msg.slice(0, 90) + '…' : msg, pos }
      }

      function showErrorInfo(text, info) {
        const box = $('error')
        box.style.display = 'block'
        box.textContent = info.line
          ? '第 ' + info.line + ' 行第 ' + info.col + ' 列：' + info.msg
          : 'JSON 解析失败：' + info.msg
        // 聚焦并选中出错位置附近字符
        if (info.pos >= 0 && $('input').value === text) {
          const start = Math.max(0, Math.min(info.pos, Math.max(text.length - 1, 0)))
          const end = Math.min(text.length, start + 1)
          $('input').focus()
          $('input').setSelectionRange(start, end)
        }
      }

      function showError(text, err) {
        showErrorInfo(text, locateError(text, err))
      }

      function clearError() {
        const box = $('error')
        box.style.display = 'none'
        box.textContent = ''
      }

      // —— UI 接线（仅呈现，不影响功能逻辑）——
      // header 徽标显示输入大小；footer 右侧显示结果大小
      function updateInputBadge() {
        const v = $('input').value
        $('meta').textContent = v ? fmtBytes(new Blob([v]).size) : ''
      }

      function hideStats() {
        $('stats').classList.remove('show')
      }

      function showStats(s, root, bytes) {
        $('st-nodes').textContent = String(s.nodes)
        $('st-depth').textContent = String(s.maxDepth)
        $('st-keys').textContent = String(s.keys)
        $('st-root').textContent = root ? '根 ' + root + ' · ' + fmtBytes(bytes) : ''
        $('stats').classList.add('show')
      }

      function setResult(text) {
        $('output').value = text
        const len = new Blob([text]).size
        $('stat-size').textContent = text ? fmtBytes(len) + ' · ' + text.length + ' 字符' : ''
        hideStats()
      }

      // —— 统计（校验成功）：节点数 / 最大深度 / 键数 ——
      function statsOf(value) {
        let nodes = 0
        let keys = 0
        let maxDepth = 0
        const walk = (v, depth) => {
          nodes++
          if (depth > maxDepth) maxDepth = depth
          if (Array.isArray(v)) {
            for (const item of v) walk(item, depth + 1)
          } else if (v && typeof v === 'object') {
            for (const k of Object.keys(v)) {
              keys++
              walk(v[k], depth + 1)
            }
          }
        }
        walk(value, 1)
        return { nodes, keys, maxDepth }
      }

      // —— 核心操作 ——

      function transform(mode) {
        const text = $('input').value
        if (!text.trim()) { toast('请先输入内容', 'warn'); return }

        if (mode === 'escape') {
          if (!guardInput()) return
          clearError()
          setResult(JSON.stringify(text).slice(1, -1)) // 去首尾引号，保留内部转义
          toast('已转义', 'success')
          return
        }

        if (mode === 'unescape') {
          if (!guardInput()) return
          const s = text.trim()
          if (!s.includes('\\') && !/^"/.test(s)) {
            toast('未发现转义序列，无需反转义', 'warn')
            return
          }
          try {
            setResult(JSON.parse('"' + s + '"'))
            clearError()
            toast('已反转义', 'success')
          } catch (e) {
            // 包裹引号后 parse：错误 position 相对 '"'+s+'"'，还原到原输入需 -1
            const info = locateError('"' + s + '"', e)
            if (info.pos >= 0) info.pos -= 1
            if (info.pos >= 0) {
              const lc = lineColOf(s, info.pos)
              info.line = lc.line
              info.col = lc.col
            }
            info.msg = '非法转义序列：' + info.msg
            showErrorInfo(text, info)
            setResult('')
            toast('反转义失败：非法转义序列', 'error')
          }
          return
        }

        // 格式化 / 压缩 / 校验：均需 JSON.parse
        if (!guardInput()) return
        let obj
        try {
          obj = JSON.parse(text)
        } catch (e) {
          showError(text, e)
          setResult('')
          toast('JSON 无效：' + (locateError(text, e).msg || '解析失败'), 'error')
          return
        }
        clearError()

        if (mode === 'check') {
          const s = statsOf(obj)
          const root = Array.isArray(obj) ? 'array' : obj === null ? 'null' : typeof obj
          setResult('')
          showStats(s, root, new Blob([text]).size)
          toast('JSON 有效', 'success')
          return
        }

        const indent = mode === 'fmt4' ? 4 : mode === 'fmt2' ? 2 : 0
        setResult(JSON.stringify(obj, null, indent))
        toast(indent === 0 ? '已压缩' : '已格式化（' + indent + ' 空格）', 'success')
      }

      // —— 事件绑定 ——

      $('btn-fmt2').onclick = () => transform('fmt2')
      $('btn-fmt4').onclick = () => transform('fmt4')
      $('btn-min').onclick = () => transform('min')
      $('btn-check').onclick = () => transform('check')
      $('btn-esc').onclick = () => transform('escape')
      $('btn-unesc').onclick = () => transform('unescape')

      $('btn-paste').onclick = async () => {
        try {
          const text = await api.clipboard.readText()
          if (!text) { toast('剪贴板为空', 'warn'); return }
          $('input').value = text
          updateInputBadge()
          transform('fmt2')
        } catch (e) {
          toast(isPerm(e) ? '缺少 clipboard.read 权限' : String(e?.message || e), 'error')
        }
      }
      $('btn-copy').onclick = async () => {
        const out = $('output').value
        if (!out) { toast('没有可复制的结果', 'warn'); return }
        try {
          await api.clipboard.writeText(out)
          toast('已复制结果', 'success')
        } catch (e) {
          toast(isPerm(e) ? '缺少 clipboard.write 权限' : String(e?.message || e), 'error')
        }
      }
      $('btn-clear').onclick = () => {
        $('input').value = ''
        $('output').value = ''
        $('meta').textContent = ''
        $('stat-size').textContent = ''
        clearError()
        hideStats()
        $('input').focus()
      }

      $('input').addEventListener('input', () => {
        clearError()
        updateInputBadge()
      })

      document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); transform('fmt2') }
        else if ((e.ctrlKey || e.metaKey) && e.key === '1') { e.preventDefault(); transform('min') }
        else if ((e.ctrlKey || e.metaKey) && e.key === '2') { e.preventDefault(); transform('check') }
        else if ((e.ctrlKey || e.metaKey) && e.key === '3') { e.preventDefault(); transform('escape') }
      })

      api?.onEnter?.(({ payload }) => {
        // payload 带 type:'text' 的内容预填并自动格式化
        const text =
          payload && typeof payload === 'object' && payload.type === 'text' && typeof payload.text === 'string'
            ? payload.text
            : typeof payload === 'string'
              ? payload
              : ''
        if (text) {
          $('input').value = text
          updateInputBadge()
          transform('fmt2')
        } else {
          $('input').focus()
        }
      })
      api?.ui?.setTitle?.('JSON 工具')
      updateInputBadge()
      $('input').focus()
    
