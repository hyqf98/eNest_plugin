      const api = window.enest || window.zapi
      const $ = (id) => document.getElementById(id)

      const PALETTE_KEY = 'colors_v1'
      const PALETTE_MAX = 24
      const MAG_CELLS = 11 // 放大镜 11×11
      const MAG_CELL_PX = 11 // 每格像素

      let shotCanvas = null // 截图像素源（原始分辨率）
      let shotW = 0
      let shotH = 0
      let picking = false
      let hoverColor = null // 当前悬停色 {r,g,b}
      let current = { r: 255, g: 255, b: 255 }
      let palette = []

      const toast = async (message, type = 'info') => {
        try { await api?.ui?.toast?.({ message, type }) } catch {}
      }
      const isPerm = (err) => String(err?.message || err).includes('permission denied')
      const failToast = (e, permName) =>
        toast(isPerm(e) ? '缺少 ' + permName + ' 权限' : String(e?.message || e), 'error')
      const status = (t) => { $('status').textContent = t }
      const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)))

      // —— 颜色换算（功能逻辑不变）——
      function toHex({ r, g, b }) {
        return '#' + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('').toUpperCase()
      }
      function toRgbStr(c) {
        return 'rgb(' + clamp255(c.r) + ', ' + clamp255(c.g) + ', ' + clamp255(c.b) + ')'
      }
      function toHsl({ r, g, b }) {
        const rr = clamp255(r) / 255
        const gg = clamp255(g) / 255
        const bb = clamp255(b) / 255
        const max = Math.max(rr, gg, bb)
        const min = Math.min(rr, gg, bb)
        const l = (max + min) / 2
        let h = 0
        let s = 0
        if (max !== min) {
          const d = max - min
          s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
          if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6
          else if (max === gg) h = ((bb - rr) / d + 2) / 6
          else h = ((rr - gg) / d + 4) / 6
        }
        return 'hsl(' + Math.round(h * 360) + ', ' + Math.round(s * 100) + '%, ' + Math.round(l * 100) + '%)'
      }
      function parseHex(str) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(str || '').trim())
        if (!m) return null
        const n = parseInt(m[1], 16)
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
      }

      // —— 主显示 ——
      function renderCurrent() {
        const hex = toHex(current)
        $('big-swatch').style.background = hex
        $('v-hex').textContent = hex
        $('v-rgb').textContent = toRgbStr(current)
        $('v-hsl').textContent = toHsl(current)
        $('m-rgb').textContent = toRgbStr(current)
        $('m-hsl').textContent = toHsl(current)
        $('hex-input').value = hex
        $('hex-error').hidden = true
        markCurrentCell()
      }

      // 复制成功 ✓：800ms 后回弹
      function flashCopied(btn) {
        btn.classList.add('copied')
        clearTimeout(btn._t)
        btn._t = setTimeout(() => btn.classList.remove('copied'), 800)
      }

      async function copyText(text, label) {
        try {
          await api.clipboard.writeText(text)
          toast('已复制 ' + (label || text), 'success')
        } catch (e) {
          failToast(e, 'clipboard.write')
        }
      }

      document.querySelectorAll('[data-copy]').forEach((btn) => {
        btn.onclick = () => {
          const kind = btn.dataset.copy
          const text = kind === 'hex' ? toHex(current) : kind === 'rgb' ? toRgbStr(current) : toHsl(current)
          void copyText(text, kind.toUpperCase())
          flashCopied(btn)
        }
      })

      // —— 手动输入（换算逻辑不变，补充行内错误提示）——
      $('hex-input').addEventListener('input', () => {
        const input = $('hex-input')
        const v = input.value.trim()
        const c = parseHex(v)
        input.classList.toggle('invalid', !c && v !== '')
        $('hex-error').hidden = !!c || v === ''
        if (c) {
          current = c
          renderCurrent()
        } else {
          $('m-rgb').textContent = toRgbStr(current)
          $('m-hsl').textContent = toHsl(current)
        }
      })
      $('hex-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void copyText(toHex(current), 'HEX')
      })

      // —— 取色流程（capture 逻辑不变）——
      async function startPick() {
        if (!api?.screen) {
          toast('eNest API 不可用', 'error')
          return
        }
        try {
          status('正在截屏…')
          const shot = await api.screen.capture()
          shotW = shot.width
          shotH = shot.height
          const img = new Image()
          img.onload = () => {
            const canvas = document.createElement('canvas')
            canvas.width = shotW
            canvas.height = shotH
            const ctx = canvas.getContext('2d', { willReadFrequently: true })
            ctx.drawImage(img, 0, 0)
            shotCanvas = canvas
            picking = true
            document.body.classList.add('picking')
            $('btn-stop').hidden = false
            $('picker-wrap').classList.add('active')
            $('shot-img').src = shot.dataUrl
            status(shotW + '×' + shotH + ' · 移动鼠标取点，点击确认')
          }
          img.onerror = () => {
            status('截图加载失败')
            toast('截图加载失败', 'error')
          }
          img.src = shot.dataUrl
        } catch (e) {
          status('截屏失败')
          failToast(e, 'screen.capture')
        }
      }

      function stopPick() {
        picking = false
        shotCanvas = null
        hoverColor = null
        document.body.classList.remove('picking')
        $('btn-stop').hidden = true
        $('picker-wrap').classList.remove('active')
        $('cursor-badge').hidden = true
        $('btn-confirm').disabled = true
        status('就绪')
      }

      $('btn-start').onclick = () => void startPick()
      $('btn-stop').onclick = stopPick

      // —— 确认取色 ——
      function commitPick() {
        if (!picking || !hoverColor) return
        current = hoverColor
        renderCurrent()
        void pushPalette(current)
        toast('已取色 ' + toHex(current), 'success')
      }
      $('btn-confirm').onclick = commitPick

      // —— 放大镜（取样逻辑不变；绘制精致化）——
      function samplePixel(x, y) {
        if (!shotCanvas) return null
        if (x < 0 || y < 0 || x >= shotW || y >= shotH) return null
        const ctx = shotCanvas.getContext('2d', { willReadFrequently: true })
        const d = ctx.getImageData(x, y, 1, 1).data
        return { r: d[0], g: d[1], b: d[2] }
      }

      function drawMagnifier(cx, cy) {
        const canvas = $('magnifier')
        const ctx = canvas.getContext('2d')
        const size = MAG_CELLS * MAG_CELL_PX
        ctx.fillStyle = '#101316'
        ctx.fillRect(0, 0, size, size)
        const half = Math.floor(MAG_CELLS / 2)
        for (let row = 0; row < MAG_CELLS; row++) {
          for (let col = 0; col < MAG_CELLS; col++) {
            const c = samplePixel(cx - half + col, cy - half + row)
            if (!c) continue
            ctx.fillStyle = 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')'
            ctx.fillRect(col * MAG_CELL_PX, row * MAG_CELL_PX, MAG_CELL_PX, MAG_CELL_PX)
          }
        }
        // 网格描边：低调 1px 织线，压在像素之上、十字之下
        ctx.strokeStyle = 'rgba(16, 19, 22, 0.38)'
        ctx.lineWidth = 1
        ctx.beginPath()
        for (let i = 1; i < MAG_CELLS; i++) {
          const p = i * MAG_CELL_PX + 0.5
          ctx.moveTo(p, 0)
          ctx.lineTo(p, size)
          ctx.moveTo(0, p)
          ctx.lineTo(size, p)
        }
        ctx.stroke()
        // 中心格高亮：外层亮环 + 内层暗环，构成焦点十字
        const c0 = (size / 2) | 0
        const cell = MAG_CELL_PX
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
        ctx.lineWidth = 1.5
        ctx.strokeRect(c0 - cell / 2 + 0.5, c0 - cell / 2 + 0.5, cell - 1, cell - 1)
        ctx.strokeStyle = 'rgba(16, 19, 22, 0.6)'
        ctx.lineWidth = 1
        ctx.strokeRect(c0 - cell / 2 - 1.5, c0 - cell / 2 - 1.5, cell + 2, cell + 2)
        // 十字准线延伸（止于中心格外沿，不压中心色）
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(c0 + 0.5, 0)
        ctx.lineTo(c0 + 0.5, c0 - cell / 2 - 2)
        ctx.moveTo(c0 + 0.5, size)
        ctx.lineTo(c0 + 0.5, c0 + cell / 2 + 2)
        ctx.moveTo(0, c0 + 0.5)
        ctx.lineTo(c0 - cell / 2 - 2, c0 + 0.5)
        ctx.moveTo(size, c0 + 0.5)
        ctx.lineTo(c0 + cell / 2 + 2, c0 + 0.5)
        ctx.stroke()
      }

      const view = $('shot-view')
      const badge = $('cursor-badge')
      const BADGE_PAD = 12

      function placeBadge(px, py, rect) {
        const w = badge.offsetWidth
        const h = badge.offsetHeight
        let x = px + BADGE_PAD
        let y = py - h - BADGE_PAD
        if (x + w > rect.width - 4) x = px - w - BADGE_PAD
        if (y < 4) y = py + BADGE_PAD
        badge.style.transform =
          'translate(' + Math.round(x) + 'px, ' + Math.round(y) + 'px)'
      }

      view.addEventListener('mousemove', (e) => {
        if (!picking || !shotCanvas) return
        const rect = view.getBoundingClientRect()
        // 视口坐标 → 显示坐标（object-fit: contain 居中）
        const scale = Math.min(rect.width / shotW, rect.height / shotH)
        const dispW = shotW * scale
        const dispH = shotH * scale
        const offX = (rect.width - dispW) / 2
        const offY = (rect.height - dispH) / 2
        const x = Math.floor((e.clientX - rect.left - offX) / scale)
        const y = Math.floor((e.clientY - rect.top - offY) / scale)
        if (x < 0 || y < 0 || x >= shotW || y >= shotH) {
          badge.hidden = true
          return
        }
        hoverColor = samplePixel(x, y)
        if (!hoverColor) return
        drawMagnifier(x, y)
        const hex = toHex(hoverColor)
        $('mag-swatch').style.background = hex
        $('mag-hex').textContent = hex
        $('mag-rgb').textContent =
          clamp255(hoverColor.r) + ', ' + clamp255(hoverColor.g) + ', ' + clamp255(hoverColor.b)
        $('btn-confirm').disabled = false
        // HEX 浮标跟随
        $('cursor-chip').style.background = hex
        $('cursor-hex').textContent = hex
        badge.hidden = false
        placeBadge(e.clientX - rect.left, e.clientY - rect.top, rect)
      })

      view.addEventListener('mouseleave', () => {
        if (!picking) return
        badge.hidden = true
        $('mag-hex').textContent = '#------'
        $('mag-rgb').textContent = '移入截图取点'
        $('btn-confirm').disabled = true
      })

      view.addEventListener('click', () => {
        if (!picking || !hoverColor) return
        commitPick()
      })

      // —— 历史色板（存取逻辑不变；当前色描边高亮）——
      function markCurrentCell() {
        const hex = toHex(current)
        $('palette').querySelectorAll('.cell').forEach((el) => {
          el.classList.toggle('current', el.dataset.hex === hex)
        })
      }

      async function loadPalette() {
        try {
          const raw = await api?.storage?.get?.(PALETTE_KEY)
          if (Array.isArray(raw)) {
            palette = raw
              .filter((it) => it && typeof it.r === 'number' && typeof it.g === 'number' && typeof it.b === 'number')
              .slice(0, PALETTE_MAX)
          }
        } catch {}
        renderPalette()
      }

      async function pushPalette(c) {
        const hex = toHex(c)
        palette = palette.filter((it) => toHex(it) !== hex)
        palette.unshift({ r: clamp255(c.r), g: clamp255(c.g), b: clamp255(c.b) })
        if (palette.length > PALETTE_MAX) palette.length = PALETTE_MAX
        renderPalette()
        try {
          await api?.storage?.set?.(PALETTE_KEY, palette)
        } catch {}
      }

      function renderPalette() {
        const root = $('palette')
        root.innerHTML = ''
        if (!palette.length) {
          root.innerHTML = '<div class="empty">暂无历史颜色<br />取色后将在此展示最近 24 色</div>'
          return
        }
        for (const c of palette) {
          const hex = toHex(c)
          const cell = document.createElement('div')
          cell.className = 'cell'
          cell.style.background = hex
          cell.title = hex
          cell.dataset.hex = hex
          cell.onclick = () => {
            current = c
            renderCurrent()
            void copyText(hex, hex)
          }
          root.appendChild(cell)
        }
        markCurrentCell()
      }

      $('btn-clear').onclick = async () => {
        palette = []
        renderPalette()
        try {
          await api?.storage?.set?.(PALETTE_KEY, palette)
        } catch {}
        toast('已清空历史色板', 'info')
      }

      api?.ui?.setTitle?.('取色器')
      renderCurrent()
      void loadPalette()
