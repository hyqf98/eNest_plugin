/**
 * api — codex-pets.net API client（GET /api/pets 列表 + /api/pets/:id 详情）。
 * normalizePet 对齐原站 domain/pets.ts：spriteVersion 推断、缺省值兜底、URL 绝对化。
 * 纯函数（normalizePet / formatCount / 宠物匹配过滤）供 tests/ 覆盖。
 */
import { getJson } from './netbin.js'

/**
 * 列表：GET /api/pets?page&pageSize&sort&q&tag&kind&format&content
 * 返回 { pets, page, pageSize, total, totalPages }。
 */
export async function listPets(state) {
  const params = new URLSearchParams()
  params.set('page', String(state.page ?? 1))
  const pageSize = state.sort === 'random' ? (state.pageSize ?? 3) : (state.pageSize ?? 30)
  params.set('pageSize', String(pageSize))
  if (state.sort) params.set('sort', state.sort)
  const q = (state.query ?? '').trim()
  if (q) params.set('q', q)
  for (const tag of state.tags ?? []) params.append('tag', tag)
  if (state.kind && state.kind !== 'all') params.set('kind', state.kind)
  if (state.format && state.format !== 'all') params.set('format', state.format)
  if (state.content && state.content !== 'safe') params.set('content', state.content)
  if (state.sort === 'random') params.set('_', String(Date.now())) // 随机页防缓存
  return getJson(`/api/pets?${params.toString()}`)
}

export async function getPet(id) {
  const data = await getJson(`/api/pets/${encodeURIComponent(id)}`)
  return data?.pet ? normalizePet(data.pet) : null
}

function absoluteUrl(url) {
  if (!url) return ''
  // 已是绝对地址（http/data/demo 演示协议）直接返回；站内相对路径拼前缀
  if (/^(https?:|data:|demo:)/i.test(url)) return url
  return `https://codex-pets.net${url}`
}

/** 归一化宠物对象（对齐原站 normalizePet） */
export function normalizePet(pet) {
  const reported = pet?.validationReport?.spriteVersionNumber
  const inferred = pet?.validationReport?.atlasSize === '1536x2288' ? 2 : 1
  const version =
    pet?.spriteVersionNumber === 1 || pet?.spriteVersionNumber === 2
      ? pet.spriteVersionNumber
      : reported === 1 || reported === 2 ? reported : inferred
  return {
    id: String(pet?.id ?? ''),
    displayName: String(pet?.displayName ?? pet?.id ?? ''),
    description: String(pet?.description ?? ''),
    spriteVersionNumber: version,
    kind: pet?.kind ?? 'object',
    ownerHandle: pet?.ownerHandle ?? '',
    ownerName: pet?.ownerName ?? '',
    uploadedAt: pet?.uploadedAt ?? '',
    viewCount: pet?.viewCount ?? 0,
    downloadCount: pet?.downloadCount ?? 0,
    likeCount: pet?.likeCount ?? 0,
    tags: Array.isArray(pet?.tags) ? pet.tags : [],
    spritesheetUrl: absoluteUrl(pet?.spritesheetUrl),
    posterUrl: absoluteUrl(pet?.posterUrl),
    previewUrl: absoluteUrl(pet?.previewUrl),
    downloadUrl: absoluteUrl(pet?.downloadUrl),
    validationReport: pet?.validationReport ?? null
  }
}

/** 计数格式化（原站 13.2K 风格） */
export function formatCount(value) {
  const n = Number(value) || 0
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

/** 安装命令（对齐原站 petImportCommand） */
export function petImportCommand(pet, mode = 'cli') {
  if (mode === 'cli') return `npx codex-pets add ${pet.id}`
  return [
    `curl -L "${pet.downloadUrl}" \\`,
    `  -o "/tmp/${pet.id}.codex-pet.zip" &&`,
    `mkdir -p "$HOME/.codex/pets/${pet.id}" &&`,
    `unzip -o "/tmp/${pet.id}.codex-pet.zip" \\`,
    `  -d "$HOME/.codex/pets/${pet.id}"`
  ].join('\n')
}

/** 官方安装命令（终端执行，复制用） */
export const INSTALL_HINT = '安装后在 Codex 的 设置 → Pets（或 /pet 命令）中选择宠物'
