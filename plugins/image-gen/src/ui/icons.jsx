/**
 * icons — 插件内统一线性图标层（24 网格，1.6 描边，currentColor）。
 * 页面不再使用 ☰ ▦ ⭐ 📎 ✎ 这类文本字形：字形随字体度量漂移，深浅色下也不统一。
 * 路径取自 Lucide 设计规范；只用 stroke，不混填充，保持单一语言。
 */

const STROKE = 1.6

function Svg({ size = 16, strokeWidth = STROKE, className = '', children, ...rest }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...rest}
    >{children}</svg>
  )
}

function glyph(children) {
  const Component = props => <Svg {...props}>{children}</Svg>
  return Component
}

/* —— 导航与容器 —— */
export const MenuIcon = glyph(<><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>)
export const PanelLeftIcon = glyph(<><rect width="18" height="18" x="3" y="3" rx="2.5" /><path d="M9.5 3v18" /></>)
export const ChevronLeftIcon = glyph(<path d="m15 18-6-6 6-6" />)
export const ChevronRightIcon = glyph(<path d="m9 18 6-6-6-6" />)
export const ChevronDownIcon = glyph(<path d="m6 9 6 6 6-6" />)

/* —— 视图 —— */
export const MessageIcon = glyph(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />)
export const GalleryIcon = glyph(<>
  <path d="M18 22H4a2 2 0 0 1-2-2V6" />
  <path d="m22 13-1.3-1.3a2.4 2.4 0 0 0-3.4 0L11 18" />
  <circle cx="12" cy="8" r="2" />
  <rect width="16" height="16" x="6" y="2" rx="2" />
</>)
export const LightbulbIcon = glyph(<>
  <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5a6 6 0 0 0-12 0c0 1.3.5 2.6 1.5 3.5.8.8 1.3 1.5 1.5 2.5" />
  <path d="M9 18h6" /><path d="M10 22h4" />
</>)
export const ExternalLinkIcon = glyph(<>
  <path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
</>)
export const SearchIcon = glyph(<>
  <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
</>)
export const WandIcon = glyph(<>
  <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" />
  <path d="m14 7 3 3" /><path d="M5 6v4" /><path d="M19 14v4" /><path d="M10 2v2" /><path d="M7 8H3" /><path d="M21 16h-4" /><path d="M11 3H9" />
</>)
export const SettingsIcon = glyph(<>
  <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
  <circle cx="12" cy="12" r="3" />
</>)
export const ArrowUpRightIcon = glyph(<><path d="M7 7h10v10" /><path d="M7 17 17 7" /></>)

/* —— 动作 —— */
export const PlusIcon = glyph(<><path d="M5 12h14" /><path d="M12 5v14" /></>)
export const MinusIcon = glyph(<path d="M5 12h14" />)
export const XIcon = glyph(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>)
export const ArrowUpIcon = glyph(<><path d="m5 12 7-7 7 7" /><path d="M12 19V5" /></>)
export const DownloadIcon = glyph(<>
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
  <path d="m7 10 5 5 5-5" />
  <path d="M12 15V3" />
</>)
export const TrashIcon = glyph(<>
  <path d="M10 11v6" /><path d="M14 11v6" />
  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  <path d="M3 6h18" />
  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
</>)
export const PencilIcon = glyph(<>
  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  <path d="m15 5 4 4" />
</>)
export const CopyIcon = glyph(<>
  <rect width="14" height="14" x="8" y="8" rx="2" />
  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
</>)
export const ExpandIcon = glyph(<>
  <path d="M15 3h6v6" /><path d="m21 3-7 7" />
  <path d="m3 21 7-7" /><path d="M9 21H3v-6" />
</>)
export const PaperclipIcon = glyph(<>
  <path d="m16 6-8.4 8.4a2 2 0 0 0 2.8 2.8l8.4-8.4a4 4 0 1 0-5.6-5.6L4.8 11.5a6 6 0 1 0 8.4 8.4L21 12" />
</>)
export const SparklesIcon = glyph(<>
  <path d="M9.94 15.5a2 2 0 0 0-1.44-1.44L2.37 12.5a.5.5 0 0 1 0-.96l6.13-1.58A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0l1.58 6.13a2 2 0 0 0 1.44 1.44l6.13 1.58a.5.5 0 0 1 0 .96l-6.13 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z" />
  <path d="M20 3v4" /><path d="M22 5h-4" />
</>)
export const RotateIcon = glyph(<>
  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
  <path d="M21 3v5h-5" />
</>)
export const MoreIcon = glyph(<>
  <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
</>)
export const CheckIcon = glyph(<path d="M20 6 9 17l-5-5" />)

/* —— 设置分区 —— */
export const KeyIcon = glyph(<>
  <path d="M2.6 17.4A6.5 6.5 0 1 1 12 8.6L21 17.6V21h-3.4v-3H14v-3.4h-3.4" />
  <circle cx="7.5" cy="11.5" r="1" />
</>)
export const FolderIcon = glyph(<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />)
export const SlidersIcon = glyph(<>
  <path d="M21 4h-7" /><path d="M10 4H3" />
  <path d="M21 12h-9" /><path d="M8 12H3" />
  <path d="M21 20h-5" /><path d="M12 20H3" />
  <path d="M14 2v4" /><path d="M8 10v4" /><path d="M16 18v4" />
</>)
export const AlertIcon = glyph(<>
  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
  <path d="M12 9v4" /><path d="M12 17h.01" />
</>)
export const SquareIcon = glyph(<rect width="12" height="12" x="6" y="6" rx="2" />)
