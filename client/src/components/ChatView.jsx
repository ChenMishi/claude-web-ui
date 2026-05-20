import { useRef, useEffect, useCallback, useState, useLayoutEffect } from 'react';
import { useApp } from '../context/AppContext';
import { runAgent, getProjects, getProjectSessions, abortSession, generateTitle, reconnectSession, getSessionInfo, resolveQuestion, getSessionMessages } from '../api';
import ChatMessage from './ChatMessage';
import ChatInput from './ChatInput';
import WelcomeScreen from './WelcomeScreen';

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
  } = useApp();
  const containerRef = useRef(null);
  const hasAssistantText = useRef(false);
  const textAccum = useRef('');
  const timerRef = useRef(null);
  const execIdRef = useRef(0);  // increments each execution, used to ignore stale errors
  const [askUser, setAskUser] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const askRef = useRef(null);
  const chatMessagesRef = useRef(chatMessages);
  chatMessagesRef.current = chatMessages;
  const skipScrollRef = useRef(false);
  const scrollRestoreRef = useRef(null);
  const [atTop, setAtTop] = useState(false);
  const loadedCountRef = useRef(0);

  // Auto-scroll when ask dialog appears
  useEffect(() => {
    if (askUser && askRef.current) {
      askRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [askUser]);

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
        setMessages([...olderMsgs, ...currentMsgs]);
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

  // Restore scroll after prepending older messages (before paint)
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

  // Reconnect to running session after page refresh
  useEffect(() => {
    if (!currentSessionId || chatMessages.length > 0) return;
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
                        if (textBlocks.length > 0) {
                          const text = textBlocks.map(c => c.text).join('');
                          if (!hasAssistantText.current) {
                            hasAssistantText.current = true;
                            textAccum.current = text;
                            appendMessage({ role: 'assistant', content: text, streaming: true, timestamp: Date.now() });
                          } else {
                            textAccum.current += text;
                            updateLastMessage(textAccum.current);
                          }
                          execPhase({ phase: 'responding', detail: '' });
                        }
                        if (toolBlocks.length > 0) {
                          hasAssistantText.current = false;
                          toolBlocks.forEach(t => {
                            const desc = t.input?.description || t.input?.command || t.input?.file_path || '';
                            execPhase({ phase: 'running', detail: `${t.name}:${desc}` });
                            appendMessage({ role: 'tool', toolCall: { name: t.name, input: t.input, tool_use_id: t.id }, timestamp: Date.now() });
                          });
                        }
                        if (parsed.message?.usage) execTokens(toTokens(parsed.message.usage));
                      } else if (parsed.type === 'user') {
                        const toolResults = (parsed.message?.content || []).filter(c => c.type === 'tool_result');
                        toolResults.forEach(t => {
                          let text = typeof t.content === 'string' ? t.content : JSON.stringify(t.content || '');
                          appendMessage({ role: 'tool', toolResult: { tool_use_id: t.tool_use_id, content: text, is_error: t.is_error }, timestamp: Date.now() });
                        });
                      }
                    } else if (currentEvent === 'done') {
                      updateLastMessage(null);
                      setStreaming(false);
                      stopTimer();
                      execDone({ tokens: parsed.tokens, cost: parsed.cost });
                      setTimeout(() => execReset(), 5000);
                      return; // stop pumping
                    } else if (currentEvent === 'error') {
                      setStreaming(false);
                      stopTimer();
                      execReset();
                      appendMessage({ role: 'system', content: `重连失败: ${parsed.message}`, timestamp: Date.now() });
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

  const handleStop = useCallback((execStatus) => {
    ++execIdRef.current;  // bump so stale SSE errors are ignored
    stopTimer();

    // End streaming on last assistant message
    updateLastMessage(null);
    setStreaming(false);

    // Append a summary system message
    const summary = buildAbortSummary(execStatus);
    appendMessage({ role: 'system', content: summary, timestamp: Date.now() });

    execReset();
  }, [stopTimer, updateLastMessage, setStreaming, appendMessage, execReset]);

  const handleSend = useCallback((text) => {
    if (!text.trim()) return;
    // If streaming, abort current session first
    if (isStreaming) {
      stopTimer();
      updateLastMessage(null);
      setStreaming(false);
      if (currentSessionId) abortSession(currentSessionId).catch(() => {});
    }
    // Bump execution ID so stale SSE errors from previous run are ignored
    const myExecId = ++execIdRef.current;
    setStreaming(true);
    execStart();
    startTimer();
    appendMessage({ role: 'user', content: text, timestamp: Date.now() });
    hasAssistantText.current = false;
    textAccum.current = '';

    const project = projects.find(p => p.id === currentProjectId);
    const cwd = project?.cwd || '/root';
    const sessionId = currentSessionId || 'new';

    runAgent({
      sessionId,
      cwd,
      prompt: text,
      options: { model, systemPrompt: systemPrompt || undefined, permissionLevel },
      onThinking: ({ text: thinkingText, usage }) => {
        execPhase({ phase: 'thinking', detail: thinkingText });
        if (usage) execTokens(toTokens(usage));
      },
      onAssistant: ({ content, usage }) => {
        if (!hasAssistantText.current) {
          hasAssistantText.current = true;
          textAccum.current = content;
          appendMessage({ role: 'assistant', content, streaming: true, timestamp: Date.now() });
        } else {
          textAccum.current += content;
          updateLastMessage(textAccum.current);
        }
        execPhase({ phase: 'responding', detail: '' });
        if (usage) execTokens(toTokens(usage));
      },
      onToolUse: ({ tool, input, tool_use_id, usage }) => {
        hasAssistantText.current = false;
        const desc = input?.description || input?.command || input?.file_path || '';
        execPhase({ phase: 'running', detail: `${tool}:${desc}` });
        if (usage) execTokens(toTokens(usage));
        appendMessage({ role: 'tool', toolCall: { name: tool, input, tool_use_id } });
      },
      onToolResult: ({ tool_use_id, content, is_error }) => {
        appendMessage({ role: 'tool', toolResult: { tool_use_id, content: content || '', is_error } });
      },
      onAskUser: ({ questions }) => {
        setAskUser({ questions });
      },
      onDone: ({ sessionId: newId, tokens: doneTokens, cost }) => {
        updateLastMessage(null);
        setStreaming(false);
        stopTimer();
        execDone({ tokens: doneTokens, cost });
        setTimeout(() => execReset(), 5000);
        if (newId && !currentSessionId) {
          setSessionId(newId);
          getProjects().then(setProjects).catch(() => {});
          if (currentProjectId) {
            getProjectSessions(currentProjectId).then(setSessions).catch(() => {});
          }
          // Auto-generate a short title from the first message (async, refreshes list on completion)
          const firstMsg = text.slice(0, 200);
          const project = projects.find(p => p.id === currentProjectId);
          generateTitle(newId, firstMsg, project?.cwd)
            .then(() => {
              if (currentProjectId) {
                getProjectSessions(currentProjectId).then(setSessions).catch(() => {});
              }
            })
            .catch(() => {});
        }
      },
      onError: (err) => {
        // Ignore errors from previous (aborted) executions
        if (execIdRef.current !== myExecId) return;
        setStreaming(false);
        stopTimer();
        execPhase({ phase: 'done', detail: err.message });
        setTimeout(() => execReset(), 5000);
        appendMessage({ role: 'system', content: `错误: ${err.message}` });
      },
    });
  }, [isStreaming, setStreaming, appendMessage, updateLastMessage, currentProjectId, currentSessionId, model, systemPrompt, permissionLevel, setSessionId, projects, setProjects, setSessions, execStart, execPhase, execTick, execTokens, execDone, execReset, startTimer, stopTimer]);

  const handleResolveAsk = useCallback((answers) => {
    if (!askUser || !currentSessionId) return;
    resolveQuestion(currentSessionId, answers).catch(() => {});
    setAskUser(null);
  }, [askUser, currentSessionId]);

  const hasMessages = chatMessages.length > 0;
  const askQs = askUser?.questions || [];
  const isToolConfirm = askQs.length === 1 && askQs[0]?.options
    && askQs[0].options.length === 2
    && askQs[0].options.includes('允许')
    && askQs[0].options.includes('拒绝');

  return (
    <>
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
        {/* AskUserQuestion / Tool confirmation dialog */}
        {askUser && isToolConfirm && (
          <div className="ask-user-dialog" ref={askRef}>
            <h4>🤔 {askQs[0].question || askQs[0].header}</h4>
            <div className="confirm-buttons">
              <button className="confirm-btn-allow" onClick={() => handleResolveAsk({ answers: { q0: '允许' } })}>
                允许
              </button>
              <button className="confirm-btn-deny" onClick={() => handleResolveAsk({ answers: { q0: '拒绝' } })}>
                拒绝
              </button>
            </div>
          </div>
        )}
        {askUser && !isToolConfirm && (
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
                    collected[`q${qi}`] = Array.from(checked).map(c => c.value);
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
      </div>
      <ChatInput onSend={handleSend} onStop={handleStop} disabled={isStreaming} />
    </>
  );
}
