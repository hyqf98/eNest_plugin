/**
 * Artplayer 封装：统一主题色/常用配置/hls.js 集成。
 * Artplayer 是开源 HTML5 视频播放器（MIT，TVBox-web 同款），自带
 * 进度拖拽快进预览、倍速、音量、设置菜单、画中画、自动隐藏控制栏、键盘控制。
 */
import Artplayer from 'artplayer'
import Hls from 'hls.js'

/** 从壳 CSS 变量取主题色（带回退） */
function themeColor(varName, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return v || fallback
}

/**
 * 创建带 hls.js 的 Artplayer 实例。
 * opts: { container, url, kind, live, title, autoPlay, resumeSec, speed, onPosition, onEnded, onError, customControls }
 */
export function createPlayer(opts) {
  const { container, url, kind, live = false, title = '', autoPlay = true, resumeSec = 0, speed = 1, onPosition, onEnded, onError, extraControls = [] } = opts
  let hls = null
  let destroyed = false

  const art = new Artplayer({
    container,
    url,
    type: kind === 'hls' ? 'm3u8' : kind === 'mp4' ? 'mp4' : '',
    live,
    autoplay: autoPlay,
    autoOrientation: true,
    pip: true,
    setting: true,
    hotkey: true,
    loop: false,
    flip: true,
    aspectRatio: true,
    fullscreen: true,
    fullscreenWeb: true,
    playbackRate: true,
    screenshot: false,
    miniProgressBar: true,
    moreVideoAttr: { crossOrigin: 'anonymous', playsInline: true },
    theme: themeColor('--accent', '#bd542b'),
    volume: 1,
    speed,
    lang: 'zh-cn',
    customType: {
      m3u8(video, src) {
        if (Hls.isSupported()) {
          if (hls) hls.destroy()
          hls = new Hls({
            maxBufferLength: 30,
            manifestLoadingTimeOut: 20_000,
            manifestLoadingMaxRetry: 3,
            fragLoadingTimeOut: 30_000,
            fragLoadingMaxRetry: 4,
            ...(live ? { liveDurationInfinity: true } : {}),
          })
          hls.loadSource(src)
          hls.attachMedia(video)
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (!data.fatal) return
            // 致命错误自动恢复：网络错误 startLoad；媒体错误 recoverMediaError
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              hls?.startLoad()
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              try { hls?.recoverMediaError() } catch { /* fallthrough */ }
            } else {
              onError?.(`播放失败：${data.details}`)
            }
          })
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = src
        } else {
          onError?.('当前环境不支持 HLS 播放')
        }
      },
    },
    controls: [
      ...extraControls,
    ],
    settings: live ? [] : [
      {
        html: '播放速度',
        width: 200,
        tooltip: `${speed}x`,
        selector: [0.5, 0.75, 1, 1.25, 1.5, 2, 3].map(s => ({ html: `${s}x`, value: s, default: s === speed })),
        onSelect(item) {
          art.playbackRate = item.value
          return `${item.value}x`
        },
      },
    ],
  })

  /* 续播 seek + 事件外抛 */
  art.on('ready', () => {
    if (resumeSec > 10 && !live && art.duration && resumeSec < art.duration - 10) {
      art.currentTime = resumeSec
    }
    if (art.option.speed !== 1) art.playbackRate = art.option.speed
  })
  let lastEmit = 0
  art.on('timeupdate', () => {
    const now = Date.now()
    if (onPosition && now - lastEmit > 1000) {
      lastEmit = now
      onPosition(art.currentTime, art.duration)
    }
  })
  art.on('ended', () => onEnded?.())
  const origDestroy = art.destroy.bind(art)
  art.destroy = () => {
    destroyed = true
    void destroyed
    hls?.destroy()
    hls = null
    origDestroy()
  }
  return art
}

export { Artplayer }
