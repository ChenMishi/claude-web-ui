import { Component } from 'react';

// 全局错误边界：捕获 React 渲染/生命周期中的未处理异常，避免整个应用 unmount 白屏。
// 白屏时显示错误信息 + 刷新按钮，并把错误上报到服务端日志（带认证头）。
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    try {
      const accessToken = localStorage.getItem('claude-ui:accessToken');
      fetch('/api/init/log-error', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          message: `[ErrorBoundary] ${error?.message || String(error)}`,
          stack: error?.stack,
          url: location.href,
        }),
      }).catch(() => {});
    } catch {}
  }

  handleReload = () => {
    // 尝试恢复：重置错误状态，让 React 重新渲染子树
    this.setState({ hasError: false, error: null, info: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const { error, info } = this.state;
    const componentStack = info?.componentStack || '';

    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100vh', padding: '24px', textAlign: 'center', fontFamily: 'system-ui, sans-serif',
        background: '#1a1a2e', color: '#eee',
      }}>
        <div style={{ fontSize: '40px', marginBottom: '16px' }}>💥</div>
        <h2 style={{ margin: '0 0 8px', fontSize: '20px' }}>界面出了点问题</h2>
        <p style={{ margin: '0 0 16px', fontSize: '14px', opacity: 0.7, maxWidth: '600px', wordBreak: 'break-word' }}>
          {error?.message || String(error)}
        </p>
        {componentStack && (
          <pre style={{
            maxHeight: '120px', overflow: 'auto', fontSize: '11px', opacity: 0.5,
            padding: '8px', background: 'rgba(0,0,0,0.3)', borderRadius: '6px',
            margin: '0 0 20px', maxWidth: '600px', textAlign: 'left',
          }}>
            {componentStack.slice(0, 800)}
          </pre>
        )}
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: '8px 20px', borderRadius: '6px', border: 'none', cursor: 'pointer',
              background: '#4a9eff', color: '#fff', fontSize: '14px',
            }}
          >
            尝试恢复
          </button>
          <button
            type="button"
            onClick={() => location.reload()}
            style={{
              padding: '8px 20px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.3)',
              cursor: 'pointer', background: 'transparent', color: '#eee', fontSize: '14px',
            }}
          >
            刷新页面
          </button>
        </div>
      </div>
    );
  }
}
