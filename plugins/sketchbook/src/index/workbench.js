/**
 * 素描本 · 主题样式台（DOM 版，零构建）
 *
 * 插件主窗口内容：把本主题的控件、图标、小窗与通知样式按真实尺寸排开，
 * 便于安装后核对。所有交互都是本地演示，不调用宿主能力。
 */
import { h } from '../shared/dom.js'
import { icon, SKETCH_ICON_NAMES } from '../shared/icons.js'
import { createSketchPaper, mountSketchDefs } from '../shared/sketchPrimitives.js'

const THEME_TOKENS = [
  ['--bg', '纸张底色'], ['--surface', '卡纸'], ['--surface-2', '次级卡纸'], ['--surface-3', '叠层卡纸'],
  ['--text', '墨色'], ['--text-2', '次要文字'], ['--text-3', '弱化文字'], ['--accent', '马克笔'],
  ['--ok', '成功'], ['--danger', '危险'], ['--border', '描边'], ['--border-strong', '强描边'],
]

const INKS = [
  ['--ink-1', '赭红'], ['--ink-2', '旧金'], ['--ink-3', '苔绿'],
  ['--ink-4', '灰青'], ['--ink-5', '灰蓝'], ['--ink-6', '藕灰'],
]

function sheet(title, hint, ...children) {
  return h('section', { class: 'sk-sheet' },
    h('h2', null, title),
    hint ? h('p', { class: 'sk-hint' }, hint) : null,
    ...children)
}

function field(label, control, help, helpClass) {
  return h('div', { class: 'sk-field' },
    h('label', null, label),
    control,
    help ? h('small', { class: helpClass || '' }, help) : null)
}

function buildHeader(onMode) {
  const modes = [['follow', '跟随宿主'], ['light', '浅色'], ['dark', '深色']]
  const group = h('div', { class: 'sk-work-mode', role: 'group', 'aria-label': '配色模式' })
  const buttons = modes.map(([value, label]) => {
    const button = h('button', { type: 'button', 'aria-pressed': String(value === 'follow') }, label)
    button.dataset.mode = value
    button.addEventListener('click', () => {
      for (const item of buttons) item.setAttribute('aria-pressed', String(item === button))
      onMode(value === 'follow' ? null : value)
    })
    group.appendChild(button)
    return button
  })
  return h('header', { class: 'sk-work-head' },
    h('div', null,
      h('h1', null, '素描本 · 主题样式台'),
      h('p', null, '只预览素描本自带的控件与小窗，不切换当前主题。「跟随宿主」仅跟随浅深模式；全局外观设置仍由宿主管理。')),
    group)
}

function buttonsSheet() {
  const row1 = h('div', { class: 'sk-row' },
    h('button', { type: 'button', class: 'sk-b primary' }, icon('spark', 15), '安装插件'),
    h('button', { type: 'button', class: 'sk-b' }, '打开插件'),
    h('button', { type: 'button', class: 'sk-b ghost' }, '取消'),
    h('button', { type: 'button', class: 'sk-b', disabled: true }, '不可用'))
  const row2 = h('div', { class: 'sk-row' })
  for (const [tone, label] of [['ink-2', '旧金'], ['ink-3', '苔绿'], ['ink-4', '灰青'], ['ink-5', '灰蓝']]) {
    row2.appendChild(h('button', { type: 'button', class: `sk-b ${tone}` }, label))
  }
  return sheet('按钮', '主操作是实心马克笔色；次级是手抖描边贴纸；第三级只留文字。按下时整体向纸张压下去 1px。', row1, row2)
}

function inputsSheet() {
  const nameInput = h('input', { id: 'sk-name', class: 'sk-input', placeholder: '输入插件名称' })
  const searchInput = h('input', { id: 'sk-search', class: 'sk-input', type: 'search', placeholder: '搜索插件、功能或指令' })
  const searchWrap = h('div', { class: 'sk-field-search' }, icon('search', 15), searchInput)
  const note = h('textarea', { id: 'sk-note', class: 'sk-input sk-textarea' })
  note.value = '把常用工具放回工作流里。'

  const invalid = h('input', { id: 'sk-invalid', class: 'sk-input', 'aria-invalid': 'true' })
  invalid.value = '1.0'
  const locked = h('input', { id: 'sk-disabled', class: 'sk-input', disabled: true })
  locked.value = '由宿主管理'

  return sheet('输入框',
    '输入框只有一条底线，聚焦时底线换成马克笔色并透出一层淡色，像笔尖落在纸上。',
    h('div', { class: 'sk-cols' },
      field('插件名称', nameInput, '名称会出现在市场卡片与 Quick 搜索结果里。'),
      field('搜索', searchWrap, '⌘F 可以在市场页直接聚焦搜索。')),
    h('div', { class: 'sk-row', style: { marginTop: '12px' } },
      field('校验失败', invalid, '版本号需要三段数字，例如 1.0.0。', 'is-error'),
      field('已锁定', locked, '禁用态的输入框只读且降低对比度。')),
    h('div', { class: 'sk-field', style: { marginTop: '12px' } }, h('label', null, '备注'), note))
}

function switchesSheet() {
  const toggle = h('input', { type: 'checkbox' })
  toggle.checked = true
  const check = h('input', { type: 'checkbox' })
  check.checked = true

  const tags = h('div', { class: 'sk-row', style: { marginTop: '14px' } },
    h('span', { class: 'sk-tag' }, '默认'),
    h('span', { class: 'sk-tag is-ok' }, '已安装'),
    h('span', { class: 'sk-tag is-marker' }, '可更新'),
    h('span', { class: 'sk-tag is-danger' }, '已停用'))

  return sheet('开关与选择',
    '开关是手绘拨杆，滑块落位后换成马克笔色；复选框是方角手绘框，对勾是单笔勾。',
    h('div', { class: 'sk-row', style: { gap: '22px' } },
      h('label', { class: 'sk-switch' }, toggle, h('i', { 'aria-hidden': 'true' }), '开机自启'),
      h('label', { class: 'sk-check' }, check, h('b', { 'aria-hidden': 'true' }, icon('spark', 11)), '在市场里显示这个插件')),
    tags)
}

function iconsSheet() {
  const grid = h('div', { class: 'sk-icons' })
  for (const name of SKETCH_ICON_NAMES) {
    grid.appendChild(h('div', { class: 'sk-icon-cell', title: name }, icon(name, 21), h('span', null, name)))
  }
  return sheet('图标', '全部是 24×24 网格上的圆头笔画，路径带一点弧度，与手绘边框保持同一种笔触。', grid)
}

function windowsSheet() {
  const bar = h('div', { class: 'sk-window-bar' },
    h('i'), h('i'), h('i'), h('strong', null, '素描本'))
  const body = h('div', { class: 'sk-window-body' },
    h('input', { class: 'sk-input', placeholder: '快速记录…' }),
    h('div', { class: 'sk-window-line w70' }),
    h('div', { class: 'sk-window-line w45' }),
    h('div', { class: 'sk-row', style: { gap: '6px', marginTop: '2px' } },
      h('button', { type: 'button', class: 'sk-b primary' }, '保存'),
      h('button', { type: 'button', class: 'sk-b ghost' }, '关闭')))
  const notice = h('div', { class: 'sk-notice-demo' },
    h('div', null,
      h('strong', null, '已安装「剪贴板」'),
      h('p', null, '插件市场完成了 1 个安装任务，可以从已安装页打开。')))

  return sheet('小窗样式',
    '插件在 Quick 与独立小窗里的实际比例：标题条、输入框与按钮都按 24-27px 压缩，手绘描边与小斜角同样保留。',
    h('div', { class: 'sk-window-demo' },
      h('div', { class: 'sk-window' }, bar, body),
      notice))
}

function paletteSheet(palettes) {
  const tokens = h('div', { class: 'sk-swatches' })
  for (const [token, label] of THEME_TOKENS) {
    tokens.appendChild(h('div', { class: 'sk-swatch' },
      h('i', { style: { background: `var(${token})` } }), h('span', null, label)))
  }
  const inks = h('div', { class: 'sk-swatches', style: { marginTop: '12px' } })
  for (const [token, label] of INKS) {
    inks.appendChild(h('div', { class: 'sk-swatch' },
      h('i', { style: { background: `var(${token})` } }), h('span', null, label)))
  }
  const paletteSwatches = h('div', { class: 'sk-swatches', style: { marginTop: '12px' } })
  for (const palette of palettes) {
    paletteSwatches.appendChild(h('div', { class: 'sk-swatch' },
      h('i', { style: { background: palette.swatch || palette.css } }), h('span', null, palette.name)))
  }
  return sheet('色板', '纸面、字体与组件参数来自本包 plugin.json 的浅深 variants；色板小样来自同一主题声明，不读取当前全局主题的参数。', tokens, inks, paletteSwatches)
}

export function mountWorkbench(container, onMode, palettes = []) {
  mountSketchDefs(document.body)
  const inner = h('div', { class: 'sk-work-inner' },
    buildHeader(onMode),
    buttonsSheet(),
    inputsSheet(),
    switchesSheet(),
    iconsSheet(),
    windowsSheet(),
    paletteSheet(palettes))
  const root = h('div', { class: 'sk-work' },
    createSketchPaper(), h('div', { class: 'sk-work-scroll' }, inner))
  container.replaceChildren(root)
  return () => root.remove()
}
