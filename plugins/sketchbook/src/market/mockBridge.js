/**
 * 本地 mock 桥 —— 只在没有宿主桥接的开发预览下启用。
 *
 * 数据取自插件仓库 registry.json 的公开字段（名称、简介、分类、版本、图标、截图），
 * 不包含任何用户数据、真实凭据或远程请求；图标/截图用内联 SVG 生成，
 * 这样 npm run dev 直开浏览器也能看到完整的市场界面与详情页。
 */
import { SKETCH_ICON_NAMES } from '../shared/icons.js'
import { createPreviewAppearance, loadPreviewTheme } from '../shared/previewTheme.js'
import { normalizeWorkspaceRoute, WORKSPACE_ROUTES } from './workspaceRoute.js'

const RAW = [
  ['anything', 'Anything 文件搜索', '效率', '1.1.0', '全盘文件即时搜索：Spotlight / Everything 引擎，关键词高亮、排序分页、文本与图片预览。', true],
  ['batch-rename', '批量重命名', '其它', '1.2.0', '拖入多文件，查找替换、序号、日期、大小写与插入删除片段批量改名。', false],
  ['calculator', '计算器', '效率', '1.4.0', '科学计算、变量赋值、Ans 与内存寄存器、百分比双语义、千分位显示。', false],
  ['ccswitch', '供应商切换', '开发', '1.2.0', 'AI CLI 供应商切换台：多应用配置管理、预设切换、历史与回退。', false],
  ['clipboard', '剪贴板', '效率', '1.3.0', '搜索文本、图片与文件历史；快捷回贴，文本变换工具条与暂存片段。', true],
  ['codec', '编解码', '开发', '1.3.0', 'Base64、URL、Hex、Unicode、HTML 编解码与 JWT 解析。', false],
  ['codex-pets', 'Codex 宠物市场', '开发', '1.1.0', '浏览社区宠物画廊：搜索、排序、标签筛选与分页。', false],
  ['color-picker', '取色器', '设计', '1.3.0', '屏幕与图片精准取色，HEX/RGB/HSL/OKLCH 复制、和谐色与对比度检查。', false],
  ['cron', 'Cron 工具', '开发', '1.2.0', '五/六域可视化构建、中文人性化描述、未来执行预览与 crontab 导出。', false],
  ['database', '数据库', '开发', '1.3.0', '多数据库工作台：离线编辑器、查询与结果编辑、结构与数据比较。', true],
  ['diff', '文本对比', '开发', '1.1.0', '双栏 LCS 行级对比、行内字符细化、差异导航与 unified 输出。', false],
  ['dsh', 'DSH 驾驶舱', '开发', '0.2.0', 'DeepSeek Harness 会话驾驶舱：小窗查看多会话进度并快速对话。', true],
  ['hash', '哈希与加密', '开发', '1.3.0', '多算法同屏哈希（SHA 家族 / MD5）、文件哈希进度与校验对比。', false],
  ['image-tools', '图片工具箱', '媒体', '1.1.0', '图片压缩、格式转换、批量缩放、裁剪旋转、水印与色板提取。', false],
  ['json-tools', 'JSON 工具', '开发', '1.4.0', '无损数字 JSON 格式化、路径查询、类型生成、统计与树浏览。', false],
  ['lan-share', '局域网传件', '其它', '1.1.0', '同一 Wi-Fi 下把文件发给手机：取件码与二维码即扫即下。', false],
  ['markdown', 'Markdown 笔记', '效率', '1.1.0', '分组笔记树、实时预览、全文搜索、图片附件与导出。', false],
  ['middleware', '中间件控制台', '开发', '0.3.0', 'Kafka / RabbitMQ / MQTT / RocketMQ 统一控制台。', true],
  ['net-kit', '网络调试台', '开发', '1.1.0', 'HTTP / TCP / WebSocket 调试工作台：流式响应与 SSE。', false],
  ['password-kit', '密码工具箱', '效率', '1.3.0', '随机密码、密码短语与 PIN 生成，强度检查与 UUID 生成。', false],
  ['pomodoro', '番茄钟', '效率', '1.3.0', '主进程后台专注计时，长短休息、时长预设与本地统计。', false],
  ['regex', '正则工作台', '开发', '1.1.0', '正则实时匹配高亮、捕获分组、替换预览与元字符速查。', false],
  ['remote-desktop', '远程桌面', '开发', '1.2.0', 'VNC / RDP 远程桌面：资产管理、SSH 隧道、多会话画布与剪贴板互通。', false],
  ['screen-assistant', '屏幕助手', '媒体', '1.4.0', '截图与原图历史、裁剪箭头文字标注、区域录屏和贴图管理。', true],
  ['ssh', 'SSH 管理', '开发', '1.3.0', 'SSH 工作台：快速连接、终端提示、远程文件与进程端口巡检。', true],
  ['sticky-notes', '备忘录', '效率', '1.3.0', '快速记录、Markdown 预览、颜色筛选、标签整理与归档回收。', false],
  ['sysguard', '进程与端口', '效率', '1.2.0', '本机进程与端口巡检：概览仪表盘、迷你趋势与阈值告警。', false],
  ['timestamp', '时间戳', '开发', '1.3.0', '时间戳与时区转换、多时区时钟、格式模板与批量转换。', false],
  ['todos', '待办清单', '效率', '1.3.0', '任务清单、拖拽排序、截止日期、优先级、子任务进度与标签。', false],
  ['translate', '翻译', '效率', '1.4.0', '多引擎翻译、原文译文对照、语言快捷切换与双语复制导出。', true],
  ['unit-convert', '单位与汇率', '效率', '1.2.0', '长度、面积、体积、质量、温度、速度、数据量、汇率同屏联动。', false],
]

const INK = ['#986b59', '#8b7247', '#607961', '#51797c', '#62758c', '#916975']

/** 内联 SVG 图标：与手绘主题同源的圆头笔画，避免依赖外部资源。 */
function mockIcon(name, index) {
  const ink = INK[index % INK.length]
  const glyph = Array.from(name)[0]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="9" fill="${ink}"/>
    <path d="M9 22.5c4.5-9 9-13.5 14-13.5" stroke="rgba(255,255,255,.45)" stroke-width="2" stroke-linecap="round" fill="none"/>
    <text x="16" y="21.5" text-anchor="middle" font-family="PingFang SC, sans-serif" font-size="14" font-weight="700" fill="#fff">${glyph}</text>
  </svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** 截图占位：一张"界面速写"，说明这是演示数据而非真实截图。 */
function mockShot(name, index) {
  const ink = INK[index % INK.length]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400">
    <rect width="640" height="400" fill="#f4f2e8"/>
    <rect x="0" y="0" width="640" height="44" fill="#fdfcf5"/>
    <circle cx="22" cy="22" r="5" fill="#e0542f"/><circle cx="40" cy="22" r="5" fill="#f2a83b"/><circle cx="58" cy="22" r="5" fill="#4f9d69"/>
    <rect x="20" y="66" width="180" height="30" rx="9" fill="${ink}" opacity=".16"/>
    <rect x="20" y="112" width="600" height="1.5" fill="${ink}" opacity=".3"/>
    <rect x="20" y="132" width="360" height="14" rx="7" fill="#22262b" opacity=".18"/>
    <rect x="20" y="158" width="280" height="10" rx="5" fill="#22262b" opacity=".12"/>
    <rect x="20" y="200" width="186" height="140" rx="16" fill="#fdfcf5" stroke="${ink}" stroke-width="2"/>
    <rect x="228" y="200" width="186" height="140" rx="16" fill="#fdfcf5" stroke="${ink}" stroke-width="2" opacity=".7"/>
    <rect x="436" y="200" width="184" height="140" rx="16" fill="#fdfcf5" stroke="${ink}" stroke-width="2" opacity=".45"/>
    <path d="M32 372c120-16 240 16 360-4 90-15 160-8 232-22" stroke="${ink}" stroke-width="7" stroke-linecap="round" fill="none" opacity=".55"/>
    <text x="24" y="392" font-family="PingFang SC, sans-serif" font-size="12" fill="#5c6570">${name} · 演示数据</text>
  </svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const README = `# 演示插件

这是一个用于本地样式预览的隔离演示条目，数据来自插件仓库的公开字段。

## 功能

- 目录、搜索、分类筛选与已安装视图
- 详情页展示截图、权限与 README
- 安装、更新、停用与卸载全部由宿主原生确认

## 说明

页面只渲染宿主提供的纯文本与受控资源句柄；这里显示的内联 SVG 截图仅用于预览，
不连接网络、不读取用户文件，也不代表插件的真实界面。
`

function buildItems() {
  return RAW.map(([id, name, category, version, description, featured], index) => {
    const installed = index % 4 === 1 || id === 'clipboard' || id === 'todos'
    return {
      pluginId: `com.github.eNest.${id}`,
      name,
      description,
      category,
      author: 'eNest Labs',
      version: installed && index % 8 === 5 ? '1.0.0' : version,
      latestVersion: version,
      installed,
      enabled: true,
      icon: mockIcon(name, index),
      glyph: Array.from(name)[0],
      tags: [category, '本地'],
      featured,
      installs: String(1200 + index * 137),
      packageSize: 320_000 + index * 48_000,
      screenshots: [mockShot(name, index), mockShot(name, index + 2)],
    }
  })
}

/** 预览专用 README：真实宿主会经 enest-home://catalog/<id>/readme 提供。 */
export function readMockReadme() { return README }

export async function createMockBridge({ mode = 'light' } = {}) {
  const pack = await loadPreviewTheme()
  const items = buildItems()
  const listeners = { appearance: new Set(), command: new Set() }
  let revision = 1
  let catalogRevision = 1
  let state = { mode, palette: pack.variants[mode].background.palette, motion: pack.variants[mode].animation }

  const snapshot = () => {
    const appearance = createPreviewAppearance(pack, state.mode, revision)
    return {
      appearance: {
        ...appearance,
        background: {
          ...appearance.background,
          palette: state.palette,
          media: { type: 'color', value: pack.palettes.find(palette => palette.id === state.palette).css, opacity: appearance.background.opacity, fit: 'cover' },
        },
        animation: { requested: state.motion, effective: state.motion, continuous: state.motion !== 'low' },
      },
      generation: 1,
      resources: { fonts: [] },
    }
  }

  const detailOf = id => {
    const item = items.find(entry => entry.pluginId === id)
    if (!item) return null
    return {
      ...item,
      permissions: ['clipboard.write', 'net.fetch', 'settings.register'],
      readmeUrl: `enest-home://catalog/${encodeURIComponent(id)}/readme`,
      readmeImages: {},
    }
  }

  const bridge = {
    async ready(payload) {
      if (payload?.workspaceVersion !== 1 || !Array.isArray(payload.routes) ||
        payload.routes.length !== WORKSPACE_ROUTES.length || !WORKSPACE_ROUTES.every(route => payload.routes.includes(route))) {
        throw new Error('Invalid workspace ready routes')
      }
      listeners.command.forEach(listener => listener({ type: 'visibility', visible: true }))
    },
    async ackNavigation() {},
    async getAppearance() { return snapshot() },
    async getConfig() { return { locale: 'zh-CN', installedFirst: true, offline: true, warmInstall: false, revision } },
    async getCatalog() { return { items, revision: catalogRevision } },
    async getDetail(id) { return detailOf(id) },
    async search({ query, limit = 6 }) {
      const text = String(query || '').toLowerCase()
      return {
        revision,
        items: items
          .filter(item => item.name.toLowerCase().includes(text) || (item.description || '').toLowerCase().includes(text))
          .slice(0, limit)
          .map(item => ({
            handle: `mock:${item.pluginId}`, kind: 'plugin', title: item.name,
            subtitle: item.description?.slice(0, 32), icon: item.icon, glyph: item.glyph,
            pluginId: item.pluginId, installed: item.installed, enabled: item.enabled, tags: item.tags,
          })),
      }
    },
    async refresh() { catalogRevision++; return { items, revision: catalogRevision } },
    async action(request) {
      if (request.type === 'navigate') {
        const command = { type: 'navigate', route: normalizeWorkspaceRoute(request.route), requestId: `mock-${Date.now()}`, generation: 1, revision }
        listeners.command.forEach(listener => listener(command))
      }
      return { ok: true }
    },
    onAppearance(listener) { listeners.appearance.add(listener); return () => listeners.appearance.delete(listener) },
    onCommand(listener) { listeners.command.add(listener); return () => listeners.command.delete(listener) },
  }

  /** 预览工具：切换深浅模式 / 模拟宿主导航，方便截图与样式核对。 */
  window.__sketchbookPreview = {
    mode(next) {
      if (!pack.variants[next]) return
      state = { ...state, mode: next }
      revision++
      const payload = snapshot()
      listeners.appearance.forEach(listener => listener(payload))
    },
    palette(next) {
      if (!pack.palettes.some(palette => palette.id === next)) return
      state = { ...state, palette: next }
      revision++
      listeners.appearance.forEach(listener => listener(snapshot()))
    },
    motion(next) {
      if (!['low', 'medium', 'high'].includes(next)) return
      state = { ...state, motion: next }
      revision++
      listeners.appearance.forEach(listener => listener(snapshot()))
    },
    navigate(route) {
      const target = normalizeWorkspaceRoute(route)
      listeners.command.forEach(listener => listener({ type: 'navigate', route: target, requestId: `mock-${Date.now()}`, generation: 1, revision }))
    },
    /** 预览专用 README：真实宿主会经 enest-home://catalog/<id>/readme 提供。 */
    readme: () => README,
    /** 模拟安装命令，用来核对安装进度与完成后的目录刷新。 */
    install(pluginId) {
      const item = items.find(entry => entry.pluginId === pluginId)
      if (!item) return
      item.installed = true
      catalogRevision++
      listeners.command.forEach(listener => listener({ type: 'install', pluginId, status: 'progress', progress: 42 }))
      setTimeout(() => listeners.command.forEach(listener => listener({ type: 'install', pluginId, status: 'done' })), 700)
    },
    ready: true,
    icons: SKETCH_ICON_NAMES.length,
  }

  return bridge
}
