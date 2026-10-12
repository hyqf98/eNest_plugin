      const api = window.enest || window.zapi
      let lastShot = null
      let recSession = null
      let recStartTs = 0
      let recTimerId = null
      const gallery = [] // 本次会话：{ id, dataUrl, ts, w, h }，新在前，上限 20
      let history = [] // 持久化：{ id, ts, thumb, w, h }，新在前，上限 8

      const HISTORY_KEY = 'sa_history_v1'
      const HISTORY_MAX = 8
      const GALLERY_MAX = 20

      const $ = (id) => document.getElementById(id)
      const status = (text, rec = false) => {
        const el = $('status')
        el.textContent = text
        el.classList.toggle('rec', rec)
      }
      const toast = async (message, type = 'info') => {
        try {
          await api?.ui?.toast?.({ message, type })
        } catch {}
      }
      const isPerm = (err) => String(err?.message || err).includes('permission denied')
      const failToast = (e, permName) =>
        toast(isPerm(e) ? '缺少 ' + permName + ' 权限' : String(e?.message || e), 'error')
      const genId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

      document.querySelectorAll('nav button').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('nav button').forEach((b) => {
            b.classList.remove('active')
            b.setAttribute('aria-selected', 'false')
          })
          document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'))
          btn.classList.add('active')
          btn.setAttribute('aria-selected', 'true')
          $('panel-' + btn.dataset.tab).classList.add('active')
          if (btn.dataset.tab === 'pin') void refreshPins()
        })
      })

      function setShot(dataUrl, meta) {
        lastShot = dataUrl
        $('shot-preview').innerHTML = '<img alt="截图" src="' + dataUrl + '"/>'
        $('btn-copy').disabled = false
        $('btn-pin').disabled = false
        const item = {
          id: meta?.id || genId(),
          dataUrl,
          ts: Date.now(),
          w: meta?.w,
          h: meta?.h
        }
        gallery.unshift(item)
        if (gallery.length > GALLERY_MAX) gallery.pop()
        renderGallery()
        return item
      }

      function renderGallery() {
        const root = $('gallery')
        root.innerHTML = ''
        const merged = []
        const seen = new Set()
        for (const it of gallery) {
          if (seen.has(it.id)) continue
          seen.add(it.id)
          merged.push({ id: it.id, ts: it.ts, src: it.dataUrl, w: it.w, h: it.h })
        }
        for (const it of history) {
          if (seen.has(it.id)) continue
          seen.add(it.id)
          merged.push({ id: it.id, ts: it.ts, src: it.thumb, w: it.w, h: it.h })
        }
        merged.sort((a, b) => b.ts - a.ts)
        if (!merged.length) {
          root.innerHTML = '<div class="empty">暂无记录</div>'
          return
        }
        for (const item of merged) {
          const card = document.createElement('div')
          card.className = 'card'
          const meta = new Date(item.ts).toLocaleTimeString() + (item.w && item.h ? ' · ' + item.w + '×' + item.h : '')
          card.innerHTML =
            '<div class="thumb"><img alt=""/><button type="button" class="pin-cta">贴出</button></div><div class="meta"></div>'
          card.querySelector('img').alt = '截图 ' + meta
          card.querySelector('img').src = item.src
          card.querySelector('.meta').textContent = meta
          card.onclick = () => void pinImage(item.src)
          root.appendChild(card)
        }
      }

      // canvas 压缩缩略：宽 ≤360，JPEG quality 0.72
      function makeThumb(dataUrl, maxW = 360, quality = 0.72) {
        return new Promise((resolve) => {
          const img = new Image()
          img.onload = () => {
            try {
              const scale = Math.min(1, maxW / (img.naturalWidth || maxW))
              const w = Math.max(1, Math.round((img.naturalWidth || maxW) * scale))
              const h = Math.max(1, Math.round((img.naturalHeight || maxW) * scale))
              const canvas = document.createElement('canvas')
              canvas.width = w
              canvas.height = h
              canvas.getContext('2d').drawImage(img, 0, 0, w, h)
              resolve({ thumb: canvas.toDataURL('image/jpeg', quality), w: img.naturalWidth, h: img.naturalHeight })
            } catch {
              resolve(null)
            }
          }
          img.onerror = () => resolve(null)
          img.src = dataUrl
        })
      }

      async function loadHistory() {
        try {
          const raw = await api?.storage?.get?.(HISTORY_KEY)
          if (Array.isArray(raw)) {
            history = raw.filter((it) => it && it.thumb && typeof it.ts === 'number')
            renderGallery()
          }
        } catch {}
      }

      async function persistThumb(id, dataUrl, w, h) {
        const t = await makeThumb(dataUrl)
        const entry = {
          id,
          ts: Date.now(),
          thumb: t ? t.thumb : dataUrl,
          w: t ? t.w : w,
          h: t ? t.h : h
        }
        history = history.filter((it) => it.id !== id)
        history.unshift(entry)
        if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX)
        renderGallery()
        try {
          await api?.storage?.set?.(HISTORY_KEY, history)
        } catch {}
      }

      async function doCapture(mode) {
        if (!api?.screen) {
          toast('eNest API 不可用', 'error')
          return
        }
        try {
          status(mode === 'region' ? '请选择截图区域…' : '截取全屏…')
          let bounds
          if (mode === 'region') {
            bounds = await api.screen.selectRegion()
            if (!bounds) {
              status('已取消')
              return
            }
          }
          const id = genId()
          const shot = await api.screen.capture({ bounds })
          setShot(shot.dataUrl, { id, w: shot.width, h: shot.height })
          status(`已截取 ${shot.width}×${shot.height}`)
          toast('截图完成', 'success')
          void persistThumb(id, shot.dataUrl, shot.width, shot.height)
        } catch (e) {
          status('截图失败')
          failToast(e, 'screen.capture')
        }
      }

      $('btn-capture').onclick = () => doCapture('region')
      $('btn-full').onclick = () => doCapture('full')

      $('btn-copy').onclick = async () => {
        if (!lastShot) return
        try {
          await api.clipboard.writeImage(lastShot)
          toast('已复制图片', 'success')
        } catch (e) {
          failToast(e, 'clipboard.writeImage')
        }
      }

      async function pinImage(dataUrl) {
        if (!api?.pin) {
          toast('eNest API 不可用', 'error')
          return false
        }
        try {
          await api.pin.open({ dataUrl, width: 420 })
          toast('已贴到屏幕', 'success')
          void refreshPins()
          return true
        } catch (e) {
          failToast(e, 'pin.create')
          return false
        }
      }

      $('btn-pin').onclick = () => {
        if (!lastShot) return
        void pinImage(lastShot)
      }

      // —— 贴图页：三个入口 ——

      $('btn-pin-shot').onclick = async () => {
        if (!api?.screen) {
          toast('eNest API 不可用', 'error')
          return
        }
        try {
          status('请选择截图区域…')
          const bounds = await api.screen.selectRegion()
          if (!bounds) {
            status('已取消')
            return
          }
          const id = genId()
          const shot = await api.screen.capture({ bounds })
          setShot(shot.dataUrl, { id, w: shot.width, h: shot.height })
          status(`已截取 ${shot.width}×${shot.height}，贴图中…`)
          await pinImage(shot.dataUrl)
          void persistThumb(id, shot.dataUrl, shot.width, shot.height)
        } catch (e) {
          status('截图失败')
          failToast(e, 'screen.capture')
        }
      }

      $('btn-pin-clip').onclick = async () => {
        try {
          const img = await api.clipboard.readImage()
          if (!img || !img.dataUrl) {
            toast('剪贴板无图片', 'warn')
            return
          }
          await pinImage(img.dataUrl)
        } catch (e) {
          failToast(e, 'clipboard.readImage')
        }
      }

      $('btn-pin-file').onclick = () => $('file-pin').click()

      $('file-pin').onchange = () => {
        const input = $('file-pin')
        const file = input.files && input.files[0]
        input.value = ''
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = String(reader.result || '')
          if (!dataUrl.startsWith('data:image/')) {
            toast('无法读取该图片', 'error')
            return
          }
          void pinImage(dataUrl)
        }
        reader.onerror = () => toast('读取文件失败', 'error')
        reader.readAsDataURL(file)
      }

      // —— 贴图管理 ——

      async function refreshPins() {
        if (!api?.pin) return
        try {
          const pins = await api.pin.list()
          renderPins(Array.isArray(pins) ? pins : [])
        } catch (e) {
          failToast(e, 'pin.create')
        }
      }

      function renderPins(pins) {
        const root = $('pin-list')
        root.innerHTML = ''
        $('btn-pin-closeall').disabled = !pins.length
        if (!pins.length) {
          root.innerHTML = '<div class="empty">暂无贴图</div>'
          return
        }
        pins.forEach((p, i) => {
          const id = String(p?.pinId || '')
          const row = document.createElement('div')
          row.className = 'pin-row'
          const idx = document.createElement('span')
          idx.className = 'pin-idx'
          idx.textContent = String(i + 1)
          const code = document.createElement('span')
          code.className = 'pin-code'
          code.title = id
          code.textContent = (id.slice(0, 12) + (id.length > 12 ? '…' : '')) || '-'
          const closeBtn = document.createElement('button')
          closeBtn.type = 'button'
          closeBtn.className = 'btn small ghost'
          closeBtn.textContent = '关闭'
          closeBtn.onclick = async () => {
            try {
              await api.pin.close(id)
              toast('已关闭贴图', 'success')
            } catch (e) {
              failToast(e, 'pin.create')
            }
            void refreshPins()
          }
          row.append(idx, code, closeBtn)
          root.appendChild(row)
        })
      }

      $('btn-pin-closeall').onclick = async () => {
        try {
          const n = await api.pin.closeAll()
          toast('已关闭 ' + n + ' 张贴图', 'success')
        } catch (e) {
          failToast(e, 'pin.create')
        }
        void refreshPins()
      }

      // —— 录屏 ——

      function fmtElapsed(ms) {
        const s = Math.max(0, Math.floor(ms / 1000))
        const h = Math.floor(s / 3600)
        const m = Math.floor((s % 3600) / 60)
        const sec = s % 60
        const two = (n) => String(n).padStart(2, '0')
        return h > 0 ? h + ':' + two(m) + ':' + two(sec) : two(m) + ':' + two(sec)
      }

      function startRecTimer() {
        recStartTs = Date.now()
        $('rec-timer').textContent = '00:00'
        const tick = () => {
          $('rec-timer').textContent = fmtElapsed(Date.now() - recStartTs)
        }
        recTimerId = window.setInterval(tick, 500)
      }

      function stopRecTimer() {
        if (recTimerId !== null) {
          window.clearInterval(recTimerId)
          recTimerId = null
        }
      }

      function setRecUi(running) {
        $('btn-rec-start').disabled = running
        $('btn-rec-stop').disabled = !running
        $('btn-rec-cancel').disabled = !running
        $('rec-stage').classList.toggle('recording', running)
        $('rec-label').textContent = running ? '录制中' : '待机'
        if (running) {
          startRecTimer()
        } else {
          stopRecTimer()
          $('rec-timer').textContent = '00:00'
        }
        status(running ? '录制中…' : '就绪', running)
      }

      $('btn-rec-start').onclick = async () => {
        if (!api?.screen?.record) return
        try {
          const bounds = await api.screen.selectRegion()
          if (!bounds) {
            status('已取消')
            return
          }
          const withAudio = $('chk-audio').checked
          const { sessionId } = await api.screen.record.start({ bounds, withAudio })
          recSession = sessionId
          setRecUi(true)
          $('rec-info').textContent = `会话 ${sessionId.slice(0, 8)} · ${bounds.width}×${bounds.height}`
        } catch (e) {
          setRecUi(false)
          failToast(e, 'screen.record')
        }
      }

      $('btn-rec-stop').onclick = async () => {
        if (!recSession) return
        try {
          const result = await api.screen.record.stop(recSession)
          recSession = null
          setRecUi(false)
          $('rec-info').textContent = `已保存 ${result.path}（${Math.round(result.size / 1024)} KB，${Math.round(result.durationMs / 1000)}s）`
          toast('录屏完成', 'success')
        } catch (e) {
          recSession = null
          setRecUi(false)
          toast(String(e.message || e), 'error')
        }
      }

      $('btn-rec-cancel').onclick = async () => {
        if (!recSession) return
        try {
          await api.screen.record.cancel(recSession)
        } catch {}
        recSession = null
        setRecUi(false)
        $('rec-info').textContent = '已取消录制'
      }

      api?.onEnter?.(({ code }) => {
        if (code === 'capture') void doCapture('region')
        if (code === 'record') document.querySelector('[data-tab="record"]').click()
        if (code === 'pin') document.querySelector('[data-tab="pin"]').click()
      })
      api?.ui?.setTitle?.('屏幕助手')
      renderGallery()
      void loadHistory()
