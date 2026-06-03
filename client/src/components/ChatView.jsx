import { useRef, useEffect, useCallback, useState, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { useApp } from '../context/AppContext';
import { runAgent, getProjects, getProjectSessions, abortSession, reconnectSession, getSessionInfo, resolveQuestion, getSessionMessages } from '../api';
import ChatMessage from './ChatMessage';
import ChatInput from './ChatInput';
import WelcomeScreen from './WelcomeScreen';
import ExecutionPanel from './ExecutionPanel';
import TaskPanel from './TaskPanel';

const PHASE_LABELS = {
  thinking: '思考',
  running: '工具调用',
  responding: '生成回复',
};

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
    addTask, updateTask, setMainTask, updateMainTask, execStatus,
    currentModel,
  } = useApp();
  const containerRef = useRef(null);
  const hasAssistantText = useRef(false);
  const textAccum = useRef('');
  const timerRef = useRef(null);
  const execIdRef = useRef(0);  // increments each execution, used to ignore stale errors
  const abortRef = useRef(null);  // AbortController for SSE stream, aborted on session switch
  const [askUser, setAskUser] = useState(null);
  const [toolConfirm, setToolConfirm] = useState(null); // { tool, action, input } — separate from askUser
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [activeSkill, setActiveSkill] = useState(null); // { name, displayName, icon }
  const [queuedMessages, setQueuedMessages] = useState([]); // 排队中的消息
  const pendingQueue = useRef([]); // 消息队列 ref，驱动自动发送
  const askRef = useRef(null);
  const chatMessagesRef = useRef(chatMessages);
  chatMessagesRef.current = chatMessages;
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
      appendRef.current(msg);
    }
  };
  const bUpdate = (content) => {
    if (isAskBuffered.current && askRef.current) {
      const buf = askBufferRef.current;
      if (buf.length > 0 && buf[buf.length - 1].role === 'assistant') {
        buf[buf.length - 1] = { ...buf[buf.length - 1], content, streaming: true };
      }
    } else {
      updateRef.current(content);
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
          containerRef.current.scrollTop = oldS + (containerRef.current.scrollHeight - oldH);
        }
        scrollRestoreRef.current = null; // consumed
      } else {
        setHasMore(false);
      }
    } catch { setHasMore(false); }
    setLoadingMore(false);
  }, [currentSessionId, loadingMore, setMessages]);

  // Auto-scroll on new messages (skip when loading older messages)
  useEffect(() => {
    if (skipScrollRef.current) { skipScrollRef.current = false; return; }
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [chatMessages]);

  // Restore scroll after prepending (backup for flushSync path)
  useLayoutEffect(() => {
    if (!scrollRestoreRef.current) return;
    const el = containerRef.current;
    if (el) {
      const { scrollHeight: oldH, scrollTop: oldS } = scrollRestoreRef.current;
      el.scrollTop = oldS + (el.scrollHeight - oldH);
    }
    scrollRestoreRef.current = null;
  }, [chatMessages]);

  // Detect scroll to top
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      setAtTop(el.scrollTop < 20);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // Abort SSE stream when switching to a different session
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      // 切换会话时清空排队消息
      pendingQueue.current = [];
      setQueuedMessages([]);
    };
  }, [currentSessionId]);

  // Reconnect to running session after page refresh
  useEffect(() => {
    if (!currentSessionId) return;
    // Already streaming (e.g. handleSend), don't reconnect
    if (isStreaming) return;
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
                            bUpdate(textAccum.current);
                          }
                          execPhase({ phase: 'responding', detail: '' });
                        }
                        if (toolBlocks.length > 0) {
                          hasAssistantText.current = false;
                          toolBlocks.forEach(t => {
                            // Track tasks during reconnect
                            if (t.name === 'TaskCreate') {
                              addTask(t.input?.subject || '', t.input?.description || '');
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
                        toolResults.forEach(t => {
                          let text = typeof t.content === 'string' ? t.content : JSON.stringify(t.content || '');
                          bAppend({ role: 'tool', toolResult: { tool_use_id: t.tool_use_id, content: text, is_error: t.is_error }, timestamp: Date.now() });
                        });
                      }
                    } else if (currentEvent === 'tool_confirm') {
                      setToolConfirm({ tool: parsed.tool, action: parsed.action, input: parsed.input });
                    } else if (currentEvent === 'done') {
                      bUpdate(null);
                      setStreaming(false);
                      stopTimer();
                      execDone({ tokens: parsed.tokens, cost: parsed.cost, currency: parsed.currency });
                      setTimeout(() => execReset(), 5000);
                      return; // stop pumping
                    } else if (currentEvent === 'error') {
                      setStreaming(false);
                      stopTimer();
                      execReset();
                      bAppend({ role: 'system', content: `重连失败: ${parsed.message}`, timestamp: Date.now() });
                      return;
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

  const handleStop = useCallback((execStatus) => {
    ++execIdRef.current;  // bump so stale SSE errors are ignored
    stopTimer();
    clearPendingQueue();  // 清空排队消息

    // End streaming on last assistant message
    bUpdate(null);
    setStreaming(false);

    // Append a summary system message
    const summary = buildAbortSummary(execStatus);
    bAppend({ role: 'system', content: summary, timestamp: Date.now() });

    execReset();
  }, [stopTimer, updateLastMessage, setStreaming, appendMessage, execReset, clearPendingQueue]);

  const handleSend = useCallback((text) => {
    if (!text.trim()) return;

    // 如果正在执行中，不中断，改为排队等待
    if (isStreaming) {
      const item = { text: text.trim(), timestamp: Date.now() };
      pendingQueue.current.push(item);
      setQueuedMessages([...pendingQueue.current]);
      return;
    }

    // Bump execution ID so stale SSE errors from previous run are ignored
    const myExecId = ++execIdRef.current;
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
    bAppend({ role: 'user', content: promptText, timestamp: Date.now() });
    hasAssistantText.current = false;
    textAccum.current = '';

    const project = projects.find(p => p.id === currentProjectId);
    const cwd = project?.cwd || '/root';
    const sessionId = currentSessionId || 'new';

    // Abort any previous stream and create a new AbortController for this send
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    runAgent({
      sessionId,
      cwd,
      signal: abort.signal,
      prompt: promptText,
      options: { model: currentModel || model, systemPrompt: systemPrompt || undefined, permissionLevel, ...(activeSkill ? { activeSkill: activeSkill.name } : {}) },
      onThinking: ({ text: thinkingText, usage }) => {
        execPhase({ phase: 'thinking', detail: thinkingText });
        if (usage) execTokens(toTokens(usage));
        bAppend({ role: 'thinking', content: thinkingText, timestamp: Date.now() });
      },
      onAssistant: ({ content, usage, session_id }) => {
        // Reload session list as soon as we have the session ID for new sessions
        if (session_id && !currentSessionId) {
          setSessionId(session_id);
          getProjects().then(setProjects).catch(() => {});
          if (currentProjectId) {
            getProjectSessions(currentProjectId).then(setSessions).catch(() => {});
          }
        }
        if (!hasAssistantText.current) {
          hasAssistantText.current = true;
          textAccum.current = content;
          bAppend({ role: 'assistant', content, streaming: true, timestamp: Date.now() });
        } else {
          textAccum.current += content;
          bUpdate(textAccum.current);
        }
        execPhase({ phase: 'responding', detail: '' });
        if (usage) execTokens(toTokens(usage));
      },
      onToolUse: ({ tool, input, tool_use_id, usage }) => {
        hasAssistantText.current = false;
        // Track tasks
        if (tool === 'TaskCreate') {
          addTask(input?.subject || '', input?.description || '');
        } else if (tool === 'TaskUpdate') {
          updateTask(input?.taskId || '', input?.status || 'pending');
        }
        const desc = input?.description || input?.command || input?.file_path || '';
        execPhase({ phase: 'running', detail: `${tool}:${desc}` });
        if (usage) execTokens(toTokens(usage));
        bAppend({ role: 'tool', toolCall: { name: tool, input, tool_use_id } });
      },
      onToolResult: ({ tool_use_id, content, is_error }) => {
        bAppend({ role: 'tool', toolResult: { tool_use_id, content: content || '', is_error } });
      },
      onAskUser: ({ questions }) => {
        setAskUser({ questions });
      },
      onToolConfirm: ({ tool, action, input }) => {
        setToolConfirm({ tool, action, input });
      },
      onDone: ({ sessionId: newId, tokens: doneTokens, cost, currency }) => {
        bUpdate(null);
        setStreaming(false);
        stopTimer();
        execDone({ tokens: doneTokens, cost, currency });
        setTimeout(() => execReset(), 5000);

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
          setTimeout(() => handleSend(next.text), 300);
        }
      },
      onTitle: ({ title }) => {
        if (title) updateMainTask(title);
      },
      onError: (err) => {
        // Ignore errors from previous (aborted) executions
        if (execIdRef.current !== myExecId) return;
        // AskUserQuestion abort is expected — don't show error
        if (askRef.current) return;
        clearPendingQueue();  // 出错时清空排队消息
        setStreaming(false);
        stopTimer();
        execPhase({ phase: 'done', detail: err.message });
        setTimeout(() => execReset(), 5000);
        bAppend({ role: 'system', content: `错误: ${err.message}` });
      },
    });
  }, [isStreaming, setStreaming, appendMessage, updateLastMessage, currentProjectId, currentSessionId, model, currentModel, systemPrompt, permissionLevel, setSessionId, projects, setProjects, setSessions, execStart, execPhase, execTick, execTokens, execDone, execReset, startTimer, stopTimer, activeSkill, addTask, updateTask, setMainTask, updateMainTask]);

  const handleResolveAsk = useCallback((answers) => {
    if (!askUser || !currentSessionId) return;
    resolveQuestion(currentSessionId, answers).catch(() => {});
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
    // AskUserQuestion: session was aborted, answer starts a new turn
    if (text) {
      setTimeout(() => handleSend(text), 200);
    }
  }, [askUser, currentSessionId, handleSend]);

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
          <div className="chat-container" ref={containerRef}>
          {hasMore && chatMessages.length > 0 && atTop && (
            <div className="load-more-row">
              <button className="load-more-btn" onClick={handleLoadMore} disabled={loadingMore}>
                {loadingMore ? '加载中...' : '加载更早的消息'}
              </button>
            </div>
          )}
          {!hasMessages && <WelcomeScreen onSend={handleSend} />}
          {chatMessages.map((msg, i) => (
            <ChatMessage key={i} message={msg} />
          ))}
          {/* AskUserQuestion dialog — embedded in chat flow */}
          {askUser && (
            <div className="ask-user-dialog" ref={askRef}>
              <h4>🤔 Claude 想确认几个问题</h4>
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
              <h4>🔐 {toolConfirm.action}</h4>
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
        </div>
        </div>
        <div className="right-panels">
          <TaskPanel />
          <ExecutionPanel />
        </div>
      </div>
      <ChatInput onSend={handleSend} onStop={handleStop} activeSkill={activeSkill} onSkillChange={setActiveSkill} queuedMessages={queuedMessages} onRemoveQueued={(idx) => { pendingQueue.current.splice(idx, 1); setQueuedMessages([...pendingQueue.current]); }} />
    </div>
  );
}
