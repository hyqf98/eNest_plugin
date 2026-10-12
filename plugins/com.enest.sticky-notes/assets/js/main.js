      const api = window.enest || window.zapi
      const $ = (id) => document.getElementById(id)

      const STORE_KEY = 'notes_v1'
      const COLORS = ['#f5a524', '#3ddc97', '#f87171', '#38bdf8', '#a78bfa']
      const COLOR_NAMES = { '#f5a524': '琥珀', '#3ddc97': '青绿', '#f87171': '玫瑰', '#38bdf8': '天蓝', '#a78bfa': '紫罗兰' }
      /** @type {Array<{id:string,text:string,color:string,pinned:boolean,createdAt:number,updatedAt:number}>} */
      let notes = []
      // 相对时间刷新定时器 / 删除确认句柄
      let timeTimer = null
      const pendingDelete = new Map() // id -> timeout

      const uid = () =>
        'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      const COLORS_INDEX = (c) => {
        const i = COLORS.indexOf(c)
        return i < 0 ? 0 : i
      }

      // —— 内联 SVG 图标（1.4px 描边，统一线宽） ——
      const ICONS = {
        pin: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 1.5 10.5 3.5 8 6l.8 2.6-3.2-1.9L2.4 10 4 6.8 2.1 3.6 4.7 4.4 7 1.9z"/></svg>',
        pinSmall: '<svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 1.5 10.5 3.5 8 6l.8 2.6-3.2-1.9L2.4 10 4 6.8 2.1 3.6 4.7 4.4 7 1.9z"/></svg>',
        trash: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 3h9M4.5 3V1.8a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8V3M2.5 3l.5 7a.8.8 0 0 0 .8.7h4.4a.8.8 0 0 0 .8-.7l.5-7M5 5.2v3.4M7 5.2v3.4"/></svg>'
      }
      const setBtnContent = (btn, icon, label) => {
        btn.textContent = ''
        if (icon) btn.insertAdjacentHTML('afterbegin', ICONS[icon])
        btn.appendChild(document.createTextNode(label))
      }

      // —— 换色提示浮层（body 级 fixed，避免被卡内 overflow 裁切） ——
      let colorTip = null
      let colorTipTimer = null
      function ensureColorTip() {
        if (colorTip) return colorTip
        colorTip = document.createElement('div')
        colorTip.className = 'color-tip'
        const swatch = document.createElement('span')
        swatch.className = 'swatch'
        const text = document.createElement('span')
        text.className = 'tip-text'
        colorTip.appendChild(swatch)
        colorTip.appendChild(text)
        colorTip.appendChild(document.createTextNode('换色'))
        document.body.appendChild(colorTip)
        return colorTip
      }
      function showColorTip(dot, note) {
        const tip = ensureColorTip()
        const next = COLORS[(COLORS_INDEX(note.color) + 1) % COLORS.length]
        tip.querySelector('.swatch').style.background = next
        tip.querySelector('.tip-text').textContent = COLOR_NAMES[next] || '换色'
        const r = dot.getBoundingClientRect()
        tip.classList.remove('show')
        // 先量尺寸再定位（去掉 show 前测量，避免 transition 抖动）
        requestAnimationFrame(() => {
          const tw = tip.offsetWidth || 72
          let x = r.left + r.width / 2 - tw / 2
          x = Math.max(6, Math.min(x, window.innerWidth - tw - 6))
          tip.style.left = x + 'px'
          tip.style.top = Math.max(6, r.bottom + 8) + 'px'
          requestAnimationFrame(() => tip.classList.add('show'))
        })
      }
      function hideColorTip() {
        if (!colorTip) return
        clearTimeout(colorTipTimer)
        colorTip.classList.remove('show')
      }

      const toast = async (message, type = 'info') => {
        try { await api?.ui?.toast?.({ message, type }) } catch {}
      }

      // —— 持久化 ——
      async function load() {
        try {
          const data = await api?.storage?.get?.(STORE_KEY)
          if (Array.isArray(data)) {
            notes = data
              .filter((n) => n && typeof n === 'object' && typeof n.id === 'string')
              .map((n) => ({
                id: n.id,
                text: typeof n.text === 'string' ? n.text : '',
                color: COLORS.includes(n.color) ? n.color : COLORS[0],
                pinned: !!n.pinned,
                createdAt: Number(n.createdAt) || Date.now(),
                updatedAt: Number(n.updatedAt) || Number(n.createdAt) || Date.now()
              }))
          }
        } catch (e) {
          console.warn('load notes failed:', e)
        }
      }
      async function persist() {
        try {
          await api?.storage?.set?.(STORE_KEY, notes)
        } catch (e) {
          toast('保存失败：' + String(e?.message || e), 'error')
        }
      }

      // —— 排序：置顶优先，其次 updatedAt 倒序 ——
      function sorted() {
        return [...notes].sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
          return b.updatedAt - a.updatedAt
        })
      }

      // —— 相对时间 ——
      function relTime(ts) {
        const now = Date.now()
        const diff = now - ts
        if (diff < 60 * 1000) return '刚刚'
        if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前'
        if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前'
        const d = new Date(ts)
        const today = new Date(now)
        const isYesterday =
          new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).toDateString() ===
          d.toDateString()
        if (isYesterday) return '昨天'
        const pad = (x) => String(x).padStart(2, '0')
        const sameYear = d.getFullYear() === today.getFullYear()
        return sameYear
          ? pad(d.getMonth() + 1) + '-' + pad(d.getDate())
          : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      }

      // —— 渲染 ——
      function render() {
        const grid = $('grid')
        grid.textContent = ''
        const list = sorted()
        $('count').textContent = notes.length + ' 条'
        $('app').classList.toggle('has-empty', notes.length === 0)
        const frag = document.createDocumentFragment()
        for (const n of list) frag.appendChild(renderCard(n))
        grid.appendChild(frag)
      }

      function autoSize(ta) {
        ta.style.height = 'auto'
        ta.style.height = ta.scrollHeight + 'px'
      }

      function renderCard(n) {
        const card = document.createElement('div')
        card.className = 'card' + (n.pinned ? ' pinned' : '')
        card.dataset.id = n.id
        card.style.setProperty('--note-color', n.color)

        // 顶行：色点（hover 提示换色）+ 置顶角标
        const top = document.createElement('div')
        top.className = 'card-top'
        const dot = document.createElement('span')
        dot.className = 'dot'
        dot.title = '切换颜色'
        dot.addEventListener('mouseenter', () => showColorTip(dot, n))
        dot.addEventListener('mouseleave', hideColorTip)
        dot.onclick = () => {
          hideColorTip()
          n.color = COLORS[(COLORS_INDEX(n.color) + 1) % COLORS.length]
          n.updatedAt = Date.now()
          void persist()
          render()
        }
        top.appendChild(dot)
        const spacer = document.createElement('span')
        spacer.className = 'top-spacer'
        top.appendChild(spacer)
        if (n.pinned) {
          const flag = document.createElement('span')
          flag.className = 'pin-flag'
          flag.title = '已置顶'
          flag.insertAdjacentHTML('afterbegin', ICONS.pinSmall)
          flag.appendChild(document.createTextNode('置顶'))
          top.appendChild(flag)
        }
        card.appendChild(top)

        // 内容区
        const area = document.createElement('div')
        area.className = 'note-area'
        const ta = document.createElement('textarea')
        ta.placeholder = '随手记点什么…'
        ta.value = n.text
        ta.spellcheck = false
        let deb = null
        ta.addEventListener('input', () => {
          autoSize(ta)
          clearTimeout(deb)
          deb = setTimeout(() => {
            n.text = ta.value
            n.updatedAt = Date.now()
            void persist()
            // 同步本卡时间标签为「刚刚」
            const cardEl = ta.closest('.card')
            const timeEl = cardEl && cardEl.querySelector('.time')
            if (timeEl) {
              timeEl.dataset.ts = String(n.updatedAt)
              timeEl.textContent = relTime(n.updatedAt)
            }
          }, 500)
        })
        area.appendChild(ta)
        card.appendChild(area)
        requestAnimationFrame(() => autoSize(ta))

        // 底部操作行
        const foot = document.createElement('div')
        foot.className = 'card-foot'
        const pinBtn = document.createElement('button')
        pinBtn.className = 'act' + (n.pinned ? ' pin-on' : '')
        setBtnContent(pinBtn, 'pin', n.pinned ? '取消置顶' : '置顶')
        pinBtn.onclick = () => {
          n.pinned = !n.pinned
          n.updatedAt = Date.now()
          void persist()
          render()
        }
        const delBtn = document.createElement('button')
        delBtn.className = 'act del'
        setBtnContent(delBtn, 'trash', '删除')
        delBtn.onclick = () => {
          if (delBtn.classList.contains('del-confirm')) {
            clearTimeout(pendingDelete.get(n.id))
            pendingDelete.delete(n.id)
            notes = notes.filter((x) => x.id !== n.id)
            void persist()
            render()
          } else {
            delBtn.classList.add('del-confirm')
            setBtnContent(delBtn, 'trash', '再点确认')
            clearTimeout(pendingDelete.get(n.id))
            pendingDelete.set(
              n.id,
              setTimeout(() => {
                pendingDelete.delete(n.id)
                const still = document.querySelector('.card[data-id="' + n.id + '"] .act.del')
                if (still && still.classList.contains('del-confirm')) {
                  still.classList.remove('del-confirm')
                  setBtnContent(still, 'trash', '删除')
                }
              }, 2500)
            )
          }
        }
        const time = document.createElement('span')
        time.className = 'time'
        time.dataset.ts = String(n.updatedAt)
        time.textContent = relTime(n.updatedAt)
        foot.appendChild(pinBtn)
        foot.appendChild(delBtn)
        foot.appendChild(time)
        card.appendChild(foot)
        return card
      }

      function refreshTimeLabels() {
        document.querySelectorAll('.time[data-ts]').forEach((el) => {
          el.textContent = relTime(Number(el.dataset.ts))
        })
      }

      // —— 新建 ——
      function createNote(text = '') {
        const now = Date.now()
        const n = {
          id: uid(),
          text,
          color: COLORS[notes.length % COLORS.length],
          pinned: false,
          createdAt: now,
          updatedAt: now
        }
        notes.push(n)
        void persist()
        render()
        // 聚焦新卡
        const ta = document.querySelector('.card[data-id="' + n.id + '"] textarea')
        if (ta) ta.focus()
        return n
      }

      $('btn-new').onclick = () => createNote('')

      // —— 生命周期 ——
      api?.onEnter?.(({ code, payload }) => {
        if (code && code !== 'main') return
        // payload 带 type:'text' 的选中文本 → 预填一条新便签草稿
        if (payload && typeof payload === 'object' && payload.type === 'text' &&
            typeof payload.text === 'string' && payload.text.trim()) {
          if (!notes.some((n) => n.text === payload.text)) {
            const draft = createNote(payload.text)
            const ta = document.querySelector('.card[data-id="' + draft.id + '"] textarea')
            if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length) }
          }
        }
      })

      api?.ui?.setTitle?.('备忘录')

      // 相对时间每分钟刷新
      timeTimer = setInterval(refreshTimeLabels, 60 * 1000)
