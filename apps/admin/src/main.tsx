import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import './ui-refresh.css';

class AppErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('ADMIN_RENDER_FAILED', error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return <main className="mw-auth-recovery"><div><b>画面工作台暂时无法显示</b><p>{this.state.error.message}</p><button onClick={() => window.location.reload()}>重新加载中控</button></div></main>;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>,
);
