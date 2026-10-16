/**
 * Codex 宠物市场 —— React 版（原 src/js/main.js 路由装配 + detail.js/installed.js 逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原版完全一致；gallery.js 渲染函数、sprite.js 逐帧引擎、
 * api/netbin/installer/config/demo 资产与业务通道原样复用（未改动）。
 * hash 路由：#/ 画廊 · #/pets/<id> 详情 · #/installed 已安装，等价迁移。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createKit } from '../js/kit.js'
import { renderGallery, refreshInstalledMarks } from '../js/gallery.js'
import { getPet, normalizePet, formatCount, petImportCommand, INSTALL_HINT, listPets } from '../js/api.js'
import { fetchImageBlob, downloadBinary, toDataUrl } from '../js/netbin.js'
import { detailTabs, lookCell, applySpriteStyle, galleryCardState, CursorPet } from '../js/sprite.js'
import { detectCodex, listInstalled, deleteInstalled } from '../js/installer.js'
import { runInstall } from '../js/gallery.js'

const escapeHtmlLocal = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function App() {
  const bodyRef = useRef(null)
  const cursorPetRef = useRef(null)
  const cursorPetElRef = useRef(null)
  const kitRef = useRef(null)
  const [, force] = useState(0)

  if (!kitRef.current) kitRef.current = createKit({})
  const kit = kitRef.current

  const onNavigate = useCallback((hash) => {
    if (location.hash === hash) routeRef.current()
    else location.hash = hash
  }, [])

  /** 详情页渲染（原 detail.js renderDetail 逐行等价：容器换成 ref 目标） */
  const renderDetailInto = useCallback(async (body, petId) => {
    body.innerHTML = '<div class="cp-empty">加载中…</div>'
    let pet
    try {
      pet = await getPet(petId)
    } catch (err) {
      body.innerHTML = `<div class="cp-empty">加载失败：${escapeHtmlLocal(err.message)}<br/><button type="button" class="cp-btn" data-back>返回画廊</button></div>`
      body.querySelector('[data-back]').addEventListener('click', () => { location.hash = '#/' })
      return
    }
    if (!pet) {
      body.innerHTML = '<div class="cp-empty">宠物不存在（可能已被删除）<br/><button type="button" class="cp-btn" data-back>返回画廊</button></div>'
      body.querySelector('[data-back]').addEventListener('click', () => { location.hash = '#/' })
      return
    }

    const rows = detailTabs(pet.spriteVersionNumber)
    const installed = await isInstalled(pet.id)
    const report = pet.validationReport ?? {}

    body.innerHTML = `
      <div class="cp-detail">
        <article class="cp-detail-hero">
          <p class="cp-detail-id">id / <strong>${escapeHtmlLocal(pet.id)}</strong> · by ${escapeHtmlLocal(pet.ownerName || pet.ownerHandle || '匿名')}</p>
          <h1 class="cp-detail-title">${escapeHtmlLocal(pet.displayName)}</h1>
          <p class="cp-detail-desc">${escapeHtmlLocal(pet.description)}</p>
          <div class="cp-card-tags">${pet.tags.map((t) => `<span class="cp-tag">${escapeHtmlLocal(t)}</span>`).join('')}</div>
          <p class="cp-card-stats">
            <span title="浏览">👁 ${formatCount(pet.viewCount)}</span>
            <span title="点赞">♥ ${formatCount(pet.likeCount)}</span>
            <span title="下载">⬇ ${formatCount(pet.downloadCount)}</span>
            <span title="格式">V${pet.spriteVersionNumber}${pet.spriteVersionNumber === 1 ? ' · 旧版' : ''}</span>
          </p>
          <div class="cp-stage">
            <div class="cp-stage-frame"><div class="sprite"></div></div>
            <button type="button" class="cp-btn ghost cp-look-toggle" id="d-look">→ 试试它的 16 个视线方向</button>
          </div>
          <div class="cp-tabs" role="tablist" aria-label="动画状态">
            ${rows.map((r, i) => `<button type="button" role="tab" class="cp-tab${i === 0 ? ' is-active' : ''}" data-row="${r.row}" data-frames="${r.frames}" aria-selected="${i === 0}">${escapeHtmlLocal(r.label)}</button>`).join('')}
          </div>
          <div class="cp-look-dial" id="d-dial" hidden>
            <div class="cp-look-ring"></div>
          </div>
          <div class="cp-detail-share">
            <button type="button" class="cp-btn ghost" id="d-copy-link">复制原站链接</button>
            <button type="button" class="cp-btn ghost" id="d-open">在浏览器打开</button>
          </div>
        </article>

        <article class="cp-detail-install">
          <h3>安装到 Codex</h3>
          <p class="cp-muted">${INSTALLED_HINT(pet, installed)}</p>
          <button type="button" class="cp-btn primary cp-install-main" data-install ${installed ? 'data-reinstall' : ''}>${installed ? '重新安装 / 更新' : '一键安装到 Codex'}</button>
          <div class="cp-cmd">
            <div class="cp-cmd-head">
              <span>终端安装命令</span>
              <div class="cp-cmd-modes">
                <button type="button" class="cp-seg is-active" data-mode="cli">CLI</button>
                <button type="button" class="cp-seg" data-mode="curl">curl</button>
              </div>
              <button type="button" class="cp-btn ghost" id="d-copy-cmd">复制</button>
            </div>
            <pre class="cp-cmd-body"><code id="d-cmd"></code></pre>
          </div>
          <button type="button" class="cp-btn ghost" id="d-export">导出 .codex-pet.zip</button>
          <dl class="cp-pkg">
            <div><dt>manifest</dt><dd>${escapeHtmlLocal(report.manifestId ?? pet.id)}</dd></div>
            <div><dt>格式</dt><dd>V${report.spriteVersionNumber ?? pet.spriteVersionNumber}</dd></div>
            <div><dt>图集</dt><dd>${escapeHtmlLocal(report.atlasSize ?? (pet.spriteVersionNumber === 2 ? '1536x2288' : '1536x1872'))}</dd></div>
            <div><dt>行数</dt><dd>${report.statesDetected ?? (pet.spriteVersionNumber === 2 ? 11 : 9)}</dd></div>
            <div><dt>pet.json</dt><dd>${formatBytes(report.manifestBytes)}</dd></div>
            <div><dt>spritesheet</dt><dd>${formatBytes(report.spritesheetBytes)}</dd></div>
          </dl>
          <p class="cp-muted cp-install-hint">${escapeHtmlLocal(INSTALL_HINT)}</p>
        </article>
      </div>
      <section class="cp-more">
        <h2>更多宠物</h2>
        <div class="cp-more-grid" id="d-more"></div>
      </section>
    `

    // hero 舞台：加载 spritesheet 并播放选中行
    const stageSprite = body.querySelector('.cp-stage-frame .sprite')
    let sheetUrl = null
    try {
      sheetUrl = await fetchImageBlob('spritesheet', pet.spritesheetUrl)
    } catch (err) {
      kit.toast(`spritesheet 加载失败：${err.message}`, 'error')
    }
    const playRow = (row) => {
      if (!sheetUrl) return
      applySpriteStyle(stageSprite, { url: sheetUrl, row: row.row, frames: row.frames, version: pet.spriteVersionNumber })
    }
    playRow(rows[0])
    for (const tab of body.querySelectorAll('.cp-tab')) {
      tab.addEventListener('click', () => {
        for (const t of body.querySelectorAll('.cp-tab')) t.classList.remove('is-active')
        tab.classList.add('is-active')
        playRow({ row: Number(tab.dataset.row), frames: Number(tab.dataset.frames) })
        body.querySelector('#d-dial').hidden = true
      })
    }

    // 16 视线罗盘
    const dial = body.querySelector('#d-dial')
    body.querySelector('#d-look').addEventListener('click', () => {
      dial.hidden = !dial.hidden
      if (!dial.hidden) buildLookDial(dial, stageSprite, sheetUrl, pet.spriteVersionNumber)
    })

    // 分享
    body.querySelector('#d-copy-link').addEventListener('click', () => kit.copy(`https://codex-pets.net/#/pets/${pet.id}`))
    body.querySelector('#d-open').addEventListener('click', async () => {
      const enest = window.enest || window.zapi
      await enest.shell.openExternal(`https://codex-pets.net/#/pets/${pet.id}`)
    })

    // 安装命令切换 + 复制
    const cmdEl = body.querySelector('#d-cmd')
    let cmdMode = 'cli'
    const renderCmd = () => { cmdEl.textContent = petImportCommand(pet, cmdMode) }
    renderCmd()
    for (const btn of body.querySelectorAll('.cp-cmd-modes .cp-seg')) {
      btn.addEventListener('click', () => {
        cmdMode = btn.dataset.mode
        for (const b of body.querySelectorAll('.cp-cmd-modes .cp-seg')) b.classList.toggle('is-active', b === btn)
        renderCmd()
      })
    }
    body.querySelector('#d-copy-cmd').addEventListener('click', () => kit.copy(cmdEl.textContent))

    // 一键安装
    body.querySelector('.cp-install-main').addEventListener('click', () => runInstall(pet, kit, body))

    // 导出 zip（宿主保存对话框）
    body.querySelector('#d-export').addEventListener('click', async (event) => {
      const btn = event.currentTarget
      btn.disabled = true
      try {
        const bytes = await downloadBinary(pet.downloadUrl)
        const enest = window.enest || window.zapi
        const result = await enest.shell.saveFile({ defaultName: `${pet.id}.codex-pet.zip`, dataUrl: toDataUrl(bytes, 'application/zip') })
        if (result?.ok) kit.toast(`已导出到 ${result.path}`, 'success')
      } catch (err) {
        kit.toast(`导出失败：${err.message}`, 'error')
      } finally {
        btn.disabled = false
      }
    })

    // 更多宠物（随机 3 只）
    try {
      const more = await listPets({ sort: 'random', page: 1 })
      const grid = body.querySelector('#d-more')
      for (const raw of (more.pets ?? []).slice(0, 3)) {
        const p = normalizePet(raw)
        if (p.id === pet.id) continue
        const card = document.createElement('button')
        card.type = 'button'
        card.className = 'cp-more-card'
        card.innerHTML = `
          <img class="cp-more-poster" alt="" loading="lazy" />
          <span class="cp-more-name">${escapeHtmlLocal(p.displayName)}</span>
          <span class="cp-more-by">by ${escapeHtmlLocal(p.ownerName || p.ownerHandle || '匿名')}</span>
        `
        card.addEventListener('click', () => onNavigate(`#/pets/${encodeURIComponent(p.id)}`))
        grid.append(card)
        fetchImageBlob('poster', p.posterUrl).then((url) => { card.querySelector('img').src = url }).catch(() => {})
      }
    } catch { /* 推荐失败静默 */ }
  }, [kit, onNavigate])

  /** 已安装管理（原 installed.js renderInstalled 逐行等价） */
  const renderInstalledInto = useCallback(async (body) => {
    body.innerHTML = '<div class="cp-empty">检测本机 Codex…</div>'

    let detected
    try {
      detected = await detectCodex()
    } catch (err) {
      body.innerHTML = `<div class="cp-empty">检测失败：${escapeHtmlLocal(err.message)}</div>`
      return
    }
    if (!detected.installed) {
      body.innerHTML = `
        <div class="cp-empty">
          <p><strong>未检测到 Codex</strong></p>
          <p class="cp-muted">未找到 ~/.codex/config.toml。请先安装并运行一次 Codex CLI，再回来管理宠物。</p>
          <p class="cp-muted">（Windows 下为 %USERPROFILE%\\.codex；Linux/macOS 为 ~/.codex。WSL 内的 Codex 路径不被 Windows 侧识别，属 Codex 已知问题。）</p>
        </div>`
      return
    }

    let items
    try {
      items = await listInstalled()
    } catch (err) {
      body.innerHTML = `<div class="cp-empty">扫描 ~/.codex/pets 失败：${escapeHtmlLocal(err.message)}</div>`
      return
    }

    if (items.length === 0) {
      body.innerHTML = `
        <div class="cp-empty">
          <p><strong>还没有安装任何宠物</strong></p>
          <p class="cp-muted">去画廊挑一只，点击「安装」即可写入 ~/.codex/pets/。</p>
          <button type="button" class="cp-btn primary" data-gallery>去画廊</button>
        </div>`
      body.querySelector('[data-gallery]').addEventListener('click', () => onNavigate('#/'))
      return
    }

    const totalBytes = await sumBytes()
    body.innerHTML = `
      <div class="cp-installed-head">
        <p>本机已安装 <strong>${items.length}</strong> 只宠物 · 占用约 ${formatSize(totalBytes)}</p>
        <p class="cp-muted">安装目录：~/.codex/pets · 在 Codex 设置 → Pets 或 /pet 命令中选择宠物</p>
      </div>
      <div class="cp-grid" id="i-grid"></div>
    `
    const grid = body.querySelector('#i-grid')
    for (const item of items) {
      const card = document.createElement('article')
      card.className = 'cp-card cp-installed-card'
      card.innerHTML = `
        <div class="cp-card-stage">
          <img class="cp-card-poster" alt="" loading="lazy" />
          <div class="cp-card-sprite" aria-hidden="true"></div>
          <span class="cp-installed-mark">已装 ✓</span>
        </div>
        <div class="cp-card-info">
          <h2 class="cp-card-title">${escapeHtmlLocal(item.id)}</h2>
          <p class="cp-card-by" data-meta>本地安装于 ${new Date(item.modifiedAt).toLocaleString()}</p>
          <p class="cp-card-desc" data-desc></p>
        </div>
        <div class="cp-card-actions">
          <button type="button" class="cp-btn ghost" data-detail>详情</button>
          <button type="button" class="cp-btn ghost" data-install data-reinstall>重装 / 更新</button>
          <button type="button" class="cp-btn danger ghost" data-delete>删除</button>
        </div>
      `
      grid.append(card)

      // 线上数据补全（不存在则保持本地信息）
      try {
        const pet = await getPet(item.id)
        if (pet) {
          card.querySelector('.cp-card-title').textContent = pet.displayName
          card.querySelector('[data-meta]').textContent = `by ${pet.ownerName || pet.ownerHandle || '匿名'} · V${pet.spriteVersionNumber} · 👁 ${formatCount(pet.viewCount)}`
          card.querySelector('[data-desc]').textContent = pet.description
          const poster = card.querySelector('.cp-card-poster')
          fetchImageBlob('poster', pet.posterUrl).then((url) => { poster.src = url }).catch(() => {})
          const state = galleryCardState(pet)
          card.addEventListener('pointerenter', () => {
            fetchImageBlob('spritesheet', pet.spritesheetUrl)
              .then((blobUrl) => {
                if (!card.isConnected) return
                applySpriteStyle((card.querySelector('.cp-card-sprite .sprite') ?? (() => { const el = document.createElement('div'); el.className = 'sprite'; card.querySelector('.cp-card-sprite').append(el); return el })()), {
                  url: blobUrl, row: state.row, frames: state.frames, version: pet.spriteVersionNumber
                })
                card.querySelector('.cp-card-sprite').classList.add('is-playing')
              })
              .catch(() => {})
          })
          card.addEventListener('pointerleave', () => card.querySelector('.cp-card-sprite').classList.remove('is-playing'))
          card.querySelector('[data-detail]').addEventListener('click', () => onNavigate(`#/pets/${encodeURIComponent(pet.id)}`))
          card.querySelector('[data-reinstall]').addEventListener('click', () => runInstall(pet, kit, card))
        } else {
          card.querySelector('[data-desc]').textContent = '（线上已下架，仅本地存在）'
          card.querySelector('[data-reinstall]').disabled = true
          card.querySelector('[data-detail]').disabled = true
        }
      } catch { /* 线上查询失败保持本地视图 */ }

      card.querySelector('[data-delete]').addEventListener('click', async (event) => {
        const btn = event.currentTarget
        btn.disabled = true
        try {
          await deleteInstalled(item.id)
          kit.toast(`已删除 ~/.codex/pets/${item.id}`, 'success')
          card.remove()
        } catch (err) {
          btn.disabled = false
          kit.toast(`删除失败：${err.message}`, 'error')
        }
      })
    }
  }, [kit, onNavigate])

  const route = useCallback(async () => {
    const cursorPet = cursorPetRef.current
    const body = bodyRef.current
    const statusEl = document.getElementById('foot-status')
    if (!body) return
    cursorPet?.hide()
    const hash = location.hash || '#/'
    syncNav(hash)
    try {
      if (hash.startsWith('#/pets/')) {
        const petId = decodeURIComponent(hash.slice('#/pets/'.length).split('?')[0])
        statusEl.textContent = `宠物详情 · ${petId}`
        await renderDetailInto(body, petId)
      } else if (hash.startsWith('#/installed')) {
        statusEl.textContent = '已安装管理'
        await renderInstalledInto(body)
      } else {
        statusEl.textContent = '画廊'
        await refreshInstalledMarks()
        await renderGallery(body, kit, { onNavigate, cursorPet })
      }
    } catch (err) {
      body.innerHTML = `<div class="cp-empty">页面渲染失败：${escapeHtmlLocal(err?.message ?? String(err))}</div>`
    }
  }, [kit, onNavigate, renderDetailInto, renderInstalledInto])
  const routeRef = useRef(route)
  routeRef.current = route

  const [navActive, setNavActive] = useState('#/')
  const syncNav = (hash) => {
    setNavActive(hash.startsWith('#/installed') ? '#/installed' : '#/')
  }

  useEffect(() => {
    cursorPetRef.current = new CursorPet(cursorPetElRef.current)
    window.addEventListener('hashchange', routeRef.current)
    ;(window.enest || window.zapi)?.onBeforeClose?.(() => cursorPetRef.current?.hide())
    void routeRef.current()
    return () => {
      window.removeEventListener('hashchange', routeRef.current)
      cursorPetRef.current?.hide()
    }
  }, [])

  const openOrigin = async (event) => {
    event.preventDefault()
    const enest = window.enest || window.zapi
    try {
      await enest.shell.openExternal('https://codex-pets.net/')
    } catch (err) {
      kit.toast(err?.message ?? '无法打开外部链接', 'error')
    }
  }

  return (
    <>
      <main className="cp" id="app">
        <header className="cp-top">
          <h1 className="cp-logo" title="codex-pets.net">🐾 Codex 宠物市场</h1>
          <nav className="cp-nav" id="nav" aria-label="页面">
            <button
              type="button"
              className={`cp-nav-btn${navActive === '#/' ? ' is-active' : ''}`}
              data-route="#/"
              title="画廊"
              onClick={() => onNavigate('#/')}
            >
              画廊
            </button>
            <button
              type="button"
              className={`cp-nav-btn${navActive === '#/installed' ? ' is-active' : ''}`}
              data-route="#/installed"
              title="已安装到本机 Codex"
              onClick={() => onNavigate('#/installed')}
            >
              已安装
            </button>
          </nav>
          <div className="cp-spacer"></div>
          <a className="cp-origin" id="origin-link" href="https://codex-pets.net/" title="在浏览器打开原站" onClick={openOrigin}>codex-pets.net ↗</a>
        </header>

        <section className="cp-body" id="body" ref={bodyRef}>{/* 路由视图渲染 */}</section>

        <footer className="cp-foot">
          <span id="foot-status">就绪</span>
          <span className="cp-foot-hint">数据来自 codex-pets.net 社区 · 安装目录 ~/.codex/pets</span>
        </footer>
      </main>

      {/* 光标跟随宠物（画廊卡片 hover 触发） */}
      <div className="cp-cursor-pet" id="cursor-pet" aria-hidden="true" ref={cursorPetElRef}>
        <div className="sprite"></div>
      </div>

      {/* 通用浮层宿主 */}
      <dialog id="dlg"></dialog>
    </>
  )
}

function INSTALLED_HINT(pet, installed) {
  if (installed) return `已安装到本机（~/.codex/pets/${pet.id}）。可重新安装以更新到线上最新版本。`
  return `将下载 .codex-pet.zip 并写入 ~/.codex/pets/${pet.id}/（写入前会弹出确认）。`
}

async function isInstalled(petId) {
  try {
    const list = await listInstalled()
    return list.some((item) => item.id === petId)
  } catch {
    return false
  }
}

function buildLookDial(dial, stageSprite, sheetUrl, version) {
  if (version !== 2) {
    dial.innerHTML = '<p class="cp-muted">V1 旧版宠物没有 16 方向视线行。</p>'
    return
  }
  dial.innerHTML = '<div class="cp-look-ring"></div>'
  const ring = dial.querySelector('.cp-look-ring')
  for (let i = 0; i < 16; i += 1) {
    const cell = lookCell(i)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'cp-look-cell'
    btn.title = cell.name
    const angle = i * (360 / 16)
    btn.style.setProperty('--angle', `${angle}deg`)
    btn.addEventListener('click', () => {
      if (!sheetUrl) return
      applySpriteStyle(stageSprite, { url: sheetUrl, row: cell.row, frames: 8, version, staticFrame: cell.frame })
    })
    ring.append(btn)
  }
}

async function sumBytes() {
  try {
    const enest = window.enest || window.zapi
    const res = await enest.agent.listAssets({ app: 'codex', path: 'pets' })
    return (res?.entries ?? []).reduce((sum, e) => sum + (Number(e.size) || 0), 0)
  } catch {
    return 0
  }
}

function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return n > 0 ? `${n} B` : '—'
}
