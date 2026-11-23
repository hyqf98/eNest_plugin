/** canvas / video 缩略图与视频元信息。 */

export function thumbFromCanvas(canvas, { maxEdge = 320, quality = 0.72, topCrop = false } = {}) {
  const sourceWidth = canvas.width
  const sourceHeight = canvas.height
  if (!sourceWidth || !sourceHeight) throw new Error('画布为空')
  let sx = 0, sy = 0, sw = sourceWidth, sh = sourceHeight
  if (topCrop) {
    const ratio = 16 / 9
    if (sourceWidth / sourceHeight > ratio) {
      sw = Math.round(sourceHeight * ratio)
      sx = Math.round((sourceWidth - sw) / 2)
    } else {
      sh = Math.min(sourceHeight, Math.round(sourceWidth / ratio))
    }
  }
  const scale = Math.min(1, maxEdge / Math.max(sw, sh))
  const width = Math.max(1, Math.round(sw * scale))
  const height = Math.max(1, Math.round(sh * scale))
  const target = document.createElement('canvas')
  target.width = width
  target.height = height
  target.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, width, height)
  return target.toDataURL('image/jpeg', quality)
}

export function thumbFromImage(image, options = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth || image.width
  canvas.height = image.naturalHeight || image.height
  canvas.getContext('2d').drawImage(image, 0, 0)
  return thumbFromCanvas(canvas, options)
}

export function thumbFromDataUrl(dataUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      try { resolve(thumbFromImage(image, options)) } catch (error) { reject(error) }
    }
    image.onerror = () => reject(new Error('缩略图生成失败'))
    image.src = dataUrl
  })
}

export function frameFromVideo(video, { maxWidth = 0, mime = 'image/png' } = {}) {
  const width = video.videoWidth
  const height = video.videoHeight
  if (!width || !height) throw new Error('视频帧不可用')
  const scale = maxWidth > 0 ? Math.min(1, maxWidth / width) : 1
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
  return { canvas, dataUrl: canvas.toDataURL(mime) }
}

export function videoMeta(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    let settled = false
    const finish = (value, error) => {
      if (settled) return
      settled = true
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
      if (error) reject(error)
      else resolve(value)
    }
    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () => finish({ durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0, width: video.videoWidth, height: video.videoHeight })
    video.onerror = () => finish(null, new Error('视频无法读取'))
    setTimeout(() => finish(null, new Error('视频元信息读取超时')), 12000)
    video.src = url
  })
}

export function videoThumb(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    let settled = false
    const finish = (value, error) => {
      if (settled) return
      settled = true
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
      if (error) reject(error)
      else resolve(value)
    }
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true
    video.onloadeddata = () => {
      const at = Math.min(0.4, Number.isFinite(video.duration) ? video.duration * 0.1 : 0)
      if (at > 0) {
        video.onseeked = () => {
          try { finish(thumbFromCanvas(frameFromVideo(video, { maxWidth: 640 }).canvas)) } catch (error) { finish(null, error) }
        }
        video.currentTime = at
      } else {
        try { finish(thumbFromCanvas(frameFromVideo(video, { maxWidth: 640 }).canvas)) } catch (error) { finish(null, error) }
      }
    }
    video.onerror = () => finish(null, new Error('视频封面生成失败'))
    setTimeout(() => finish(null, new Error('视频封面生成超时')), 12000)
    video.src = url
  })
}
