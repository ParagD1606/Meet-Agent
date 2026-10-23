import { Component, type ErrorInfo, type ReactNode } from "react"
import { Button } from "./button"
import { EmptyState } from "./empty"

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null; key?: string }> {
  override state = { error: null as Error | null, key: this.props.resetKey }
  static getDerivedStateFromError(error: Error) { return { error } }
  static getDerivedStateFromProps(p: { resetKey?: string }, s: { key?: string }) { return p.resetKey !== s.key ? { error: null, key: p.resetKey } : null }
  override componentDidCatch(error: Error, info: ErrorInfo) { console.error("[route error]", error, info.componentStack) }
  override render() {
    if (!this.state.error) return this.props.children
    return (
      <EmptyState icon="alert" title="This page hit an error" action={<Button onClick={() => this.setState({ error: null })}>Try again</Button>}>
        {this.state.error.message || "Something went wrong while rendering."}
      </EmptyState>
    )
  }
}
