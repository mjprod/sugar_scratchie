import { Component, type ErrorInfo, type ReactNode } from "react";

type ChunkErrorBoundaryProps = {
  children: ReactNode;
  fallback: ReactNode;
  /** Changing this clears the error (e.g. pathname, so other routes still render). */
  resetKey?: unknown;
};

type ChunkErrorBoundaryState = {
  failed: boolean;
  resetKey: unknown;
};

/**
 * Renders `fallback` when a lazy chunk below fails to load (deploy skew, flaky
 * network) instead of unmounting the whole app. `React.lazy` caches the
 * rejection, so the same component can only recover through a full reload.
 */
export class ChunkErrorBoundary extends Component<
  ChunkErrorBoundaryProps,
  ChunkErrorBoundaryState
> {
  state: ChunkErrorBoundaryState = {
    failed: false,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(): Partial<ChunkErrorBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: ChunkErrorBoundaryProps,
    state: ChunkErrorBoundaryState,
  ): Partial<ChunkErrorBoundaryState> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { failed: false, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[ChunkErrorBoundary]", error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
