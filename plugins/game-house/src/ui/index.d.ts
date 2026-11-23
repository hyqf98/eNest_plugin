import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode } from 'react'

export interface Option {
  value: string
  label: string
  disabled?: boolean
}

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: string
  size?: string
  pressed?: boolean
  asChild?: boolean
}): ReactElement

export function Input(props: InputHTMLAttributes<HTMLInputElement>): ReactElement

export function Checkbox(props: {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
}): ReactElement

export function Switch(props: {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
}): ReactElement

export function Segmented(props: {
  value: string
  options: Option[]
  onChange: (value: string) => void
  className?: string
  ariaLabel?: string
  disabled?: boolean
  role?: string
}): ReactElement

export function Select(props: {
  value: string
  options: Option[]
  onChange: (value: string) => void
  disabled?: boolean
  ariaLabel?: string
  hint?: string
  className?: string
  minWidth?: number
}): ReactElement

export function Tooltip(props: {
  content?: ReactNode
  children: ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  delayDuration?: number
}): ReactElement

export function TooltipProvider(props: { children?: ReactNode; delayDuration?: number }): ReactElement

export function Dialog(props: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  modal?: boolean
  children?: ReactNode
}): ReactElement

export function DialogOverlay(props: { className?: string }): ReactElement

export function DialogContent(props: {
  className?: string
  children?: ReactNode
  'aria-describedby'?: string
  onEscapeKeyDown?: (event: KeyboardEvent) => void
  onPointerDownOutside?: (event: Event) => void
}): ReactElement

export function DialogTitle(props: { className?: string; children?: ReactNode }): ReactElement

export function DialogDescription(props: { className?: string; id?: string; children?: ReactNode }): ReactElement

export function Slider(props: {
  value?: number[]
  onValueChange?: (value: number[]) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  className?: string
  'aria-label'?: string
}): ReactElement

export function MoreMenu(props: {
  label?: string
  ariaLabel?: string
  items?: Array<{ key?: string | 'sep'; label?: string; onSelect?: () => void; danger?: boolean; disabled?: boolean; separator?: boolean; checked?: boolean; sep?: boolean; hidden?: boolean; as?: string; hint?: string; onCheckedChange?: (checked: boolean) => void }>
  buttonClassName?: string
  disabled?: boolean
  triggerProps?: Record<string, unknown>
}): ReactElement
