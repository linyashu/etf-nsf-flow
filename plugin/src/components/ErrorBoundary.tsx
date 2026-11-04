import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 渲染异常时显示可读提示，而不是让整个 slot 变成空白。
 * 之前出现过 "h is not a function" 导致的白屏，边界能兜住这类问题。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[etf-nsf-flow] render error', error, info)
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="etfflow-root grid min-h-[240px] place-items-center p-6 text-center text-body text-etf-muted">
          <div>
            <div className="mb-2 font-semibold text-etf-text">看板渲染出错</div>
            <div className="text-meta opacity-85">
              {String(this.state.error.message || this.state.error)}
            </div>
            <button
              type="button"
              className="mt-3 cursor-pointer rounded-lg border border-etf-line1 bg-etf-layer1 px-3 py-2 text-meta font-medium text-etf-text hover:border-etf-line2"
              onClick={() => this.setState({ error: null })}
            >
              重试
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
