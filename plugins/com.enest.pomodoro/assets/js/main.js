      const api = window.enest || window.zapi
      const $ = (id) => document.getElementById(id)

      const toast = async (message, type = 'info') => {
        try { await api?.ui?.toast?.({ message, type }) } catch {}
      }
      const isPerm = (err) => String(err?.message || err).includes('permission denied')

      // —— 配置（settings 持久化） ——
      let focusMin = 25
      let breakMin = 5

      async function loadSettings() {
        try {
          const f = await api.settings.get('focusMin')
          const b = await api.settings.get('breakMin')
          if (typeof f === 'number' && f >= 5 && f <= 90) focusMin = f
          if (typeof b === 'number' && b >= 1 && b <= 30) breakMin = b
        } catch {}
        $('focus-min').value = focusMin
        $('break-min').value = breakMin
        if (!running) renderIdle()
      }
      function saveSettings() {
        try {
          void api.settings.set('focusMin', focusMin)
          void api.settings.set('breakMin', breakMin)
        } catch {}
      }

      // —— 今日统计（storage 持久化，跨天清零） ——
      const STATS_KEY = 'pomo_stats_v1'
      function todayStr() {
        const d = new Date()
        const m = String(d.getMonth() + 1).padStart(2, '0')
        const day = String(d.getDate()).padStart(2, '0')
        return d.getFullYear() + '-' + m + '-' + day
      }
      async function loadTodayCount() {
        let count = 0
        try {
          const v = await api.storage.get(STATS_KEY)
          if (v && typeof v === 'object' && v.date === todayStr() && typeof v.count === 'number') {
            count = v.count
          }
        } catch {}
        todayCount = count
        $('today').textContent = String(todayCount)
      }
      async function incTodayCount() {
        todayCount += 1
        $('today').textContent = String(todayCount)
        try {
          await api.storage.set(STATS_KEY, { date: todayStr(), count: todayCount })
        } catch {}
      }

      // —— 计时状态机 ——
      // phase: 'focus' | 'break'；wall-clock 计时，interval 仅做采样渲染
      let phase = 'focus'
      let running = false
      let remainMs = 25 * 60 * 1000
      let endAt = 0 // running 时的目标时间戳
      let cycle = 1
      let todayCount = 0

      const RING_LEN = 2 * Math.PI * 52 // ≈ 326.7256

      function phaseMinutes() {
        return phase === 'focus' ? focusMin : breakMin
      }
      function phaseTotalMs() {
        return phaseMinutes() * 60 * 1000
      }

      function fmt(ms) {
        const s = Math.max(0, Math.ceil(ms / 1000))
        const m = Math.floor(s / 60)
        const r = s % 60
        return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0')
      }

      function render() {
        $('time').textContent = fmt(remainMs)
        $('phase').textContent = phase === 'focus' ? '专注' : '休息'
        $('cycle').textContent = '第 ' + cycle + ' 轮'
        const ring = $('ring')
        const total = phaseTotalMs()
        const ratio = total > 0 ? Math.min(1, Math.max(0, remainMs / total)) : 0
        ring.style.strokeDashoffset = String(RING_LEN * (1 - ratio))
        ring.classList.toggle('break', phase === 'break')

        const btn = $('btn-toggle')
        btn.querySelector('.btn-label').textContent = running ? '暂停' : '开始'
        btn.classList.toggle('running', running)
        btn.classList.toggle('break', phase === 'break') // 表现层：休息段配色（.running 优先接管幽灵态）
      }
      function renderIdle() {
        remainMs = phaseTotalMs()
        render()
      }

      let timer = null
      function tick() {
        remainMs = endAt - Date.now()
        if (remainMs <= 0) {
          remainMs = 0
          render()
          onPhaseDone()
          return
        }
        render()
      }
      function start() {
        if (running) return
        running = true
        endAt = Date.now() + remainMs
        clearInterval(timer)
        timer = setInterval(tick, 250) // 250ms 采样，对齐 wall-clock
        $('hint').textContent = ''
        render()
      }
      function pause() {
        if (!running) return
        remainMs = endAt - Date.now()
        if (remainMs < 0) remainMs = 0
        running = false
        clearInterval(timer)
        timer = null
        render()
      }
      function reset() {
        running = false
        clearInterval(timer)
        timer = null
        remainMs = phaseTotalMs()
        $('hint').textContent = ''
        render()
      }

      async function notifyPhase() {
        const isFocusDone = phase === 'focus' // 当前阶段即将结束的就是 phase
        const payload = isFocusDone
          ? { title: '番茄钟', body: '专注结束，休息一下 ☕' }
          : { title: '番茄钟', body: '休息结束，继续加油 🍅' }
        try {
          await api.notify(payload)
        } catch (e) {
          toast(isPerm(e) ? '缺少 notify 权限' : String(e.message || e), 'error')
        }
        toast(payload.body, 'info')
      }

      function nextPhase(autoStart) {
        if (phase === 'focus') {
          void incTodayCount()
          phase = 'break'
        } else {
          phase = 'focus'
          cycle += 1
        }
        remainMs = phaseTotalMs()
        running = false
        clearInterval(timer)
        timer = null
        render()
        if (autoStart) start()
      }

      async function onPhaseDone() {
        await notifyPhase()
        nextPhase(true) // 自动进入下一阶段并继续计时
      }

      // —— 控制 ——
      $('btn-toggle').onclick = () => (running ? pause() : start())
      $('btn-reset').onclick = reset
      $('btn-skip').onclick = () => {
        // 跳过本阶段：专注被跳过不计入统计
        nextPhase(running)
        $('hint').textContent = '已跳过本阶段'
      }

      // —— 设置输入（改后下次阶段生效） ——
      function clampInt(el, min, max, fallback) {
        let n = parseInt(el.value, 10)
        if (Number.isNaN(n)) n = fallback
        n = Math.min(max, Math.max(min, n))
        el.value = String(n)
        return n
      }
      $('focus-min').addEventListener('change', () => {
        focusMin = clampInt($('focus-min'), 5, 90, 25)
        saveSettings()
        // 若当前正处于专注阶段且未开始计时，则即时反映新时长
        if (phase === 'focus' && !running) renderIdle()
        else $('hint').textContent = '新时长将在下一阶段生效'
      })
      $('break-min').addEventListener('change', () => {
        breakMin = clampInt($('break-min'), 1, 30, 5)
        saveSettings()
        if (phase === 'break' && !running) renderIdle()
        else $('hint').textContent = '新时长将在下一阶段生效'
      })

      // onOut 不停表：后台继续计时（onEnter 回来时 wall-clock 已对齐）
      api?.onEnter?.(() => {
        if (running) tick()
      })
      api?.ui?.setTitle?.('番茄钟')

      loadSettings()
      loadTodayCount()
      renderIdle()
    
