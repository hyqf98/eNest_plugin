/**
 * installed — 已安装宠物管理：扫描 ~/.codex/pets + 线上数据比对 + 删除/重装。
 */
import { getPet, formatCount } from './api.js'
import { fetchImageBlob } from './netbin.js'
import { detectCodex, listInstalled, deleteInstalled } from './installer.js'
import { galleryCardState, applySpriteStyle } from './sprite.js'
import { runInstall } from './gallery.js'

export async function renderInstalled(body, kit, { onNavigate }) {
  body.innerHTML = '<div class="cp-empty">检测本机 Codex…</div>'

  let detected
  try {
    detected = await detectCodex()
  } catch (err) {
    body.innerHTML = `<div class="cp-empty">检测失败：${escapeHtml(err.message)}</div>`
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
    body.innerHTML = `<div class="cp-empty">扫描 ~/.codex/pets 失败：${escapeHtml(err.message)}</div>`
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
        <h2 class="cp-card-title">${escapeHtml(item.id)}</h2>
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
        fetchImageBlob('poster', pet.posterUrl).then(url => { poster.src = url }).catch(() => {})
        const state = galleryCardState(pet)
        card.addEventListener('pointerenter', () => {
          fetchImageBlob('spritesheet', pet.spritesheetUrl)
            .then(blobUrl => {
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

    card.querySelector('[data-delete]').addEventListener('click', async event => {
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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
