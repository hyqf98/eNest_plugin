      const api = window.enest || window.zapi
      const $ = (id) => document.getElementById(id)
      const pad2 = (n) => String(n).padStart(2, '0')

      const toast = async (message, type = 'info') => {
        try { await api?.ui?.toast?.({ message, type }) } catch {}
      }
      const isPerm = (err) => String(err?.message || err).includes('permission denied')

      // —— 格式化 ——
      function fmtDateTime(d) {
        return (
          d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
          ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
        )
      }
      function fmtUTC(d) {
        return (
          'UTC ' + d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
          ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds())
        )
      }
      function tzOffsetStr(d) {
        const m = -d.getTimezoneOffset()
        const sign = m >= 0 ? '+' : '-'
        const am = Math.abs(m)
        return sign + pad2(Math.floor(am / 60)) + ':' + pad2(am % 60)
      }
      function fmtISO(d) {
        return (
          d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
          'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
          tzOffsetStr(d)
        )
      }
      function toLocalInput(d) {
        return (
          d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
          'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
        )
      }
      // 相对描述：刚刚 / N 秒|分钟|小时|天 前|后
      function relDesc(tsMs, nowMs) {
        const diff = tsMs - nowMs
        const abs = Math.abs(diff)
        if (abs < 1000) return '刚刚'
        let n, u
        if (abs >= 86400000) { n = abs / 86400000; u = '天' }
        else if (abs >= 3600000) { n = abs / 3600000; u = '小时' }
        else if (abs >= 60000) { n = abs / 60000; u = '分钟' }
        else { n = abs / 1000; u = '秒' }
        return Math.floor(n) + ' ' + u + (diff < 0 ? '前' : '后')
      }

      // —— 复制（统一委托：data-copy 指向内容元素 id）——
      async function copyText(text) {
        if (!text) return
        try {
          await api.clipboard.writeText(text)
          toast('已复制', 'success')
        } catch (e) {
          toast(isPerm(e) ? '缺少 clipboard.write 权限' : String(e?.message || e), 'error')
        }
      }

      // 复制成功视觉反馈：宿主行/按钮加 .copied，800ms 后自动还原
      const copiedTimers = new WeakMap()
      function flashCopied(el) {
        if (!el) return
        el.classList.add('copied')
        clearTimeout(copiedTimers.get(el))
        copiedTimers.set(el, setTimeout(() => el.classList.remove('copied'), 800))
      }

      document.addEventListener('click', (e) => {
        const target = e.target.closest('[data-copy]')
        if (!target) return
        const el = $(target.dataset.copy)
        const text = el ? el.textContent.trim() : ''
        if (text && text !== '—') {
          copyText(text)
          // 点的是按钮则只点亮按钮，点整行则点亮整行
          const btn = e.target.closest('.copy-btn')
          flashCopied(btn && btn !== target ? btn : target)
        }
      })
      // 键盘可达：Enter / Space 触发复制行
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        const target = e.target.closest && e.target.closest('[data-copy]')
        if (!target) return
        e.preventDefault()
        const el = $(target.dataset.copy)
        const text = el ? el.textContent.trim() : ''
        if (text && text !== '—') {
          copyText(text)
          flashCopied(target)
        }
      })

      // —— Quick 容器高度自适应：上报内容实际高度（需要 ui.resize 权限）——
      let heightTimer = null
      function reportHeight() {
        const h = Math.ceil(document.documentElement.scrollHeight)
        if (h <= 0) return
        try { api?.ui?.setHeight?.(h)?.catch?.(() => {}) } catch {}
      }
      function scheduleReportHeight() {
        clearTimeout(heightTimer)
        heightTimer = setTimeout(reportHeight, 60)
      }
      if (typeof ResizeObserver === 'function' && document.body) {
        new ResizeObserver(scheduleReportHeight).observe(document.body)
      } else {
        window.addEventListener('resize', scheduleReportHeight)
      }
      window.addEventListener('load', scheduleReportHeight)

      // —— 1. 当前时间实时刷新 ——
      function tick() {
        const now = new Date()
        const s = Math.floor(now.getTime() / 1000)
        $('now-local').textContent = fmtDateTime(now)
        $('now-utc').textContent = fmtUTC(now)
        $('now-s').textContent = String(s)
        $('now-ms').textContent = String(now.getTime())
        $('fmt-iso').textContent = fmtISO(now)
        $('fmt-date').textContent =
          now.getFullYear() + '/' + pad2(now.getMonth() + 1) + '/' + pad2(now.getDate())
        $('fmt-time').textContent =
          pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds())
        $('fmt-unix').textContent = String(s)
      }

      // —— 2. 时间戳 → 时间 ——
      function convertTs() {
        const raw = $('ts-input').value.trim()
        const err = $('ts-error')
        const box = $('ts-result')
        err.classList.add('hidden')
        box.classList.add('hidden')
        if (!raw) return
        if (!/^\d+$/.test(raw)) {
          err.textContent = '格式非法：请输入纯数字时间戳（10 位秒级 / 13 位毫秒级）'
          err.classList.remove('hidden')
          return
        }
        const ms = raw.length === 10 ? Number(raw) * 1000 : Number(raw) // 13 位毫秒，其他位数按毫秒
        const d = new Date(ms)
        if (isNaN(d.getTime())) {
          err.textContent = '超出可表示的时间范围'
          err.classList.remove('hidden')
          return
        }
        $('ts-out').textContent = fmtDateTime(d)
        $('ts-rel').textContent = relDesc(ms, Date.now())
        box.classList.remove('hidden')
      }

      // —— 3. 时间 → 时间戳 ——
      function convertTime() {
        const v = $('dt-input').value
        const d = v ? new Date(v) : null // datetime-local 字符串按本地时区解析
        if (!d || isNaN(d.getTime())) {
          $('dt-s').textContent = '—'
          $('dt-ms').textContent = '—'
          return
        }
        $('dt-s').textContent = String(Math.floor(d.getTime() / 1000))
        $('dt-ms').textContent = String(d.getTime())
      }

      // —— 5. 相对时间解析：[+-]N(h|m|d|w) ——
      const REL_UNITS = { h: 3600000, m: 60000, d: 86400000, w: 604800000 }
      function convertRel() {
        const raw = $('rel-input').value.trim().replace(/\s+/g, '')
        const err = $('rel-error')
        const box = $('rel-result')
        err.classList.add('hidden')
        box.classList.add('hidden')
        if (!raw) return
        const m = raw.match(/^([+-]?\d+(?:\.\d+)?)(h|m|d|w)$/i)
        if (!m) {
          err.textContent = '格式非法：支持 -1h / +30m / 3d / 2w（单位 h 时 m 分 d 天 w 周）'
          err.classList.remove('hidden')
          return
        }
        const t = Date.now() + Number(m[1]) * REL_UNITS[m[2].toLowerCase()]
        const d = new Date(t)
        if (isNaN(d.getTime())) {
          err.textContent = '计算结果超出可表示的时间范围'
          err.classList.remove('hidden')
          return
        }
        $('rel-out').textContent = fmtDateTime(d)
        $('rel-ts').textContent = String(Math.floor(t / 1000))
        box.classList.remove('hidden')
      }

      // —— 事件绑定 ——
      $('ts-input').addEventListener('input', convertTs)
      $('rel-input').addEventListener('input', convertRel)
      $('dt-input').addEventListener('input', convertTime)

      api?.onEnter?.(({ payload }) => {
        tick()
        convertTime()
        const s = typeof payload === 'string' ? payload.trim() : ''
        if (!s) return
        if (/^[+-]?\d+(?:\.\d+)?[hmdw]$/i.test(s)) {
          $('rel-input').value = s
          convertRel()
        } else if (/^\d{10,}$/.test(s)) {
          $('ts-input').value = s
          convertTs()
        }
      })

      api?.ui?.setTitle?.('时间戳')
      $('dt-input').value = toLocalInput(new Date())
      convertTime()
      tick()
      // 页眉时区标签（UTC+08:00）
      const tzLabel = document.querySelector('header .sub')
      if (tzLabel) tzLabel.textContent = 'UTC' + tzOffsetStr(new Date())
      setInterval(tick, 500)
      reportHeight()
