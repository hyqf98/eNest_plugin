/**
 * detail — 详情页：hero 舞台 + 动画状态 tabs + 16 视线罗盘 + 安装面板 + 相关推荐。
 */
import { getPet, normalizePet, formatCount, petImportCommand, INSTALL_HINT } from './api.js'
import { listPets } from './api.js'
import { fetchImageBlob, downloadBinary, toDataUrl } from './netbin.js'
import { detailTabs, lookCell, applySpriteStyle } from './sprite.js'
import { detectCodex, listInstalled } from './installer.js'
import { runInstall } from './gallery.js'

export async function renderDetail(body, kit, { petId, onNavigate }) {
  body.innerHTML = '<div class="cp-empty">加载中…</div>'
  let pet
  try {
    pet = await getPet(petId)
  } catch (err) {
    body.innerHTML = `<div class="cp-empty">加载失败：${escapeHtml(err.message)}<br/><button type="button" class="cp-btn" data-back>返回画廊</button></div>`
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
        <p class="cp-detail-id">id / <strong>${escapeHtml(pet.id)}</strong> · by ${escapeHtml(pet.ownerName || pet.ownerHandle || '匿名')}</p>
        <h1 class="cp-detail-title">${escapeHtml(pet.displayName)}</h1>
        <p class="cp-detail-desc">${escapeHtml(pet.description)}</p>
        <div class="cp-card-tags">${pet.tags.map(t => `<span class="cp-tag">${escapeHtml(t)}</span>`).join('')}</div>
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
          ${rows.map((r, i) => `<button type="button" role="tab" class="cp-tab${i === 0 ? ' is-active' : ''}" data-row="${r.row}" data-frames="${r.frames}" aria-selected="${i === 0}">${escapeHtml(r.label)}</button>`).join('')}
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
          <div><dt>manifest</dt><dd>${escapeHtml(report.manifestId ?? pet.id)}</dd></div>
          <div><dt>格式</dt><dd>V${report.spriteVersionNumber ?? pet.spriteVersionNumber}</dd></div>
          <div><dt>图集</dt><dd>${escapeHtml(report.atlasSize ?? (pet.spriteVersionNumber === 2 ? '1536x2288' : '1536x1872'))}</dd></div>
          <div><dt>行数</dt><dd>${report.statesDetected ?? (pet.spriteVersionNumber === 2 ? 11 : 9)}</dd></div>
          <div><dt>pet.json</dt><dd>${formatBytes(report.manifestBytes)}</dd></div>
          <div><dt>spritesheet</dt><dd>${formatBytes(report.spritesheetBytes)}</dd></div>
        </dl>
        <p class="cp-muted cp-install-hint">${escapeHtml(INSTALL_HINT)}</p>
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
  const playRow = row => {
    if (!sheetUrl) return
    applySpriteStyle(stageSprite, {
      url: sheetUrl,
      row: row.row,
      frames: row.frames,
      version: pet.spriteVersionNumber
    })
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
  body.querySelector('#d-export').addEventListener('click', async event => {
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
        <span class="cp-more-name">${escapeHtml(p.displayName)}</span>
        <span class="cp-more-by">by ${escapeHtml(p.ownerName || p.ownerHandle || '匿名')}</span>
      `
      card.addEventListener('click', () => onNavigate(`#/pets/${encodeURIComponent(p.id)}`))
      grid.append(card)
      fetchImageBlob('poster', p.posterUrl).then(url => { card.querySelector('img').src = url }).catch(() => {})
    }
  } catch { /* 推荐失败静默 */ }
}

function INSTALLED_HINT(pet, installed) {
  if (installed) return `已安装到本机（~/.codex/pets/${pet.id}）。可重新安装以更新到线上最新版本。`
  return `将下载 .codex-pet.zip 并写入 ~/.codex/pets/${pet.id}/（写入前会弹出确认）。`
}

async function isInstalled(petId) {
  try {
    const list = await listInstalled()
    return list.some(item => item.id === petId)
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
      applySpriteStyle(stageSprite, {
        url: sheetUrl,
        row: cell.row,
        frames: 8,
        version,
        staticFrame: cell.frame
      })
    })
    ring.append(btn)
  }
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return n > 0 ? `${n} B` : '—'
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
