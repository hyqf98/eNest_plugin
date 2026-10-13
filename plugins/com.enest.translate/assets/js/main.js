      const api = window.enest || window.zapi
      const $ = (id) => document.getElementById(id)
      let lastResult = ''
      let lastDetected = '' // 最近一次（当前输入）Google 检出的源语言
      let debounceTimer = null

      const ENGINE_NAMES = { google: 'Google', mymemory: 'MyMemory' }
      const MM_LANGS = new Set(['zh-CN', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'])
      const hasOption = (sel, v) => Array.from($(sel).options).some((o) => o.value === v)

      const toast = async (message, type = 'info') => {
        try { await api?.ui?.toast?.({ message, type }) } catch {}
      }
      const isPerm = (err) => String(err?.message || err).includes('permission denied')

      // —— UI 状态钩子（仅切 class / 文案，不碰功能逻辑） ——

      /** 有无译文：控制复制钮可用态 */
      function syncCopyState() {
        $('btn-copy').toggleAttribute('disabled', !lastResult)
      }
      /** 翻译中呼吸态：开启时正文替换为轻量占位文案，结束时恢复 */
      function setLoading(on) {
        const out = $('output')
        if (on) {
          if (!out.classList.contains('loading')) out.textContent = '翻译中…'
          out.classList.add('loading')
        } else {
          out.classList.remove('loading')
        }
      }
      /** 复制成功反馈：图标短暂变 ✓（1.4s） */
      let copyFeedbackTimer = null
      function flashCopyDone() {
        const btn = $('btn-copy')
        const icCopy = btn.querySelector('.ic-copy')
        const icCheck = btn.querySelector('.ic-check')
        if (!icCopy || !icCheck) return
        clearTimeout(copyFeedbackTimer)
        icCopy.style.display = 'none'
        icCheck.style.display = ''
        btn.classList.add('done')
        copyFeedbackTimer = setTimeout(() => {
          icCopy.style.display = ''
          icCheck.style.display = 'none'
          btn.classList.remove('done')
        }, 1400)
      }

      // —— Quick 内嵌高度自适应：上报内容实际高度（壳子 ui.resize 语义：仅 Quick 生效，主窗仅记录） ——

      let heightTimer = null
      function reportHeight() {
        const h = Math.ceil(document.documentElement.scrollHeight)
        if (!(h > 0) || !api?.ui) return
        try {
          const p = api.ui.resize
            ? api.ui.resize({ height: Math.min(h, 640) })
            : api.ui.setHeight
              ? api.ui.setHeight(Math.min(h, 640))
              : null
          if (p && typeof p.catch === 'function') p.catch(() => {})
        } catch { /* 无 ui.resize 权限 / API 不可用时静默 */ }
      }
      function scheduleHeightReport() {
        clearTimeout(heightTimer)
        heightTimer = setTimeout(reportHeight, 80)
      }
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(scheduleHeightReport).observe(document.body)
      } else if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(scheduleHeightReport).observe($('output'), { childList: true, subtree: true, characterData: true })
      }
      window.addEventListener('beforeunload', () => clearTimeout(heightTimer))

      // —— 偏好持久化：api.storage KV（storage.local 权限）。
      //    壳侧 settings.get/set 仅限注册过的设置项（contributes.settings /
      //    enest.settings.register），本插件未注册任何 section，故不走 settings 通道。
      async function loadPrefs() {
        try {
          const [src, tgt, engine] = await Promise.all([
            api.storage.get('srcLang'),
            api.storage.get('tgtLang'),
            api.storage.get('engine')
          ])
          if (src) $('src').value = src
          if (tgt) $('tgt').value = tgt
          if (engine === 'google' || engine === 'mymemory' || engine === 'auto') $('engine').value = engine
        } catch {}
      }
      async function savePrefs() {
        try {
          await api.storage.set('srcLang', $('src').value)
          await api.storage.set('tgtLang', $('tgt').value)
        } catch {}
      }
      async function saveEngine() {
        try { await api.storage.set('engine', $('engine').value) } catch {}
      }

      // —— 引擎层 ——

      function parseGoogle(raw) {
        // translate_a/single → [[["译文","原文",null,null,10]],null,"en",...]
        let data
        try {
          data = JSON.parse(raw)
        } catch {
          throw new Error('翻译响应解析失败')
        }
        if (!Array.isArray(data) || !Array.isArray(data[0])) {
          throw new Error('翻译响应格式异常')
        }
        const text = data[0]
          .filter((seg) => Array.isArray(seg) && typeof seg[0] === 'string')
          .map((seg) => seg[0])
          .join('')
        const detected = typeof data[2] === 'string' ? data[2] : ''
        return { text, detected }
      }

      // Google gtx：src 可为 'auto'，顺带返回检测语言 data[2]
      async function translateViaGoogle(q, src, tgt) {
        if (!api?.net?.fetch) throw new Error('eNest API 不可用')
        const url =
          'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' +
          encodeURIComponent(src) +
          '&tl=' +
          encodeURIComponent(tgt) +
          '&dt=t&q=' +
          encodeURIComponent(q)
        const res = await api.net.fetch({ url, method: 'GET', timeoutMs: 8000 })
        if (res.status >= 400) throw new Error('Google HTTP ' + res.status)
        return parseGoogle(res.body)
      }

      // MyMemory：langpair 需要具体短码（zh-CN/en/ja/...），不支持 auto
      function mmLang(code) {
        return MM_LANGS.has(code) ? code : ''
      }
      async function translateViaMyMemory(q, src, tgt) {
        if (!api?.net?.fetch) throw new Error('eNest API 不可用')
        const s = mmLang(src)
        const t = mmLang(tgt)
        if (!s) throw new Error('MyMemory 不支持自动检测，请手动选择源语言')
        if (!t) throw new Error('MyMemory 不支持目标语言 ' + tgt)
        const url =
          'https://api.mymemory.translated.net/get?q=' +
          encodeURIComponent(q) +
          '&langpair=' +
          encodeURIComponent(s + '|' + t)
        const res = await api.net.fetch({ url, method: 'GET', timeoutMs: 8000 })
        if (res.status !== 200) throw new Error('MyMemory HTTP ' + res.status)
        let data
        try {
          data = JSON.parse(res.body)
        } catch {
          throw new Error('MyMemory 响应解析失败')
        }
        const text = data?.responseData?.translatedText
        if (typeof text !== 'string' || !text) throw new Error('MyMemory 响应格式异常')
        if (/^(MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID )/i.test(text)) {
          throw new Error('MyMemory：' + text)
        }
        return { text, detected: '' }
      }

      // —— 调度：返回 { text, detected, usedSrc, engine } ——
      async function translateWithEngines(q, src, tgt) {
        const pref = $('engine').value || 'auto'

        if (pref === 'google' || pref === 'mymemory') {
          // 锁定引擎：失败直接抛出，由 run() toast 并提示可切换引擎重试
          const r =
            pref === 'google'
              ? await translateViaGoogle(q, src, tgt)
              : await translateViaMyMemory(q, src, tgt)
          return { ...r, usedSrc: src, engine: pref }
        }

        // auto：Google 优先（src='auto' 时顺带拿 detected）
        try {
          const r = await translateViaGoogle(q, src, tgt)
          if (r.detected) lastDetected = r.detected
          return { ...r, usedSrc: src, engine: 'google' }
        } catch (e) {
          if (isPerm(e)) throw e // 权限问题换引擎也没用
          let mmSrc = src !== 'auto' ? src : lastDetected || ''
          if (src === 'auto' && !mmSrc) {
            // 检测不可用：提示手动选源语言，仍按目标方向合理猜测尝试一次
            toast('自动检测不可用，请手动选择源语言', 'warn')
            mmSrc = tgt === 'zh-CN' ? 'en' : 'zh-CN'
          }
          try {
            const r = await translateViaMyMemory(q, mmSrc, tgt)
            return { ...r, usedSrc: mmSrc, engine: 'mymemory' }
          } catch (e2) {
            throw new Error('Google / MyMemory 均失败：' + String(e2?.message || e2))
          }
        }
      }

      const msg = (e) => String(e?.message || e)

      async function run() {
        const text = $('input').value.trim()
        if (!text) {
          lastResult = ''
          setLoading(false)
          $('output').textContent = '译文将显示在这里'
          $('output').classList.add('placeholder')
          $('engine-tag').textContent = ''
          $('detected').textContent = ''
          $('meta').textContent = ''
          syncCopyState()
          return
        }
        setLoading(true)
        $('output').classList.add('placeholder')
        $('engine-tag').textContent = ''
        try {
          const src = $('src').value || 'auto'
          const tgt = $('tgt').value || 'zh-CN'
          const result = await translateWithEngines(text, src, tgt)
          lastResult = result.text
          $('output').textContent = result.text || '（空译文）'
          $('engine-tag').textContent = ENGINE_NAMES[result.engine] || ''
          $('detected').textContent = result.detected
            ? '检测到 ' + result.detected + ' → ' + tgt
            : result.usedSrc && result.usedSrc !== 'auto'
              ? result.usedSrc + ' → ' + tgt
              : ''
          $('meta').textContent = text.length + ' 字符'
        } catch (e) {
          lastResult = ''
          setLoading(false)
          $('output').classList.add('placeholder')
          $('engine-tag').textContent = ''
          if (isPerm(e)) {
            $('output').textContent = '翻译失败：' + msg(e)
            toast('缺少 net.fetch 权限', 'error')
          } else if ($('engine').value !== 'auto') {
            // 锁定引擎失败：toast 错误 + 提示可切换引擎重试
            $('output').textContent = '翻译失败：' + msg(e) + '\n可切换引擎重试'
            toast(msg(e), 'error')
          } else {
            $('output').textContent = '翻译失败：' + msg(e)
            toast(msg(e), 'error')
          }
        }
        setLoading(false)
        syncCopyState()
      }

      $('input').addEventListener('input', () => {
        lastDetected = '' // 输入已变化，旧检测结果作废
        clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => void run(), 500)
      })
      // Enter 立即翻译 / Shift+Enter 换行
      $('input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          clearTimeout(debounceTimer)
          void run()
        }
      })
      $('btn-run').onclick = () => void run()
      $('btn-clear').onclick = () => {
        $('input').value = ''
        $('input').focus()
        void run()
      }
      $('src').onchange = () => { savePrefs(); void run() }
      $('tgt').onchange = () => { savePrefs(); void run() }
      $('engine').onchange = () => { saveEngine(); void run() }
      $('swap').onclick = () => {
        const s = $('src').value
        const t = $('tgt').value
        if (s === 'auto') {
          // 修复 v1.0 自赋值无效 bug：检测出语言 → 填入源下拉再交换；未检测 → 提示并中止
          if (lastDetected && hasOption('src', lastDetected) && hasOption('tgt', lastDetected)) {
            $('src').value = lastDetected
            const detected = $('src').value
            $('src').value = t
            $('tgt').value = detected
          } else {
            toast('自动检测时需先翻译一次', 'warn')
            return
          }
        } else {
          $('src').value = t
          $('tgt').value = s
        }
        savePrefs()
        void run()
      }
      $('btn-paste').onclick = async () => {
        try {
          const text = await api.clipboard.readText()
          $('input').value = text || ''
          void run()
        } catch (e) {
          toast(isPerm(e) ? '缺少 clipboard.read 权限' : String(e.message || e), 'error')
        }
      }
      $('btn-copy').onclick = async () => {
        if (!lastResult) return
        try {
          await api.clipboard.writeText(lastResult)
          flashCopyDone()
        } catch (e) {
          toast(isPerm(e) ? '缺少 clipboard.write 权限' : String(e.message || e), 'error')
        }
      }

      api?.onEnter?.(({ payload }) => {
        if (typeof payload === 'string' && payload) {
          $('input').value = payload
          void run()
        }
      })
      api?.ui?.setTitle?.('翻译')
      loadPrefs()
      syncCopyState()
      $('input').focus()
      scheduleHeightReport()
    
