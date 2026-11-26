/**
 * 顶层错误边界：渲染期出现未预料的异常时显示一条可读的错误，而不是整页白屏。
 * 文件操作类的错误走 toast，不经过这里。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '../ui/index'

interface Props {
  children: ReactNode
  onRetry?(): void
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[media-browser] 渲染出错', error, info.componentStack)
  }

  private reset = () => {
    this.setState({ error: null })
    this.props.onRetry?.()
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="mb-empty" role="alert">
        <p className="mb-empty-title">界面出了点问题</p>
        <p className="mb-empty-hint">{this.state.error.message || '发生了未知错误'}</p>
        <Button variant="primary" onClick={this.reset}>重试</Button>
      </div>
    )
  }
}
