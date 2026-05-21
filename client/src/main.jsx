import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

// Global error logging to server
window.addEventListener('error', (e) => {
  try {
    fetch('/api/init/log-error', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: e.message, stack: e.error?.stack, url: location.href }),
    }).catch(() => {});
  } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    fetch('/api/init/log-error', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: String(e.reason), url: location.href }),
    }).catch(() => {});
  } catch {}
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
