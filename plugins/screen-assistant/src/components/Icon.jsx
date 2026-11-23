const paths = {
  capture: <><path d="M4 8h3l1.5-2h7L17 8h3v11H4V8Z" /><circle cx="12" cy="13" r="3.2" /></>,
  fullscreen: <><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /><rect x="8" y="8" width="8" height="8" rx="1" /></>,
  longshot: <><rect x="7.5" y="3" width="9" height="18" rx="2" /><path d="M12 7v7m0 0-2.2-2.2M12 14l2.2-2.2" /></>,
  record: <><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="3" className="fill" /></>,
  recordFull: <><rect x="3.5" y="5" width="17" height="12" rx="2" /><path d="M9 20h6" /><circle cx="12" cy="11" r="2" className="fill" /></>,
  library: <><rect x="3.5" y="4.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="4.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="14.5" width="7" height="5" rx="1.5" /><rect x="13.5" y="14.5" width="7" height="5" rx="1.5" /></>,
  tools: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
  pin: <><path d="M9.2 3.8h5.6l-.7 6.4 3.4 3.2v1.8H6.5v-1.8l3.4-3.2-.7-6.4Z" /><path d="M12 15.2V21" /></>,
  settings: <path fill="currentColor" stroke="none" fillRule="evenodd" d="M10.4 2h3.2l.4 2.1c.5.2 1 .4 1.4.7l2-.8 1.6 2.8-1.6 1.5c.1.5.1 1 .1 1.6s0 1.1-.1 1.6l1.6 1.5-1.6 2.8-2-.8c-.4.3-.9.5-1.4.7L13.6 22h-3.2l-.4-2.1c-.5-.2-1-.4-1.4-.7l-2 .8L5 17.2l1.6-1.5c-.1-.5-.1-1-.1-1.6s0-1.1.1-1.6L5 11l1.6-2.8 2 .8c.4-.3.9-.5 1.4-.7L10.4 2Zm1.6 5.6a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 5.5h-8a2 2 0 0 0-2 2v8" /></>,
  download: <><path d="M12 4v10m0 0-3.5-3.5M12 14l3.5-3.5" /><path d="M5 17v3h14v-3" /></>,
  upload: <><path d="M12 20V10m0 0-3.5 3.5M12 10l3.5 3.5" /><path d="M5 7V4h14v3" /></>,
  edit: <><path d="m5 19 3.5-.8L19 7.7a2 2 0 0 0-2.8-2.8L5.8 15.4 5 19Z" /><path d="m14.5 6.5 3 3" /></>,
  trash: <><path d="M5 7h14M9 7V4.5h6V7M7 7l.8 12.5h8.4L17 7" /><path d="M10 11v5M14 11v5" /></>,
  play: <path d="M8 5.5v13l10-6.5-10-6.5Z" className="fill" />,
  pause: <><rect x="7" y="5" width="3.5" height="14" rx="1" className="fill" /><rect x="13.5" y="5" width="3.5" height="14" rx="1" className="fill" /></>,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" className="fill" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  left: <path d="m14.5 6-6 6 6 6" />,
  right: <path d="m9.5 6 6 6-6 6" />,
  zoomIn: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4M11 8.5v5M8.5 11h5" /></>,
  zoomOut: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4M8.5 11h5" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  speaker: <><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></>,
  gif: <><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M8 10.5H6.5v3H8M11 10.5v3M14 13.5v-3h3" /></>,
  frame: <><path d="M7 3v18M17 3v18M3 7h18M3 17h18" /></>,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m5 18 5-5 3.5 3.5L16 13l3 3" /></>,
  film: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M8 4.5v15M16 4.5v15M3.5 9h4.5M3.5 15h4.5M16 9h4.5M16 15h4.5" /></>,
  compress: <><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></>,
  convert: <><path d="M4 8h11l-3-3M20 16H9l3 3" /></>,
  resize: <><path d="M4 9V4h5M20 15v5h-5" /><rect x="4" y="12" width="8" height="8" rx="1" /></>,
  transform: <><path d="M4 9a8 8 0 0 1 14-3l2 2M20 15a8 8 0 0 1-14 3l-2-2" /><path d="M20 4v4h-4M4 20v-4h4" /></>,
  watermark: <><path d="M12 3.5s5 5 5 8.5a5 5 0 0 1-10 0c0-3.5 5-8.5 5-8.5Z" /><path d="M9.5 13.5h5" /></>,
  exif: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 7.6v.2" /></>,
  palette: <><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 2-2s-.8-2-.8-2.8c0-1 .8-1.7 1.8-1.7h2a4 4 0 0 0 4-4c0-3.6-4-6.5-9-6.5Z" /><circle cx="8" cy="9" r="1" className="fill" /><circle cx="12" cy="7" r="1" className="fill" /><circle cx="16" cy="9.5" r="1" className="fill" /></>,
  crop: <><path d="M7 3v11a2 2 0 0 0 2 2h11" /><path d="M3 7h11a2 2 0 0 1 2 2v11" /></>,
  arrow: <path d="M5 19 19 5m0 0h-7m7 0v7" />,
  rect: <rect x="4.5" y="6.5" width="15" height="11" rx="1" />,
  text: <path d="M5 6h14M12 6v12M9 18h6" />,
  mosaic: <><rect x="4" y="4" width="16" height="16" rx="1.5" /><path d="M4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16" /></>,
  undo: <><path d="M9 7 4.5 11 9 15" /><path d="M4.5 11H14a5.5 5.5 0 0 1 0 11h-2" /></>,
  redo: <><path d="m15 7 4.5 4L15 15" /><path d="M19.5 11H10a5.5 5.5 0 0 0 0 11h2" /></>,
  folder: <path d="M3.5 6.5h6l2 2.5h9v10.5h-17V6.5Z" />,
  refresh: <><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 4v5h-5" /></>,
  more: <><circle cx="5.5" cy="12" r="1.2" className="fill" /><circle cx="12" cy="12" r="1.2" className="fill" /><circle cx="18.5" cy="12" r="1.2" className="fill" /></>,
  save: <><path d="M4.5 4.5h12l3 3v12h-15v-15Z" /><path d="M8 4.5v5h7v-5M8 19.5v-6h8v6" /></>,
  clipboard: <><rect x="5.5" y="5" width="13" height="15" rx="2" /><path d="M9 5V3.5h6V5" /></>,
  monitor: <><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M9 20h6M12 16.5V20" /></>,
  scroll: <><rect x="7" y="3" width="10" height="18" rx="5" /><path d="M12 7v4" /></>,
  external: <><path d="M14 4h6v6M20 4l-8 8" /><path d="M18 14v5H5V6h5" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>
}

export function Icon({ name, size, className = '', ...props }) {
  const content = paths[name]
  if (!content) return null
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={`sa-icon${className ? ` ${className}` : ''}`}
      aria-hidden="true"
      {...props}
    >
      {content}
    </svg>
  )
}
