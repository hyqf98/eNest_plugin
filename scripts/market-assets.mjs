import { realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

const SCREENSHOT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const ICON_EXTENSIONS = new Set([...SCREENSHOT_EXTENSIONS, '.svg', '.ico'])

/** Resolve manifest media once for validation, local indexes and Release attachments. */
function resolveImage(value, pluginDir, manifest, field, suffix, extensions) {
  const fail = (message) => { throw new Error(`${manifest.id}: ${field} ${message}`) }
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    fail('must be a non-empty path or HTTPS URL without surrounding whitespace')
  }
  if (/^https:\/\//i.test(value)) {
    let url
    try { url = new URL(value) } catch { fail('must be a valid HTTPS URL') }
    if (url.username || url.password || /[\\\s]/.test(value)) fail('contains invalid URL characters or credentials')
    return { url: url.href }
  }
  if (isAbsolute(value) || /[:\\?#]/.test(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('must be relative to the plugin root, without parent traversal, backslashes or URL schemes')
  }
  const extension = extname(value).toLowerCase()
  if (!extensions.has(extension)) fail(`must use ${[...extensions].join(', ')}`)
  let source
  try {
    source = realpathSync(resolve(pluginDir, value))
    const withinRoot = relative(realpathSync(pluginDir), source)
    if (withinRoot === '..' || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) fail('must stay inside the plugin root')
    if (!statSync(source).isFile()) fail('must reference a regular file')
  } catch (error) {
    if (error.code === 'ENOENT') fail(`file does not exist: ${value}`)
    throw error
  }
  return {
    source,
    url: ['plugins', manifest.id, ...value.split('/')].map(encodeURIComponent).join('/'),
    releaseName: `${manifest.id}@${manifest.version}-${suffix}${extension}`
  }
}

export function resolveMarketAssets(manifest, pluginDir) {
  const screenshots = manifest.market?.screenshots ?? []
  if (!Array.isArray(screenshots) || screenshots.length > 8) {
    throw new Error(`${manifest.id}: market.screenshots must be an array with at most 8 images`)
  }
  const icon = manifest.logo || manifest.icon
  return {
    icon: icon ? resolveImage(icon, pluginDir, manifest, 'logo/icon', 'icon', ICON_EXTENSIONS) : null,
    screenshots: screenshots.map((value, index) => resolveImage(
      value, pluginDir, manifest, `market.screenshots[${index}]`, `screenshot-${index + 1}`, SCREENSHOT_EXTENSIONS
    ))
  }
}
