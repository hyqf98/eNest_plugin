/** 文件类型图标：一套 20px 线性 SVG，currentColor 描边，目录用 accent 淡填充。 */

const KINDS = {
  image: 'png jpg jpeg gif webp bmp svg avif ico heic tiff',
  video: 'mp4 mov avi mkv webm m4v flv wmv',
  audio: 'mp3 wav aac flac ogg m4a wma aiff',
  archive: 'zip rar 7z tar gz tgz bz2 xz',
  pdf: 'pdf',
  code: 'js mjs cjs ts jsx tsx py rb go rs java c h cpp hpp cs php swift kt kts sh bash zsh fish html css scss less vue svelte sql json jsonc yaml yml toml xml ini conf',
  sheet: 'xls xlsx xlsb csv tsv numbers ods',
  doc: 'txt md markdown doc docx pages rtf epub log',
  font: 'ttf otf woff woff2 fon',
  app: 'app exe appimage deb apk msi pkg',
  disk: 'dmg iso img vhd vmdk'
}

const EXT_KIND = (() => {
  const map = new Map()
  for (const [kind, list] of Object.entries(KINDS)) {
    for (const ext of list.split(' ')) map.set(ext, kind)
  }
  return map
})()

const S = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
const GLYPHS = {
  dir: `<path d="M2.75 6.2c0-.8.65-1.45 1.45-1.45h3.1l2 2.1h6.5c.8 0 1.45.65 1.45 1.45v7.05c0 .8-.65 1.45-1.45 1.45H4.2a1.45 1.45 0 0 1-1.45-1.45z" ${S}/>`,
  image: `<rect x="3" y="3.6" width="14" height="12.8" rx="1.6" ${S}/><circle cx="7" cy="7.6" r="1.3" ${S}/><path d="M3.6 14.2l3.7-3.7 2.6 2.6 2.9-2.9 3.2 3.2" ${S}/>`,
  video: `<rect x="2.8" y="4.4" width="14.4" height="11.2" rx="1.8" ${S}/><path d="M8.6 7.6l4 2.4-4 2.4z" ${S}/>`,
  audio: `<path d="M7.6 13.6V6.2l7-1.4v7.4" ${S}/><circle cx="6.2" cy="13.8" r="1.7" ${S}/><circle cx="13.2" cy="12.6" r="1.7" ${S}/>`,
  archive: `<rect x="3.6" y="3.2" width="12.8" height="13.6" rx="1.6" ${S}/><path d="M10 3.4v4.2M8.8 7.6h2.4" ${S}/><rect x="8.6" y="11.6" width="2.8" height="2.4" rx=".5" ${S}/>`,
  pdf: `<path d="M4.6 2.8h7l3.8 3.8v10.6a.9.9 0 0 1-.9.9H4.6a.9.9 0 0 1-.9-.9V3.7c0-.5.4-.9.9-.9z" ${S}/><path d="M11.4 2.9v3.8h3.8" ${S}/><path d="M6.6 12.9l1.5-1.5-1.5-1.5M10.2 12.9h2.6" ${S}/>`,
  code: `<path d="M7 6.6L3.6 10 7 13.4M13 6.6L16.4 10 13 13.4M11.4 5.4l-2.8 9.2" ${S}/>`,
  sheet: `<rect x="3.2" y="3.6" width="13.6" height="12.8" rx="1.6" ${S}/><path d="M3.4 8h13.2M3.4 12.2h13.2M8.6 3.8v12.4" ${S}/>`,
  doc: `<path d="M4.6 2.8h7l3.8 3.8v10.6a.9.9 0 0 1-.9.9H4.6a.9.9 0 0 1-.9-.9V3.7c0-.5.4-.9.9-.9z" ${S}/><path d="M11.4 2.9v3.8h3.8M6.6 9.4h6.8M6.6 12.2h4.6" ${S}/>`,
  font: `<path d="M5 16.4L9.6 3.6h1L15.2 16.4M6.9 12h6.6" ${S}/>`,
  app: `<rect x="3.6" y="3.6" width="12.8" height="12.8" rx="3" ${S}/><circle cx="10" cy="10" r="2.6" ${S}/><path d="M10 3.4v1.6M10 15v1.6M3.4 10H5M15 10h1.6" ${S}/>`,
  disk: `<circle cx="10" cy="10" r="6.6" ${S}/><circle cx="10" cy="10" r="1.8" ${S}/>`,
  other: `<path d="M4.6 2.8h7l3.8 3.8v10.6a.9.9 0 0 1-.9.9H4.6a.9.9 0 0 1-.9-.9V3.7c0-.5.4-.9.9-.9z" ${S}/><path d="M11.4 2.9v3.8h3.8" ${S}/>`
}

export function fileKind(file) {
  if (file.isDirectory) return 'dir'
  return EXT_KIND.get(String(file.ext || '').toLowerCase()) || 'other'
}

export function fileIcon(file) {
  const kind = fileKind(file)
  const cls = kind === 'dir' ? 'ficon ficon-dir' : 'ficon'
  return `<svg class="${cls}" viewBox="0 0 20 20" aria-hidden="true">${GLYPHS[kind]}</svg>`
}
