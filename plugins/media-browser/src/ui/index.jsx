/**
 * pk-ui —— eNest 官方插件标准控件层（与壳 src/renderer/components/ui 同构）
 * 行为来自 Radix UI，视觉来自 pk-ui.css（themeAware token 直读）。
 * 本文件与 pk-ui.css 作为模板整体复制到各官方插件 src/ui/，随壳组件层升级同步。
 */
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Slot } from '@radix-ui/react-slot'
import * as SelectPrimitive from '@radix-ui/react-select'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import * as SliderPrimitive from '@radix-ui/react-slider'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import './pk-ui.css'

/* —— Button —— */
export function Button({ variant, size = 'md', pressed, asChild = false, className = '', type = 'button', ...props }) {
  const classes = ['pk-btn']
  if (variant) classes.push(`pk-btn-${variant}`)
  if (size === 'sm') classes.push('pk-btn-sm')
  if (className) classes.push(className)
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      type={asChild ? undefined : type}
      aria-pressed={pressed}
      data-pressed={pressed == null ? undefined : String(pressed)}
      className={classes.join(' ')}
      {...props}
    />
  )
}

/* —— Input —— */
export function Input({ className = '', type = 'text', ...props }) {
  return <input type={type} className={`pk-input${className ? ` ${className}` : ''}`} {...props} />
}

/* —— Checkbox —— */
export function Checkbox({ className = '', ...props }) {
  return (
    <CheckboxPrimitive.Root className={`pk-checkbox${className ? ` ${className}` : ''}`} {...props}>
      <CheckboxPrimitive.Indicator className="pk-checkbox-indicator">
        <svg viewBox="0 0 10 8" fill="none" aria-hidden="true">
          <path d="M1 4l2.5 2.5L9 1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

/* —— Switch —— */
export function Switch({ className = '', ...props }) {
  return (
    <SwitchPrimitive.Root className={`pk-switch${className ? ` ${className}` : ''}`} {...props}>
      <SwitchPrimitive.Thumb className="pk-switch-thumb" />
    </SwitchPrimitive.Root>
  )
}

/* —— Segmented —— */
export function Segmented({ value, options, onChange, className = '', ariaLabel, disabled, role = 'group' }) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={(next) => { if (next) onChange(next) }}
      className={`pk-segmented${className ? ` ${className}` : ''}`}
      role={role}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      {options.map((option) => (
        <ToggleGroupPrimitive.Item key={option.value} value={option.value} disabled={option.disabled} className="pk-segmented-item">
          {option.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  )
}

/* —— Select —— */
export function Select({ value, options, onChange, disabled = false, ariaLabel, hint, className, minWidth }) {
  const current = options.find((option) => option.value === value)
  return (
    <SelectPrimitive.Root value={value} onValueChange={(next) => onChange(next)} disabled={disabled}>
      <SelectPrimitive.Trigger
        className={`pk-select-trigger pk-select-rich${className ? ` ${className}` : ''}`}
        aria-label={ariaLabel}
        style={minWidth ? { minWidth } : undefined}
      >
        <span className="pk-select-value">{current?.label ?? value}</span>
        {hint && <span className="pk-select-hint">{hint}</span>}
        <SelectPrimitive.Icon className="pk-select-caret">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" className="pk-select-pop" sideOffset={6} collisionPadding={12}>
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item key={option.value} value={option.value} disabled={option.disabled} className="pk-select-option">
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <span className="pk-select-check" aria-hidden="true">{option.value === value ? '✓' : ''}</span>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

/* —— Tooltip —— */
export function Tooltip({ content, children, side = 'top', align = 'center', delayDuration = 350 }) {
  if (!content) return children
  return (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} align={align} sideOffset={6} className="pk-tooltip">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
export const TooltipProvider = TooltipPrimitive.Provider

/* —— Dialog —— */
export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close
export function DialogOverlay(props) {
  return <DialogPrimitive.Overlay className="pk-dialog-overlay" {...props} />
}
export function DialogContent({ className = '', children, ...props }) {
  return (
    <DialogPrimitive.Content className={`pk-dialog-content${className ? ` ${className}` : ''}`} {...props}>
      {children}
    </DialogPrimitive.Content>
  )
}
export function DialogTitle(props) {
  return <DialogPrimitive.Title className="pk-dialog-title" {...props} />
}
export function DialogDescription(props) {
  return <DialogPrimitive.Description className="pk-dialog-description" {...props} />
}

/* —— PromptDialog：单行文本输入对话框 ——
   window.prompt 在 Electron 渲染进程里恒返回 null，取名、改时长这类输入一律用它。
   resolve(null) 表示取消，其余情况 resolve 去掉首尾空白后的文本。 */
export function PromptDialog({ title, description, defaultValue = '', placeholder, okText = '确定', onCancel, onSubmit }) {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef(null)
  const cancel = () => onCancel?.()
  const submit = (event) => {
    event.preventDefault()
    onSubmit?.(value.trim())
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) cancel() }}>
      <DialogOverlay />
      <DialogContent
        className="pk-prompt"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const input = inputRef.current
          if (!input) return
          input.focus()
          input.select()
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
        <form className="pk-prompt-form" onSubmit={submit}>
          <Input ref={inputRef} value={value} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} />
          <div className="pk-prompt-actions">
            <Button variant="ghost" onClick={cancel}>取消</Button>
            <Button variant="primary" type="submit">{okText}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* —— Slider —— */
export function Slider({ className = '', ...props }) {
  return (
    <SliderPrimitive.Root className={`pk-slider${className ? ` ${className}` : ''}`} {...props}>
      <SliderPrimitive.Track className="pk-slider-track">
        <SliderPrimitive.Range className="pk-slider-range" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="pk-slider-thumb" aria-label={props['aria-label']} />
    </SliderPrimitive.Root>
  )
}

export const DropdownMenu = DropdownMenuPrimitive.Root
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
export function DropdownMenuContent({ className = '', align = 'end', sideOffset = 6, children, onClick, onPointerDown, onKeyDown, ...props }) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={`pk-menu pk-menu-radix${className ? ` ${className}` : ''}`}
        data-input-context="overlay"
        {...props}
        onClick={(event) => { event.stopPropagation(); onClick?.(event) }}
        onPointerDown={(event) => { event.stopPropagation(); onPointerDown?.(event) }}
        onKeyDown={(event) => { event.stopPropagation(); onKeyDown?.(event) }}
      >
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  )
}
export function DropdownMenuItem({ className = '', danger = false, ...props }) {
  return <DropdownMenuPrimitive.Item className={`pk-menu-item${danger ? ' danger' : ''}${className ? ` ${className}` : ''}`} {...props} />
}
export function DropdownMenuCheckboxItem({ className = '', checked, children, ...props }) {
  return (
    <DropdownMenuPrimitive.CheckboxItem checked={checked} className={`pk-menu-item${className ? ` ${className}` : ''}`} {...props}>
      <span className="pk-menu-check" aria-hidden="true">{checked ? '✓' : ''}</span>
      <span className="pk-menu-label">{children}</span>
    </DropdownMenuPrimitive.CheckboxItem>
  )
}
export function DropdownMenuLabel({ className = '', ...props }) {
  return <DropdownMenuPrimitive.Label className={`pk-menu-heading${className ? ` ${className}` : ''}`} {...props} />
}
export function DropdownMenuSeparator({ className = '', ...props }) {
  return <DropdownMenuPrimitive.Separator className={`pk-menu-sep${className ? ` ${className}` : ''}`} {...props} />
}
export const DropdownMenuGroup = DropdownMenuPrimitive.Group

export function MoreMenu({ label = '⋯', ariaLabel = '更多操作', items = [], buttonClassName = '', disabled = false, triggerProps = {}, ...rootProps }) {
  return (
    <DropdownMenu modal={false} {...rootProps}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`pk-btn pk-btn-ghost pk-more-trigger${buttonClassName ? ` ${buttonClassName}` : ''}`}
          aria-label={ariaLabel}
          title={ariaLabel}
          disabled={disabled}
          {...triggerProps}
          onClick={(event) => { event.stopPropagation(); triggerProps.onClick?.(event) }}
          onPointerDown={(event) => { event.stopPropagation(); triggerProps.onPointerDown?.(event) }}
          onKeyDown={(event) => { event.stopPropagation(); triggerProps.onKeyDown?.(event) }}
        >{label}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={ariaLabel}>
        {items.filter(Boolean).filter(item => !item.hidden).map((item, index) => item === 'sep' || item.sep || item.key === 'sep'
          ? <DropdownMenuSeparator key={`sep-${index}`} />
          : item.as === 'check'
            ? <DropdownMenuCheckboxItem key={item.key} checked={!!item.checked} disabled={item.disabled} onCheckedChange={item.onCheckedChange} onSelect={item.onSelect}>{item.label}</DropdownMenuCheckboxItem>
            : <DropdownMenuItem key={item.key} danger={item.danger} disabled={item.disabled} onSelect={item.onSelect}>
                <span className="pk-menu-check" aria-hidden="true" />
                <span className="pk-menu-label">{item.label}</span>
                {item.hint && <span className="pk-menu-hint pk-mono">{item.hint}</span>}
              </DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* —— FloatingAction：悬浮主操作钮 ——
   取代各插件底部常驻操作条。主操作一眼可见，其余动作收进同一个菜单，
   底部不再固定占掉一条 40px 的高度。 */
export function FloatingAction({
  icon, label, onPrimary, items = [], disabled = false, hint, className = ''
}) {
  const extra = items.filter(Boolean)
  return (
    <div className={`pk-fab${className ? ` ${className}` : ''}`} data-pk-fab>
      {extra.length > 0 && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button type="button" className="pk-fab-extra" aria-label="更多操作" title="更多操作">⋯</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent aria-label="更多操作" side="top" align="end">
            {extra.map((item, index) => item === 'sep' || item.sep || item.key === 'sep'
              ? <DropdownMenuSeparator key={`sep-${index}`} />
              : <DropdownMenuItem key={item.key} danger={item.danger} disabled={item.disabled} onSelect={item.onSelect}>
                  <span className="pk-menu-check" aria-hidden="true" />
                  <span className="pk-menu-label">{item.label}</span>
                  {item.hint && <span className="pk-menu-hint pk-mono">{item.hint}</span>}
                </DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <button type="button" className="pk-fab-main" aria-label={label} title={hint ? `${label} · ${hint}` : label}
        disabled={disabled} onClick={onPrimary}>
        {icon}
      </button>
    </div>
  )
}

/* —— SettingsGear：设置齿轮 ——
   桌面端原地渲染为工具栏里的 ghost 钮（位置由插件自己的顶栏决定）。
   小窗口（quick）里顶栏空间有限，齿轮会把本该留给内容的头一行整条占掉，
   所以改为 portal 到 body、悬浮在右下角；显隐只由 <html data-mode> 决定，
   插件不需要订阅模式变化，shell ↔ quick 切换时也没有状态延迟。
   portal 而不是 position: fixed：不少插件的顶栏带 backdrop-filter，
   那会让 fixed 退化成相对顶栏定位，圆钮就落回顶部。 */
const PK_GEAR = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51-1Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
  export function SettingsGear({ onClick, className = '' }) {
    const extra = className ? ` ${className}` : ''
    return (
      <>
        <button type="button" className={`pk-btn pk-btn-ghost pk-set-trigger pk-set-bar${extra}`} title="设置" aria-label="打开设置" onClick={onClick}>
          {PK_GEAR}
        </button>
        {createPortal(
          <button type="button" className="pk-set-fab" title="设置" aria-label="打开设置" onClick={onClick}>{PK_GEAR}</button>,
          document.body
        )}
      </>
    )
  }
