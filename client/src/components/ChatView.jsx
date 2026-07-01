import { useRef, useEffect, useCallback, useState, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { useApp } from '../context/AppContext';
import { runAgent, getProjects, getProjectSessions, abortSession, reconnectSession, getSessionInfo, resolveQuestion, getSessionMessages } from '../api';
import ChatMessage from './ChatMessage';
import ChatInput from './ChatInput';
import ChatStatusBar from './ChatStatusBar';
import WelcomeScreen from './WelcomeScreen';
import ExecutionPanel from './ExecutionPanel';
import TaskPanel from './TaskPanel';
import ArtifactDrawer from './ArtifactDrawer';
import { IconPackage } from './icons';
// (icons reverted to emoji for chat view)

const PHASE_LABELS = {
  thinking: '思考',
  running: '工具调用',
  responding: '生成回复',
};

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function buildAbortSummary(execStatus) {
  const { phase, detail, elapsed, tokens, cost } = execStatus;
  const parts = [];

  if (phase && phase !== 'idle') {
    parts.push(`**阶段**: ${PHASE_LABELS[phase] || phase}`);
  }

  if (detail) {
    const idx = detail.indexOf(':');
    const toolName = idx > 0 ? detail.slice(0, idx) : '';
    const desc = idx > 0 ? detail.slice(idx + 1) : detail;
    if (phase === 'running' && toolName) {
      parts.push(`**正在执行**: \`${toolName}\` ${desc}`);
    } else if (phase === 'thinking') {
      parts.push(`**正在**: ${detail.length > 80 ? detail.slice(0, 80) + '…' : detail}`);
    }
  }

  if (elapsed > 0) {
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    parts.push(`**耗时**: ${mins > 0 ? `${mins}m ` : ''}${secs}s`);
  }

  if (tokens) {
    const tokParts = [];
    if (tokens.input) tokParts.push(`输入 ${tokens.input >= 1000 ? (tokens.input/1000).toFixed(1)+'k' : tokens.input}`);
    if (tokens.output) tokParts.push(`输出 ${tokens.output >= 1000 ? (tokens.output/1000).toFixed(1)+'k' : tokens.output}`);
    if (tokens.cacheRead) tokParts.push(`缓存读 ${tokens.cacheRead >= 1000 ? (tokens.cacheRead/1000).toFixed(1)+'k' : tokens.cacheRead}`);
    if (tokParts.length) parts.push(`**Tokens**: ${tokParts.join(' / ')}`);
  }

  if (cost != null) {
    parts.push(`**花费**: $${cost.toFixed(4)}`);
  }

  if (parts.length === 0) return '⏹ 已中止';
  return `⏹ **已中止** | ${parts.join(' | ')}`;
}

export default function ChatView() {
  const {
    chatMessages, setMessages, appendMessage, updateLastMessage,
    isStreaming, setStreaming, currentProjectId, currentSessionId,
    model, systemPrompt, setSessionId, projects,
    setProjects, setSessions, permissionLevel,
    execStart, execPhase, execTick, execTokens, execDone, execReset,
    addTask, bindTaskId, updateTask, setMainTask, updateMainTask, execStatus,
    currentModel, finishAllStreaming, finalizeStreaming, streamStart, streamEnd, setSessionExecStatus,
  } = useApp();
  const containerRef = useRef(null);
  const hasAssistantText = useRef(false);
  const textAccum = useRef('');
  const hasThinking = useRef(false);
  const timerRef = useRef(null);
  const execIdRef = useRef(0);  // increments each execution, used to ignore stale errors
  const execIdMapRef = useRef(new Map()); // sessionId → myExecId, 每个会话独立防重入
  const abortRef = useRef(null);  // AbortController for SSE stream, aborted on session switch
  const abortSessionRef = useRef(null);  // which session the abortRef belongs to
  const allAbortsRef = useRef(new Map()); // sessionId → AbortController, 管理所有并发会话的流
  const isActiveStream = useRef(false);  // true during active SSE stream, guards cleanup abort
  const isStreamingRef = useRef(null);   // tracks the sessionId that is currently streaming, null if idle
  const sendingRef = useRef(false);        // send lock — prevents concurrent handleSend calls
  const fromQueueRef = useRef(false);       // true when handleSend is called by onDone queue consumer (not user-initiated)
  const throttleRef = useRef(null);  // setTimeout id for bUpdate throttling during responding phase
  const toolNameMap = useRef(new Map());  // tool_use_id → tool name, for result display
  const filePathMap = useRef(new Map());  // tool_use_id → file_path, populated in onToolUse, read in onToolResult (avoids React state race)
  const streamSessionIdRef = useRef(null);  // sessionId of active stream; used by bAppend/bUpdate/setMessages to route messages to correct cache
  // 仅在 isStreaming 变化时更新 ref，避免切会话时被 currentSessionId 覆盖
  const prevStreaming = useRef(false);
  if (isStreaming && !prevStreaming.current) {
    isStreamingRef.current = currentSessionId;  // 记录是哪个会话开始的流式
  } else if (!isStreaming && prevStreaming.current) {
    isStreamingRef.current = null;  // 流式结束，清零
  }
  prevStreaming.current = isStreaming;
  const [askUser, setAskUser] = useState(null);
  const [toolConfirm, setToolConfirm] = useState(null); // { tool, action, input } — separate from askUser
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [activeSkill, setActiveSkill] = useState(null); // { name, displayName, icon }
  const [queuedMessages, setQueuedMessages] = useState([]); // 排队中的消息
  const [drawerOpen, setDrawerOpen] = useState(false);
  const currentProject = projects.find(p => p.id === currentProjectId);
  const projectCwd = currentProject?.cwd || '';
  const pendingQueue = useRef([]); // 消息队列 ref，驱动自动发送
  const askRef = useRef(null);
  const chatMessagesRef = useRef(chatMessages);
  chatMessagesRef.current = chatMessages;
  const artifactFilesRef = useRef(new Map());  // path → fileName, deduped artifacts created this session
  const skipScrollRef = useRef(false);
  const scrollRestoreRef = useRef(null);
  const [atTop, setAtTop] = useState(false);
  const loadedCountRef = useRef(0);

  // Message buffer for AskUserQuestion — hide Claude output until user answers
  const askBufferRef = useRef([]);
  const isAskBuffered = useRef(false);
  const appendRef = useRef(appendMessage);
  const updateRef = useRef(updateLastMessage);
  appendRef.current = appendMessage;
  updateRef.current = updateLastMessage;

  // Helper: buffered append/update
  const bAppend = (msg) => {
    if (isAskBuffered.current && askRef.current) {
      askBufferRef.current.push(msg);
    } else {
      appendRef.current(msg, streamSessionIdRef.current);
    }
  };
  const bUpdate = (content) => {
    if (isAskBuffered.current && askRef.current) {
      const buf = askBufferRef.current;
      if (buf.length > 0 && buf[buf.length - 1].role === 'assistant') {
        buf[buf.length - 1] = { ...buf[buf.length - 1], content, streaming: true };
      }
    } else {
      updateRef.current(content, streamSessionIdRef.current);
    }
  };

  // Auto-scroll when ask dialog or tool confirm appears
  useEffect(() => {
    if ((askUser || toolConfirm) && askRef.current) {
      askRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      isAskBuffered.current = true;
    }
  }, [askUser, toolConfirm]);

  // Track how many messages are loaded
  useEffect(() => {
    loadedCountRef.current = chatMessages.length;
  }, [chatMessages.length]);

  const handleLoadMore = useCallback(async () => {
    if (!currentSessionId || loadingMore) return;
    setLoadingMore(true);
    // Save scroll position before loading
    if (containerRef.current) {
      scrollRestoreRef.current = {
        scrollHeight: containerRef.current.scrollHeight,
        scrollTop: containerRef.current.scrollTop,
      };
    }
    const offset = loadedCountRef.current;
    try {
      const msgs = await getSessionMessages(currentSessionId, offset);
      if (msgs.length === 0) { setHasMore(false); setLoadingMore(false); return; }
      // 后端每次返回固定 20 条文本消息，不足 20 条说明已到文件开头
      if (msgs.length < 20) { setHasMore(false); }
      // Convert server messages to chat format
      const olderMsgs = [];
      for (const m of msgs) {
        const content = m.message?.content;
        const ts = m.timestamp ? new Date(m.timestamp).getTime() : null;
        if (typeof content === 'string' && content.trim()) {
          olderMsgs.push({ role: 'user', content, ...(ts && { timestamp: ts }) });
          continue;
        }
        if (!Array.isArray(content)) continue;
        const textBlocks = content.filter(c => c.type === 'text');
        if (textBlocks.length > 0) {
          const text = textBlocks.map(c => c.text).join('');
          olderMsgs.push({ role: m.type === 'user' ? 'user' : 'assistant', content: text, ...(ts && { timestamp: ts }) });
        }
      }
      // Prepend older messages
      if (olderMsgs.length > 0) {
        const currentMsgs = chatMessagesRef.current || chatMessages;
        skipScrollRef.current = true;
        flushSync(() => {
          setMessages([...olderMsgs, ...currentMsgs]);
        });
        // Immediately correct scroll (useLayoutEffect also does this as backup)
        if (containerRef.current && scrollRestoreRef.current) {
          const { scrollHeight: oldH, scrollTop: oldS } = scrollRestoreRef.current;
          containerRef.current.scrollTo({ top: oldS + (containerRef.current.scrollHeight - oldH), behavior: "instant" });
        }
        scrollRestoreRef.current = null; // consumed
      } else {
        setHasMore(false);
      }
    } catch { setHasMore(false); }
    setLoadingMore(false);
  }, [currentSessionId, loadingMore, setMessages]);

  // ── Scroll behavior ──
  //
  // atBottomRef: true when user is at the bottom. ONLY modified by:
  //   scroll events / session reset / button click.
  //
  // Strategy split by streaming state:
  //   NOT streaming: useLayoutEffect + useEffect handle one-shot scrolls.
  //                  Instant for session switch, browser-smooth for messages.
  //   STREAMING:     custom rAF easing loop (scrollRaf). Continuously reads
  //                  LIVE scrollHeight so typewriter/waterfall growth in
  //                  MarkdownRenderer is always tracked. Browser smooth scroll
  //                  targets a stale height — only our own rAF can keep up.
  //
  const atBottomRef = useRef(true);
  const lastScrollHeightRef = useRef(0);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const btnTimerRef = useRef(null);
  const lastScrollTopRef = useRef(0);
  const scrollRafRef = useRef(null);
  const isAutoScrolling = useRef(false);

  // Reset on session switch — always start at bottom (MUST be before scroll effect)
  useEffect(() => {
    atBottomRef.current = true;
    lastScrollHeightRef.current = 0;
    setShowScrollBtn(false);
    clearTimeout(btnTimerRef.current);
    btnTimerRef.current = null;
  }, [currentSessionId]);

  // Scroll event handler — track atBottom + delayed button
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;

      // During rAF-driven scroll, suppress atBottomRef / lastScrollTopRef to
      // avoid corrupting the rAF loop's intervention detection. The rAF loop
      // is the sole authority during auto-scrolling.
      if (isAutoScrolling.current) {
        if (dist < 3) {
          isAutoScrolling.current = false;
          atBottomRef.current = true;
        }
        return;
      }

      lastScrollTopRef.current = el.scrollTop;

      // Only show load-more when scrolled to exact top AND content overflows.
      // scrollTop < 20 causes oscillation: on short conversations the load-more
      // button appearing adds ~40px creating scrollable area, hiding the button,
      // removing height, showing button again — an infinite re-render loop.
      setAtTop(el.scrollTop === 0 && el.scrollHeight > el.clientHeight);
      atBottomRef.current = dist < 80;

      if (dist >= 80) {
        if (!btnTimerRef.current) {
          btnTimerRef.current = setTimeout(() => setShowScrollBtn(true), 300);
        }
      } else {
        clearTimeout(btnTimerRef.current);
        btnTimerRef.current = null;
        setShowScrollBtn(false);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      clearTimeout(btnTimerRef.current);
    };
  }, []);

  // ── rAF smooth-scroll loop (streaming only) ──
  // Continuously eases toward LIVE scrollHeight so typewriter/waterfall
  // growth is always tracked. Browser smooth scroll targets a stale height.
  // Sets isAutoScrolling while actively scrolling to prevent scroll events
  // from corrupting atBottomRef (which would stop the chase prematurely).
  // Detects user intervention via scrollTop decrease and stops.
  useEffect(() => {
    if (!isStreaming) {
      if (scrollRafRef.current) { cancelAnimationFrame(scrollRafRef.current); scrollRafRef.current = null; }
      isAutoScrolling.current = false;
      return;
    }
    let active = true;
    const tick = () => {
      if (!active) return;
      const el = containerRef.current;
      if (!el) { scrollRafRef.current = requestAnimationFrame(tick); return; }

      const sh = el.scrollHeight;
      const st = el.scrollTop;

      // User scrolled up — stop auto-following, but keep polling
      if (st < lastScrollTopRef.current - 3) {
        isAutoScrolling.current = false;
        atBottomRef.current = false;
        if (!btnTimerRef.current) {
          btnTimerRef.current = setTimeout(() => setShowScrollBtn(true), 300);
        }
        lastScrollTopRef.current = st;
        scrollRafRef.current = requestAnimationFrame(tick);
        return; // skip this tick, keep polling
      }
      lastScrollTopRef.current = st;

      // At bottom flag is false — user scrolled up, idle until they scroll back
      if (!atBottomRef.current) {
        scrollRafRef.current = requestAnimationFrame(tick);
        return;
      }

      const dist = sh - st - el.clientHeight;
      if (dist < 1) {
        // At bottom — clear auto-scroll flag, scroll event will confirm
        isAutoScrolling.current = false;
        lastScrollHeightRef.current = sh;
        scrollRafRef.current = requestAnimationFrame(tick);
        return;
      }

      // Custom easing toward live scrollHeight
      isAutoScrolling.current = true;
      lastScrollHeightRef.current = sh;
      const step = Math.max(2, Math.ceil(dist * 0.12));
      el.scrollTop = st + step;

      scrollRafRef.current = requestAnimationFrame(tick);
    };
    scrollRafRef.current = requestAnimationFrame(tick);
    return () => { active = false; cancelAnimationFrame(scrollRafRef.current); };
  }, [isStreaming]);

  // ── Helper: instant scroll to bottom ──
  const scrollToBottomInstant = () => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
  };

  // Auto-scroll on content growth (non-streaming: session switch, etc.)
  // During streaming, the rAF loop above handles everything; we only handle
  // the first-frame instant jump after session switch.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sh = el.scrollHeight;
    if (sh === lastScrollHeightRef.current) return;

    const isFirstScroll = lastScrollHeightRef.current === 0;
    lastScrollHeightRef.current = sh;

    // During streaming, rAF loop handles it — skip except first scroll
    if (isStreaming) {
      if (isFirstScroll && atBottomRef.current) {
        el.scrollTo({ top: sh, behavior: 'instant' });
      }
      return;
    }

    if (atBottomRef.current) {
      if (isFirstScroll) {
        el.scrollTo({ top: sh, behavior: 'instant' });
      } else {
        el.scrollTo({ top: sh, behavior: 'smooth' });
      }
    }
  });

  // Auto-scroll on new messages (non-streaming path; streaming uses rAF)
  useEffect(() => {
    if (skipScrollRef.current) { skipScrollRef.current = false; return; }
    if (isStreaming) return; // rAF loop handles streaming
    if (containerRef.current && atBottomRef.current) {
      containerRef.current.scrollTo({ top: containerRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [chatMessages]);

  // Restore scroll after prepending (backup for flushSync path)
  useLayoutEffect(() => {
    if (!scrollRestoreRef.current) return;
    const el = containerRef.current;
    if (el) {
      const { scrollHeight: oldH, scrollTop: oldS } = scrollRestoreRef.current;
      el.scrollTo({ top: oldS + (el.scrollHeight - oldH), behavior: 'instant' });
    }
    scrollRestoreRef.current = null;
  }, [chatMessages]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // 切会话时保留旧会话的 SSE 连接在后台运行
  // 不 abort — 让旧会话自然完成，onDone 会触发 streamEnd 正确清理计数
  useEffect(() => {
    return () => {
      if (throttleRef.current) { clearTimeout(throttleRef.current); throttleRef.current = null; }
      pendingQueue.current = [];
      setQueuedMessages([]);
    };
  }, [currentSessionId]);

  // Reconnect to running session after page refresh
  // Skip initial load — only check when session was manually selected or after reconnect
  const reconnectGuardRef = useRef(true); // true = skip first N seconds
  useEffect(() => {
    // Allow reconnect checks after initial page load settles
    const timer = setTimeout(() => { reconnectGuardRef.current = false; }, 3000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!currentSessionId) return;
    // Already streaming (e.g. handleSend), don't reconnect
    if (isStreaming) return;
    // Skip reconnect check during initial page load to avoid adding to connection pool
    if (reconnectGuardRef.current) return;
    let cancelled = false;

    getSessionInfo(currentSessionId).then(info => {
      if (cancelled || info.status !== 'busy') return;
      // Session is still running — reconnect to the live stream
      setStreaming(true);
      execStart();
      startTimer();
      hasAssistantText.current = false;
      textAccum.current = '';

      reconnectSession(currentSessionId).then(response => {
        if (cancelled || !response.ok) {
          setStreaming(false);
          stopTimer();
          execReset();
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';

        function pump() {
          if (cancelled) return;
          reader.read().then(({ done, value }) => {
            if (done || cancelled) {
              setStreaming(false);
              stopTimer();
              return;
            }
            if (value) {
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('event: ')) {
                  currentEvent = line.slice(7).trim();
                } else if (line.startsWith('data: ')) {
                  try {
                    const parsed = JSON.parse(line.slice(6));
                    if (currentEvent === 'message') {
                      if (parsed.type === 'assistant') {
                        const textBlocks = (parsed.message?.content || []).filter(c => c.type === 'text');
                        const toolBlocks = (parsed.message?.content || []).filter(c => c.type === 'tool_use');
                        const thinkingBlocks = (parsed.message?.content || []).filter(c => c.type === 'thinking');
                        if (thinkingBlocks.length > 0) {
                          const thinkingText = thinkingBlocks.map(t => t.thinking).join('\n');
                          bAppend({ role: 'thinking', content: thinkingText, timestamp: Date.now() });
                        }
                        if (textBlocks.length > 0) {
                          const text = textBlocks.map(c => c.text).join('');
                          if (!hasAssistantText.current) {
                            hasAssistantText.current = true;
                            textAccum.current = text;
                            bAppend({ role: 'assistant', content: text, streaming: true, timestamp: Date.now() });
                          } else {
                            textAccum.current += text;
                            if (!throttleRef.current) {
                              bUpdate(textAccum.current);
                              throttleRef.current = setTimeout(() => {
                                throttleRef.current = null;
                                bUpdate(textAccum.current);
                              }, 150);
                            }
                          }
                          execPhase({ phase: 'responding', detail: '' });
                        }
                        if (toolBlocks.length > 0) {
                          hasAssistantText.current = false;
                          toolBlocks.forEach(t => {
                            // Track tool name for result display
                            toolNameMap.current.set(t.id, t.name);
                            // Track file_path for Write artifacts
                            if (t.name === 'Write' && t.input?.file_path) filePathMap.current.set(t.id, t.input.file_path);
                            // Track tasks during reconnect
                            if (t.name === 'TaskCreate') {
                              addTask(t.input?.subject || '', t.input?.description || '', t.id);
                            } else if (t.name === 'TaskUpdate') {
                              updateTask(t.input?.taskId || '', t.input?.status || 'pending');
                            }
                            const desc = t.input?.description || t.input?.command || t.input?.file_path || '';
                            execPhase({ phase: 'running', detail: `${t.name}:${desc}` });
                            bAppend({ role: 'tool', toolCall: { name: t.name, input: t.input, tool_use_id: t.id }, timestamp: Date.now() });
                          });
                        }
                        if (parsed.message?.usage) execTokens(toTokens(parsed.message.usage));
                      } else if (parsed.type === 'user') {
                        const toolResults = (parsed.message?.content || []).filter(c => c.type === 'tool_result');
                        const sseExtractedPaths = parsed.extractedPaths || {};
                        toolResults.forEach(t => {
                          let text = typeof t.content === 'string' ? t.content : JSON.stringify(t.content || '');
                          const taskMatch = typeof text === 'string' && text.match(/^Task #(\d+)/m);
                          if (taskMatch) bindTaskId(t.tool_use_id, parseInt(taskMatch[1]));
                          const tName = toolNameMap.current.get(t.tool_use_id) || '';
                          const extractedPaths = sseExtractedPaths[t.tool_use_id] || [];
                          const isCompactTool = /^(Write|Edit|TaskCreate|TaskUpdate|Task)$/.test(tName);
                          const hasBashPaths = tName === 'Bash' && extractedPaths.length > 0;
                          const hasWritePaths = tName === 'Write' && extractedPaths.length > 0;
                          // Collect artifact files for end-of-session summary
                          if (tName === 'Write') {
                            if (extractedPaths.length > 0) {
                              extractedPaths.forEach(p => artifactFilesRef.current.set(p, p.split('/').pop() || p));
                            } else {
                              const fp = filePathMap.current.get(t.tool_use_id);
                              if (fp && !t.is_error) { artifactFilesRef.current.set(fp, fp.split('/').pop() || fp); filePathMap.current.delete(t.tool_use_id); }
                            }
                          }
                          if (hasBashPaths && !t.is_error) {
                            extractedPaths.forEach(p => artifactFilesRef.current.set(p, p.split('/').pop() || p));
                          }
                          // Write/Edit/Task/Bash(有产物)：合并到工具调用消息，代码块底部内嵌显示
                          if (isCompactTool || hasBashPaths || hasWritePaths) {
                            const msgs = [...chatMessagesRef.current];
                            const idx = msgs.findIndex(m => m.role === 'tool' && m.toolCall?.tool_use_id === t.tool_use_id);
                            if (idx >= 0) {
                              const filePath = msgs[idx].toolCall?.input?.file_path || null;
                              msgs[idx] = { ...msgs[idx], streaming: false, toolCall: { ...msgs[idx].toolCall, result: { content: text, is_error: t.is_error, toolName: tName, filePath, extractedPaths } } };
                              setMessages(msgs);
                              return;
                            }
                          }
                          bAppend({ role: 'tool', toolResult: { tool_use_id: t.tool_use_id, content: text, is_error: t.is_error, toolName: tName }, timestamp: Date.now() });
                        });
                      }
                    } else if (currentEvent === 'tool_confirm') {
                      setToolConfirm({ tool: parsed.tool, action: parsed.action, input: parsed.input });
                    } else if (currentEvent === 'done') {
                      if (throttleRef.current) { clearTimeout(throttleRef.current); throttleRef.current = null; }
                      finalizeStreaming();
                      stopTimer();
                      execDone({ tokens: parsed.tokens, cost: parsed.cost, currency: parsed.currency });
                      // Append artifact summary from backend-collected files
                      if (parsed.artifactFiles && parsed.artifactFiles.length > 0) {
                        bAppend({ role: 'artifacts', files: parsed.artifactFiles, timestamp: Date.now() });
                      }
                      setTimeout(() => execReset(), 5000);
                      return; // stop pumping
                    } else if (currentEvent === 'error') {
                      setStreaming(false);
                      stopTimer();
                      execReset();
                      bAppend({ role: 'system', content: `重连失败: ${parsed.message}`, timestamp: Date.now() });
                      return;
                    } else if (currentEvent === 'system_notice') {
                      bAppend({ role: 'system', content: parsed.text || '', timestamp: Date.now() });
                    }
                  } catch {}
                  currentEvent = '';
                }
              }
            }
            pump(); // continue reading
          }).catch(() => {
            if (!cancelled) {
              setStreaming(false);
              stopTimer();
              execReset();
            }
          });
        }
        pump();
      }).catch(() => {
        if (!cancelled) { setStreaming(false); stopTimer(); execReset(); }
      });
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [currentSessionId]);

  const startTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => execTick(), 1000);
  }, [execTick]);

  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  const toTokens = (sdkUsage) => sdkUsage ? {
    input: sdkUsage.input_tokens || 0,
    output: sdkUsage.output_tokens || 0,
    cacheRead: sdkUsage.cache_read_input_tokens || 0,
    cacheWrite: sdkUsage.cache_creation_input_tokens || 0,
  } : null;

  // 清空排队消息
  const clearPendingQueue = useCallback(() => {
    pendingQueue.current = [];
    setQueuedMessages([]);
  }, []);

  // Ref to handleSend — avoids TDZ because handlePrioritize is declared before handleSend
  const handleSendRef = useRef(null);

  // 优先插入排队消息：中断当前任务，立即发送该消息
  const handlePrioritize = useCallback(async (idx) => {
    const item = pendingQueue.current[idx];
    if (!item) return;
    // 从队列中移除该项
    pendingQueue.current.splice(idx, 1);
    setQueuedMessages([...pendingQueue.current]);
    // 释放发送锁 + 中断当前执行
    sendingRef.current = false;
    ++execIdRef.current;
    stopTimer();
    if (throttleRef.current) { clearTimeout(throttleRef.current); throttleRef.current = null; }
    if (currentSessionId) {
      try { await abortSession(currentSessionId); } catch {}
    }
    finalizeStreaming();
    // 等待后端中断完成后再发送插队消息
    setTimeout(() => handleSendRef.current?.(item.text), 500);
  }, [currentSessionId]);

  const handleStop = useCallback((execStatus) => {
    sendingRef.current = false;  // release send lock
    allAbortsRef.current.get(currentSessionId)?.abort();
    allAbortsRef.current.delete(currentSessionId);
    streamEnd(currentSessionId);
    ++execIdRef.current;  // bump so stale SSE errors are ignored
    stopTimer();
    clearPendingQueue();  // 清空排队消息
    if (throttleRef.current) { clearTimeout(throttleRef.current); throttleRef.current = null; }
    finalizeStreaming();  // 原子操作: 关闭所有 streaming + 保存缓存

    // Append artifact summary if any files were created before stopping
    if (artifactFilesRef.current.size > 0) {
      const files = Array.from(artifactFilesRef.current.entries()).map(([path, name]) => ({ path, name }));
      artifactFilesRef.current.clear();
      bAppend({ role: 'artifacts', files, timestamp: Date.now() });
    }

    // Append a summary system message
    const summary = buildAbortSummary(execStatus);
    bAppend({ role: 'system', content: summary, timestamp: Date.now() });

    execReset();
  }, [stopTimer, updateLastMessage, setStreaming, appendMessage, execReset, clearPendingQueue, finalizeStreaming]);

  const handleSend = useCallback((text, attachments) => {
    if (!text.trim() && (!attachments || attachments.length === 0)) return;

    // 防重入锁 — 防止同一个 handleSend 被并发调用
    if (sendingRef.current) return;

    // 同一会话正在执行 → 排队；不同会话/null → 允许
    if (currentSessionId && isStreamingRef.current === currentSessionId) {
      const item = { text: text.trim(), timestamp: Date.now() };
      if (fromQueueRef.current) {
        pendingQueue.current.unshift(item);
      } else {
        pendingQueue.current.push(item);
      }
      setQueuedMessages([...pendingQueue.current]);
      return;
    }
    sendingRef.current = true;

    // Capture session context early (must be before execIdMapRef.set)
    const project = projects.find(p => p.id === currentProjectId);
    const cwd = project?.cwd || '/root';
    const sessionId = currentSessionId || 'new';
    const mySessionId = sessionId;

    // Bump execution ID so stale SSE errors from previous run are ignored
    const myExecId = ++execIdRef.current;
    execIdMapRef.current.set(mySessionId, myExecId);
    setStreaming(true);
    execStart();

    // Strip slash-command prefix from prompt when skill is active (skill already applied via system prompt)
    let promptText = text;
    if (activeSkill) {
      const prefix = '/' + activeSkill.name + ' ';
      if (promptText.startsWith(prefix)) promptText = promptText.slice(prefix.length).trim();
      else if (promptText.startsWith('/' + activeSkill.name)) promptText = promptText.slice(activeSkill.name.length + 1).trim();
    }

    setMainTask(promptText.length > 30 ? promptText.slice(0, 30) + '…' : promptText);
    startTimer();

    streamSessionIdRef.current = mySessionId;
    const lbAppend = (msg) => appendMessage(msg, mySessionId);
    const lbUpdate = (content) => updateLastMessage(content, mySessionId);
    const lbExecUpdate = (phase, detail) => setSessionExecStatus(mySessionId, phase, detail);
    // 仅当前会话更新全局 execStatus（ExecutionBar 等）
    const lbExecPhase = (payload) => { if (mySessionId === currentSessionId) execPhase(payload); };
    const lbExecTokens = (payload) => { if (mySessionId === currentSessionId) execTokens(payload); };

    // Build user message content — attachment metadata rendered separately in ChatMessage
    let userContent = promptText || <>📎 发送了附件</>;
    bAppend({ role: 'user', content: userContent, attachments: attachments || null, timestamp: Date.now() });
    hasAssistantText.current = false;
    textAccum.current = '';
    hasThinking.current = false;
    textAccum.current = '';

    // Abort any previous stream and create a new AbortController for this send
    // 同会话重发：中止旧流；不同会话：旧流在 allAbortsRef 中继续后台运行
    const oldAbort = allAbortsRef.current.get(mySessionId);
    if (oldAbort) {
      oldAbort.abort();
      streamEnd(mySessionId);
    }
    const abort = new AbortController();
    allAbortsRef.current.set(mySessionId, abort);
    abortRef.current = abort;
    abortSessionRef.current = mySessionId;

    artifactFilesRef.current.clear();
    filePathMap.current.clear();
    isActiveStream.current = true;
    streamStart(sessionId);
    runAgent({
      sessionId,
      cwd,
      signal: abort.signal,
      prompt: promptText,
      attachments: attachments || undefined,
      options: { model: currentModel || model, systemPrompt: systemPrompt || undefined, permissionLevel, ...(activeSkill ? { activeSkill: activeSkill.name } : {}) },
      onThinking: ({ text: thinkingText, usage }) => {
        lbExecPhase({ phase: 'thinking', detail: thinkingText });
        lbExecUpdate('thinking', thinkingText);
        if (usage) lbExecTokens(toTokens(usage));
        hasAssistantText.current = false;  // 防止跨消息状态污染
        lbAppend({ role: 'thinking', content: thinkingText, streaming: true, timestamp: Date.now() });
      },
      onSession: ({ sessionId }) => {
        // Receive sessionId from server as early as the system message
        if (sessionId && !currentSessionId) {
          streamSessionIdRef.current = sessionId;
          setSessionId(sessionId);
          getProjects().then(setProjects).catch(() => {});
          if (currentProjectId) {
            getProjectSessions(currentProjectId).then(setSessions).catch(() => {});
          }
        }
      },
      onAssistant: ({ content, usage, session_id }) => {
        hasThinking.current = false;  // 防止跨消息状态污染
        // Reload session list as soon as we have the session ID for new sessions
        if (session_id && !currentSessionId) {
          streamSessionIdRef.current = session_id;  // 立即更新 ref，让后续 SSE 事件路由到正确的 session
          setSessionId(session_id);
          getProjects().then(setProjects).catch(() => {});
          if (currentProjectId) {
            getProjectSessions(currentProjectId).then(setSessions).catch(() => {});
          }
        }
        if (!hasAssistantText.current) {
          hasAssistantText.current = true;
          textAccum.current = content;
          lbAppend({ role: 'assistant', content, streaming: true, timestamp: Date.now() });
        } else {
          textAccum.current += content;
          // 节流：100ms 内最多触发一次 React re-render，避免 MarkdownRenderer 每帧重解析全文
          if (!throttleRef.current) {
            lbUpdate(textAccum.current);
            throttleRef.current = setTimeout(() => {
              throttleRef.current = null;
              lbUpdate(textAccum.current);  // flush 最终累积状态
            }, 150);
          }
        }
        lbExecPhase({ phase: 'responding', detail: '' });
        lbExecUpdate('responding', '');
        if (usage) lbExecTokens(toTokens(usage));
      },
      onToolUse: ({ tool, input, tool_use_id, usage }) => {
        hasAssistantText.current = false;
        hasThinking.current = false;
        // Track tool name for result display
        toolNameMap.current.set(tool_use_id, tool);
        // Track file_path for Write artifacts (avoid React state race in onToolResult)
        if (tool === 'Write' && input?.file_path) filePathMap.current.set(tool_use_id, input.file_path);
        // Track tasks
        if (tool === 'TaskCreate') {
          addTask(input?.subject || '', input?.description || '', tool_use_id);
        } else if (tool === 'TaskUpdate') {
          updateTask(input?.taskId || '', input?.status || 'pending');
        }
        const desc = input?.description || input?.command || input?.file_path || '';
        lbExecPhase({ phase: 'running', detail: `${tool}:${desc}` });
        lbExecUpdate('running', `${tool}:${desc}`);
        if (usage) lbExecTokens(toTokens(usage));
        lbAppend({ role: 'tool', toolCall: { name: tool, input, tool_use_id }, streaming: true });
      },
      onToolResult: ({ tool_use_id, content, is_error, extractedPaths }) => {
        // 从 TaskCreate 的 result 中解析 SDK 分配的真实 taskId（如 "Task #49"）
        if (typeof content === 'string') {
          const taskMatch = content.match(/^Task #(\d+)/m);
          if (taskMatch) bindTaskId(tool_use_id, parseInt(taskMatch[1]));
        }
        const toolName = toolNameMap.current.get(tool_use_id) || '';
        const isCompactTool = /^(Write|Edit|TaskCreate|TaskUpdate|Task)$/.test(toolName);
        const hasBashPaths = toolName === 'Bash' && extractedPaths && extractedPaths.length > 0;
        const hasWritePaths = toolName === 'Write' && extractedPaths && extractedPaths.length > 0;
        // Collect artifact files for end-of-session summary
        if (toolName === 'Write' && !is_error) {
          // Prefer server-resolved absolute paths from extractedPaths, fall back to filePathMap
          if (extractedPaths && extractedPaths.length > 0) {
            extractedPaths.forEach(p => artifactFilesRef.current.set(p, p.split('/').pop() || p));
          } else {
            const fp = filePathMap.current.get(tool_use_id);
            if (fp) { artifactFilesRef.current.set(fp, fp.split('/').pop() || fp); filePathMap.current.delete(tool_use_id); }
          }
        }
        if (hasBashPaths && !is_error) {
          extractedPaths.forEach(p => artifactFilesRef.current.set(p, p.split('/').pop() || p));
        }
        // Write/Edit/Task/Bash(有产物): merge result into tool call message
        if (isCompactTool || hasBashPaths || hasWritePaths) {
          const msgs = [...chatMessagesRef.current];
          const idx = msgs.findIndex(m => m.role === 'tool' && m.toolCall?.tool_use_id === tool_use_id);
          if (idx >= 0) {
            const filePath = msgs[idx].toolCall?.input?.file_path || null;
            msgs[idx] = { ...msgs[idx], streaming: false, toolCall: { ...msgs[idx].toolCall, result: { content: content || '', is_error, toolName, filePath, extractedPaths: extractedPaths || [] } } };
            setMessages(msgs, mySessionId);
            return;
          }
        }
        lbAppend({ role: 'tool', toolResult: { tool_use_id, content: content || '', is_error, toolName } });
      },
      onAskUser: ({ questions }) => {
        setAskUser({ questions });
      },
      onToolConfirm: ({ tool, action, input }) => {
        setToolConfirm({ tool, action, input });
      },
      onDone: ({ sessionId: newId, tokens: doneTokens, cost, currency, artifactFiles }) => {
        streamSessionIdRef.current = null;
        isActiveStream.current = false;
        allAbortsRef.current.delete(mySessionId);
        streamEnd(mySessionId);
        lbExecUpdate('done', '');
        sendingRef.current = false;

        // 同会话重发时忽略旧的 done 事件
        if (execIdMapRef.current.get(mySessionId) !== myExecId) return;
        if (throttleRef.current) { clearTimeout(throttleRef.current); throttleRef.current = null; }

        // 仅最后一个完成的会话更新全局 UI（避免 flickering）
        if (allAbortsRef.current.size > 0) return;

        finalizeStreaming();  // 原子操作: 关闭所有 streaming + 保存缓存 + 设置 isStreaming=false
        stopTimer();
        execDone({ tokens: doneTokens, cost, currency });
        // Append artifact summary from backend-collected files
        if (artifactFiles && artifactFiles.length > 0) {
          lbAppend({ role: 'artifacts', files: artifactFiles, timestamp: Date.now() });
        }
        setTimeout(() => execReset(), 5000);

        if (currentProjectId) {
          getProjectSessions(currentProjectId).then(setSessions).catch(() => {});
        }

        if (newId && !currentSessionId) {
          setSessionId(newId);
          getProjects().then(setProjects).catch(() => {});
          if (currentProjectId) {
            getProjectSessions(currentProjectId).then(setSessions).catch(() => {});
          }
        }

        // 检查排队消息，自动发送下一条
        const next = pendingQueue.current.shift();
        if (next) {
          setQueuedMessages([...pendingQueue.current]);
          fromQueueRef.current = true;
          setTimeout(() => {
            handleSend(next.text);
            fromQueueRef.current = false;
          }, 300);
        }
      },
      onTitle: ({ title }) => {
        if (title) updateMainTask(title);
      },
      onError: (err) => {
        streamSessionIdRef.current = null;
        isActiveStream.current = false;
        allAbortsRef.current.delete(mySessionId);
        streamEnd(mySessionId);
        lbExecUpdate('done', '');
        sendingRef.current = false;  // release send lock
        // Ignore errors from previous (aborted) executions
        if (execIdMapRef.current.get(mySessionId) !== myExecId) return;
        // AskUserQuestion abort is expected — don't show error
        if (askRef.current) return;
        if (throttleRef.current) { clearTimeout(throttleRef.current); throttleRef.current = null; }
        clearPendingQueue();  // 出错时清空排队消息
        setStreaming(false);
        stopTimer();
        execPhase({ phase: 'done', detail: err.message });
        setTimeout(() => execReset(), 5000);
        lbAppend({ role: 'system', content: `错误: ${err.message}` });
      },
    });
    sendingRef.current = false;  // 释放发送锁，允许其他会话并发发送
  }, [isStreaming, setStreaming, appendMessage, updateLastMessage, currentProjectId, currentSessionId, model, currentModel, systemPrompt, permissionLevel, setSessionId, projects, setProjects, setSessions, execStart, execPhase, execTick, execTokens, execDone, execReset, startTimer, stopTimer, activeSkill, addTask, bindTaskId, updateTask, setMainTask, updateMainTask]);
  handleSendRef.current = handleSend;

  const handleResolveAsk = useCallback((answers) => {
    if (!askUser || !currentSessionId) return;
    const vals = Object.values(answers.answers || answers);
    const text = vals.filter(Boolean).join('，');
    setAskUser(null);
    isAskBuffered.current = false;
    // Flush buffered messages
    const buf = askBufferRef.current;
    if (buf.length > 0) {
      buf.forEach(msg => appendRef.current(msg));
      askBufferRef.current = [];
    }
    if (text) {
      // Abort current SDK turn (canUseTool is unreliable),
      // then send answer as a new message via handleSend.
      abortSession(currentSessionId).catch(() => {});
      sendingRef.current = false;
      ++execIdRef.current;
      stopTimer();
      if (throttleRef.current) { clearTimeout(throttleRef.current); throttleRef.current = null; }
      finalizeStreaming();
      execReset();
      setTimeout(() => handleSend(text), 500);
    }
  }, [askUser, currentSessionId, handleSend, stopTimer, finalizeStreaming, execReset]);

  // Tool confirmation handler — separate from AskUserQuestion
  const handleToolConfirm = useCallback((allowed) => {
    if (!toolConfirm || !currentSessionId) return;
    const answer = allowed ? '允许' : '拒绝';
    resolveQuestion(currentSessionId, { answers: { q0: answer } }).catch(() => {});
    setToolConfirm(null);
  }, [toolConfirm, currentSessionId]);

  const hasMessages = chatMessages.length > 0;
  const askQs = askUser?.questions || [];

  return (
    <div className="chat-layout">
      <div className="chat-content">
        <div className="chat-main">
          <div className="chat-glass">
          <div className="chat-glass-inner">
          <div className="chat-container" ref={containerRef}>
          {hasMore && chatMessages.length > 0 && atTop && (
            <div className="load-more-row">
              <button className="load-more-btn" onClick={handleLoadMore} disabled={loadingMore}>
                {loadingMore ? '加载中...' : '加载更早的消息'}
              </button>
            </div>
          )}
          {!hasMessages && <WelcomeScreen />}
          {chatMessages.map((msg, i) => (
            <ChatMessage key={i} message={msg} />
          ))}
          {/* AskUserQuestion dialog — embedded in chat flow */}
          {askUser && (
            <div className="ask-user-dialog" ref={askRef}>
              <h4>💭 Claude 想确认几个问题</h4>
              {askQs.map((q, qi) => (
                <div key={qi} className="ask-user-question">
                  <p>{q.question || q.header || `问题 ${qi + 1}`}</p>
                  {q.options && q.options.length > 0 ? (
                    <div className="ask-user-options">
                      {q.options.map((opt, oi) => (
                        <label key={oi} className="ask-user-option">
                          <input
                            type={q.multiSelect ? 'checkbox' : 'radio'}
                            name={`q-${qi}`}
                            value={typeof opt === 'string' ? opt : opt.label || opt}
                            onChange={() => {}}
                          />
                          <span>{typeof opt === 'string' ? opt : opt.label || opt}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <input type="text" className="ask-user-input" placeholder="输入你的回答..." data-q={qi} />
                  )}
                </div>
              ))}
              <button className="ask-user-submit" onClick={() => {
                const collected = {};
                askQs.forEach((q, qi) => {
                  if (q.options && q.options.length > 0) {
                    if (q.multiSelect) {
                      const checked = document.querySelectorAll(`.ask-user-dialog input[name="q-${qi}"]:checked`);
                      collected[`q${qi}`] = Array.from(checked).map(c => c.value).join(', ');
                    } else {
                      const checked = document.querySelector(`.ask-user-dialog input[name="q-${qi}"]:checked`);
                      collected[`q${qi}`] = checked ? checked.value : '';
                    }
                  } else {
                    const inp = document.querySelector(`.ask-user-dialog [data-q="${qi}"]`);
                    collected[`q${qi}`] = inp ? inp.value : '';
                  }
                });
                handleResolveAsk({ answers: collected });
              }}>
                提交
              </button>
            </div>
          )}
          {/* Tool permission confirmation — same style as AskUserQuestion, separate logic */}
          {toolConfirm && (
            <div className="ask-user-dialog" ref={askRef}>
              <h4>🔒 {toolConfirm.action}</h4>
              <div className="confirm-buttons">
                <button className="confirm-btn-allow" onClick={() => handleToolConfirm(true)}>
                  允许
                </button>
                <button className="confirm-btn-deny" onClick={() => handleToolConfirm(false)}>
                  拒绝
                </button>
              </div>
            </div>
          )}
        </div>
        {/* Scroll-to-bottom button — floated above footer */}
        {hasMessages && showScrollBtn && (
          <div className="scroll-to-bottom-wrap">
          <button
            className="scroll-to-bottom-btn"
            onClick={() => {
              atBottomRef.current = true;
              setShowScrollBtn(false);
              scrollToBottomInstant();
            }}
          >
            ↓ 查看最新消息
          </button>
          </div>
        )}
        <ChatStatusBar />
        {currentSessionId && (
          <button
            className="artifact-trigger-btn"
            onClick={() => setDrawerOpen(v => !v)}
            title="产物文件"
          >
            <IconPackage />
            <span className="artifact-trigger-label">当前会话产物合集</span>
          </button>
        )}
        {currentSessionId && (
          <ArtifactDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} cwd={projectCwd} />
        )}
        </div>
        </div>
        </div>
        <div className="right-panels">
          <TaskPanel />
          <ExecutionPanel />
        </div>
      </div>
      <div className="input-row">
        <div className="input-row-spacer">
          <ChatInput onSend={handleSend} onStop={handleStop} activeSkill={activeSkill} onSkillChange={setActiveSkill} queuedMessages={queuedMessages} onRemoveQueued={(idx) => { pendingQueue.current.splice(idx, 1); setQueuedMessages([...pendingQueue.current]); }} onPrioritize={handlePrioritize} />
        </div>
      </div>
    </div>
  );
}
