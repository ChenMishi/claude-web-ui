import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'

// 上报前端错误到服务端（带认证头，否则 /api/init/log-error 返回 401）
function reportError(message, stack) {
  try {
    const accessToken = localStorage.getItem('claude-ui:accessToken');
    fetch('/api/init/log-error', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ message, stack, url: location.href }),
    }).catch(() => {});
  } catch {}
}

// Global error logging to server
window.addEventListener('error', (e) => {
  reportError(e.message, e.error?.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  reportError(String(e.reason), null);
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
