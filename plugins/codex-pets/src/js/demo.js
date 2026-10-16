/**
 * demo — 截图/预览夹具的隔离演示数据（无真实网络、无用户资源）。
 * 由 netbin 在 window.__preview 存在时启用；数据为虚构宠物。
 */

/** 演示宠物 poster（SVG data URL，像素风） */
function demoPoster(hue, glyph) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 208">
    <rect width="192" height="208" fill="hsl(${hue},30%,14%)"/>
    <g fill="hsl(${hue},70%,62%)" font-family="monospace" font-size="86" text-anchor="middle">
      <text x="96" y="132">${glyph}</text>
    </g>
    <g fill="rgba(255,255,255,0.14)">
      ${Array.from({ length: 8 }, (_, i) => `<rect x="${12 + i * 22}" y="168" width="14" height="14" rx="3"/>`).join('')}
    </g>
  </svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const demoPets = [
  {
    id: 'demo-pixel-cat', displayName: '像素猫 · 演示', description: '隔离演示数据：一只会待机、挥手与奔跑的像素小猫。',
    kind: 'creature', tags: ['animated', 'pixel', 'cute'], spriteVersionNumber: 2,
    ownerName: 'eNest Labs', ownerHandle: 'enest',
    viewCount: 13200, likeCount: 348, downloadCount: 92, uploadedAt: '2026-10-01T00:00:00.000Z',
    validationReport: { manifestId: 'demo-pixel-cat', atlasSize: '1536x2288', cellSize: '192x208', statesDetected: 11, manifestBytes: 233, spritesheetBytes: 1835094, spriteVersionNumber: 2 }
  },
  {
    id: 'demo-run-bot', displayName: '奔跑机器人 · 演示', description: '隔离演示数据：V2 格式机器人，含 16 方向视线。',
    kind: 'robot', tags: ['animated', 'robot', 'retro'], spriteVersionNumber: 2,
    ownerName: 'eNest Labs', ownerHandle: 'enest',
    viewCount: 9800, likeCount: 210, downloadCount: 64, uploadedAt: '2026-09-28T00:00:00.000Z',
    validationReport: { atlasSize: '1536x2288', statesDetected: 11, spriteVersionNumber: 2 }
  },
  {
    id: 'demo-legacy-duck', displayName: '旧版鸭子 · 演示', description: '隔离演示数据：V1 旧格式（9 行图集），仍可安装。',
    kind: 'animal', tags: ['animated', 'cute'], spriteVersionNumber: 1,
    ownerName: 'eNest Labs', ownerHandle: 'enest',
    viewCount: 4200, likeCount: 96, downloadCount: 31, uploadedAt: '2026-09-20T00:00:00.000Z',
    validationReport: { atlasSize: '1536x1872', statesDetected: 9, spriteVersionNumber: 1 }
  }
]

const GLYPHS = ['🐈', '🤖', '🦆']
const HUES = [28, 200, 120]

/** demo 模式：GET /api/pets 返回演示列表（应用搜索/标签过滤以便场景真实） */
export function demoListPets(state) {
  const query = String(state?.query ?? '').trim().toLowerCase()
  let pets = demoPets
  if (query) {
    pets = pets.filter(p => [p.id, p.displayName, p.description, ...(p.tags ?? [])].some(v => String(v).toLowerCase().includes(query)))
  }
  if (Array.isArray(state?.tags) && state.tags.length > 0) {
    pets = pets.filter(p => state.tags.some(tag => p.tags.includes(tag)))
  }
  const pageSize = state?.sort === 'random' ? 3 : 30
  return {
    pets: pets.slice(0, pageSize).map((p, i) => withUrls(p, i)),
    page: state?.page ?? 1,
    pageSize,
    total: pets.length,
    totalPages: 1
  }
}

export function demoGetPet(id) {
  const index = demoPets.findIndex(p => p.id === id)
  return index >= 0 ? withUrls(demoPets[index], index) : null
}

/** demo 模式：任意远程图片 URL → 本地 SVG 占位（保持卡片视觉真实） */
export function demoImageFor(url) {
  const index = demoPets.findIndex(p => url.includes(p.id))
  const i = index >= 0 ? index : 0
  return demoPoster(HUES[i], GLYPHS[i])
}

function withUrls(pet, index) {
  return {
    ...pet,
    spritesheetUrl: `demo://${pet.id}/spritesheet.webp`,
    posterUrl: demoPoster(HUES[index], GLYPHS[index]),
    previewUrl: `demo://${pet.id}/preview.webp`,
    downloadUrl: `demo://${pet.id}/download`
  }
}
