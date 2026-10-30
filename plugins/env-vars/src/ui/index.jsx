/**
 * pk-ui —— eNest 官方插件标准控件层（与壳 src/renderer/components/ui 同构）
 * 行为来自 Radix UI，视觉来自 pk-ui.css（themeAware token 直读）。
 * 本文件与 pk-ui.css 作为模板整体复制到各官方插件 src/ui/，随壳组件层升级同步。
 */
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
        className={`pk-select-trigger${className ? ` ${className}` : ''}`}
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
