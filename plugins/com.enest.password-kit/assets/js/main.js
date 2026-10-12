      const api = window.enest || window.zapi
      const $ = (id) => document.getElementById(id)

      const toast = async (message, type = 'info') => {
        try { await api?.ui?.toast?.({ message, type }) } catch {}
      }
      const isPerm = (err) => String(err?.message || err).includes('permission denied')

      async function copyText(text, okMsg) {
        try {
          await api.clipboard.writeText(text)
          toast(okMsg || '已复制', 'success')
        } catch (e) {
          toast(isPerm(e) ? '缺少 clipboard.write 权限' : String(e.message || e), 'error')
        }
      }

      // —— 复制成功视觉反馈：目标元素加 .copied，800ms 后自动还原 ——
      const copiedTimers = new WeakMap()
      function flashCopied(el) {
        if (!el) return
        el.classList.add('copied')
        clearTimeout(copiedTimers.get(el))
        copiedTimers.set(el, setTimeout(() => el.classList.remove('copied'), 800))
      }
      // 行/按钮内联的复制图标对（copy ⇄ check）
      function copyIcons() {
        const wrap = document.createElement('span')
        wrap.className = 'row-ic'
        wrap.innerHTML =
          '<svg class="ic-copy" width="12" height="12"><use href="#ic-copy-def" /></svg>' +
          '<svg class="ic-check" width="12" height="12"><use href="#ic-check-def" /></svg>'
        return wrap
      }

      // —— 页签切换 ——
      function switchTab(name) {
        const isPw = name === 'pw'
        $('tab-pw').classList.toggle('active', isPw)
        $('tab-uuid').classList.toggle('active', !isPw)
        $('tab-pw').setAttribute('aria-selected', String(isPw))
        $('tab-uuid').setAttribute('aria-selected', String(!isPw))
        $('page-pw').classList.toggle('active', isPw)
        $('page-uuid').classList.toggle('active', !isPw)
      }
      $('tab-pw').onclick = () => switchTab('pw')
      $('tab-uuid').onclick = () => switchTab('uuid')

      // —— 自绘滑杆填充：--fill 驱动轨道已过段比例 ——
      function paintRange() {
        const el = $('len')
        const pct = ((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100
        el.style.setProperty('--fill', pct.toFixed(1) + '%')
      }

      // —— 随机原语：rejection sampling 拒绝取模偏差 ——
      function randBelow(n) {
        // 返回 [0, n) 内均匀随机整数；拒绝采样消除 mod 偏差
        const limit = Math.floor(256 / n) * n // 256 内能被 n 整除的最大值
        const buf = new Uint8Array(1)
        for (;;) {
          crypto.getRandomValues(buf)
          if (buf[0] < limit) return buf[0] % n
        }
      }

      const SETS = {
        lower: 'abcdefghijklmnopqrstuvwxyz',
        upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        digit: '0123456789',
        symbol: '!@#$%^&*_-+=?'
      }

      function activeSets() {
        return Object.keys(SETS).filter((k) => $('set-' + k).checked)
      }

      // —— 强度：按长度 + 字符种类的简单规则 ——
      function strengthOf(len, kinds) {
        if (len < 8 || kinds <= 1) return 1
        if (len < 12) return kinds >= 3 ? 2 : 1
        if (len < 16) return kinds >= 3 ? 3 : 2
        return kinds >= 3 ? 4 : 3
      }
      const STRENGTH_NAMES = ['弱', '中', '强', '极强']

      function renderStrength(len, kinds) {
        const s = strengthOf(len, kinds)
        for (let i = 0; i < 4; i++) {
          const seg = $('seg-' + i)
          // 已点亮的段半透明铺底，最末端（当前档位）全亮
          seg.className = i < s ? 'on s' + s + (i === s - 1 ? ' last' : '') : ''
        }
        $('strength-label').textContent = '强度：' + STRENGTH_NAMES[s - 1]
        // 熵估计：len * log2(poolSize)
        const pool = activeSets().reduce((acc, k) => acc + SETS[k].length, 0) || 1
        $('entropy').textContent = '≈ ' + Math.round(len * Math.log2(pool)) + ' bits'
      }

      // —— 密码生成 ——
      let currentPw = ''
      function generatePw() {
        const keys = activeSets()
        if (keys.length === 0) return
        const len = Number($('len').value)
        // 先保证每类至少 1 个字符（保证种类覆盖），再完全随机填充
        const pool = keys.map((k) => SETS[k])
        const chars = []
        for (const set of pool) chars.push(set[randBelow(set.length)])
        const all = pool.join('')
        while (chars.length < len) chars.push(all[randBelow(all.length)])
        // Fisher–Yates 洗牌（同样用 rejection sampling）
        for (let i = chars.length - 1; i > 0; i--) {
          const j = randBelow(i + 1)
          ;[chars[i], chars[j]] = [chars[j], chars[i]]
        }
        currentPw = chars.join('')
        const out = $('pw-out')
        out.textContent = currentPw
        out.classList.remove('placeholder')
        $('btn-copy-pw').disabled = false
        pushHistory(currentPw)
        renderStrength(len, keys.length)
      }

      // —— 会话历史（最近 8 条） ——
      let history = []
      function pushHistory(pw) {
        history.unshift(pw)
        if (history.length > 8) history.length = 8
        renderHistory()
      }
      function renderHistory() {
        const list = $('hist-list')
        list.textContent = ''
        $('hist-count').textContent = history.length ? history.length + '/8' : ''
        if (history.length === 0) {
          const d = document.createElement('div')
          d.className = 'empty'
          d.textContent = '暂无记录'
          list.appendChild(d)
          return
        }
        history.forEach((pw, i) => {
          const item = document.createElement('div')
          item.className = 'hist-item'
          item.title = '点击复制'
          item.tabIndex = 0
          const k = document.createElement('span')
          k.className = 'k'
          k.textContent = '#' + (history.length - i)
          const v = document.createElement('span')
          v.className = 'v'
          v.textContent = pw
          item.append(k, v, copyIcons())
          const doCopy = () => {
            copyText(pw, '已复制历史 #' + (history.length - i))
            flashCopied(item)
          }
          item.onclick = doCopy
          item.onkeydown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              doCopy()
            }
          }
          list.appendChild(item)
        })
      }
      $('btn-clear-hist').onclick = () => {
        history = []
        renderHistory()
      }

      // —— UUID v4 ——
      function uuidV4() {
        // 16 随机字节；version=4（高 nibble of byte[6]），variant=10xx（byte[8]）
        const b = new Uint8Array(16)
        crypto.getRandomValues(b)
        b[6] = (b[6] & 0x0f) | 0x40
        b[8] = (b[8] & 0x3f) | 0x80
        const h = [...b].map((x) => x.toString(16).padStart(2, '0'))
        return (
          h.slice(0, 4).join('') +
          '-' +
          h.slice(4, 6).join('') +
          '-' +
          h.slice(6, 8).join('') +
          '-' +
          h.slice(8, 10).join('') +
          '-' +
          h.slice(10, 16).join('')
        )
      }

      let uuids = []
      function renderUuids() {
        const list = $('uuid-list')
        list.textContent = ''
        if (uuids.length === 0) {
          const d = document.createElement('div')
          d.className = 'empty'
          d.textContent = '点击「生成」产生 UUID v4'
          list.appendChild(d)
          return
        }
        uuids.forEach((u, i) => {
          const item = document.createElement('div')
          item.className = 'uuid-item'
          item.title = '点击复制'
          item.tabIndex = 0
          const k = document.createElement('span')
          k.className = 'k'
          k.textContent = String(i + 1).padStart(2, '0')
          const v = document.createElement('span')
          v.className = 'v'
          v.textContent = u
          item.append(k, v, copyIcons())
          const doCopy = () => {
            copyText(u, '已复制 UUID ' + (i + 1))
            flashCopied(item)
          }
          item.onclick = doCopy
          item.onkeydown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              doCopy()
            }
          }
          list.appendChild(item)
        })
      }

      function clampInt(el, min, max, fallback) {
        let n = parseInt(el.value, 10)
        if (Number.isNaN(n)) n = fallback
        n = Math.min(max, Math.max(min, n))
        el.value = String(n)
        return n
      }

      // —— 事件 ——
      $('len').addEventListener('input', () => {
        $('len-val').textContent = $('len').value
        paintRange()
        renderStrength(Number($('len').value), activeSets().length)
      })
      for (const k of Object.keys(SETS)) {
        $('set-' + k).addEventListener('change', () => {
          const keys = activeSets()
          const none = keys.length === 0
          $('set-warn').textContent = none ? '至少勾选一项' : ''
          $('btn-gen').disabled = none
          renderStrength(Number($('len').value), keys.length)
        })
      }
      $('btn-gen').onclick = generatePw
      $('btn-copy-pw').onclick = () => {
        if (!currentPw) return
        copyText(currentPw, '已复制密码')
        flashCopied($('btn-copy-pw'))
      }

      $('btn-uuid-gen').onclick = () => {
        const n = clampInt($('uuid-count'), 1, 100, 1)
        uuids = Array.from({ length: n }, uuidV4)
        renderUuids()
        $('btn-uuid-copy-all').disabled = uuids.length === 0
      }
      $('uuid-count').addEventListener('change', () => clampInt($('uuid-count'), 1, 100, 1))
      $('btn-uuid-copy-all').onclick = () => {
        if (!uuids.length) return
        copyText(uuids.join('\n'), '已复制 ' + uuids.length + ' 条 UUID')
        flashCopied($('btn-uuid-copy-all'))
      }

      api?.onEnter?.(() => {
        // 重新进入：恢复可交互状态
      })
      api?.ui?.setTitle?.('密码工具箱')
      paintRange()
      renderStrength(16, 4)
      renderHistory()
      renderUuids()

