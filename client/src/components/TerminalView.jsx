import { useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';

export default function TerminalView() {
  const { currentProjectId, projects } = useApp();
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const fitAddonRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let term;
    let ws;

    const initTerm = async () => {
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');

      await import('@xterm/xterm/css/xterm.css');

      term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace",
        theme: {
          background: '#1a1a2e',
          foreground: '#e0e0e0',
          cursor: '#6c63ff',
          selectionBackground: 'rgba(108, 99, 255, 0.3)',
        },
      });

      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      fitAddon.fit();

      termRef.current = term;

      // Determine WebSocket URL with actual cwd from project list
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      const project = projects.find(p => p.id === currentProjectId);
      const cwd = project?.cwd || '';
      const cwdParam = cwd ? `cwd=${encodeURIComponent(cwd)}` : '';
      const wsUrl = `${protocol}//${host}/api/terminal?${cwdParam}`;

      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        term.write('\x1b[32m● 终端已连接\x1b[0m\r\n\r\n');
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          term.write(event.data);
        }
      };

      ws.onclose = () => {
        term.write('\r\n\x1b[31m● 终端已断开\x1b[0m\r\n');
      };

      ws.onerror = () => {
        term.write('\r\n\x1b[31m● 连接错误\x1b[0m\r\n');
      };

      term.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      term.onResize(({ cols, rows }) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      });

      // Resize handler
      const handleResize = () => {
        fitAddon?.fit();
        if (ws?.readyState === WebSocket.OPEN && term) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      };
      window.addEventListener('resize', handleResize);

      return () => {
        window.removeEventListener('resize', handleResize);
      };
    };

    initTerm().catch(() => {
      if (containerRef.current) {
        containerRef.current.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted)">无法加载终端组件。请确保已安装 @xterm/xterm 依赖。</div>';
      }
    });

    return () => {
      ws?.close();
      term?.dispose();
    };
  }, [currentProjectId, projects]);

  return <div className="terminal-view" ref={containerRef} />;
}
