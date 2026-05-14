import { useRef, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { runAgent, getProjects, getProjectSessions } from '../api';
import ChatMessage from './ChatMessage';
import ChatInput from './ChatInput';
import WelcomeScreen from './WelcomeScreen';

export default function ChatView() {
  const {
    chatMessages, appendMessage, updateLastMessage,
    isStreaming, setStreaming, currentProjectId, currentSessionId,
    model, systemPrompt, setSessionId, projects,
    setProjects, setSessions,
    execStart, execPhase, execTick, execTokens, execDone, execReset,
  } = useApp();
  const containerRef = useRef(null);
  const hasAssistantText = useRef(false);
  const textAccum = useRef('');
  const timerRef = useRef(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [chatMessages]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

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

  const handleSend = useCallback((text) => {
    if (!text.trim() || isStreaming) return;
    setStreaming(true);
    execStart();
    startTimer();
    appendMessage({ role: 'user', content: text });
    hasAssistantText.current = false;
    textAccum.current = '';

    const project = projects.find(p => p.id === currentProjectId);
    const cwd = project?.cwd || '/root';
    const sessionId = currentSessionId || 'new';

    runAgent({
      sessionId,
      cwd,
      prompt: text,
      options: { model, systemPrompt: systemPrompt || undefined },
      onThinking: ({ text: thinkingText, usage }) => {
        execPhase({ phase: 'thinking', detail: thinkingText });
        if (usage) execTokens(toTokens(usage));
      },
      onAssistant: ({ content, usage }) => {
        if (!hasAssistantText.current) {
          hasAssistantText.current = true;
          textAccum.current = content;
          appendMessage({ role: 'assistant', content, streaming: true });
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
        }
      },
      onError: (err) => {
        setStreaming(false);
        stopTimer();
        execPhase({ phase: 'done', detail: err.message });
        setTimeout(() => execReset(), 5000);
        appendMessage({ role: 'system', content: `错误: ${err.message}` });
      },
    });
  }, [isStreaming, setStreaming, appendMessage, updateLastMessage, currentProjectId, currentSessionId, model, systemPrompt, setSessionId, projects, setProjects, setSessions, execStart, execPhase, execTick, execTokens, execDone, execReset, startTimer, stopTimer]);

  const hasMessages = chatMessages.length > 0;

  return (
    <>
      <div className="chat-container" ref={containerRef}>
        {!hasMessages && <WelcomeScreen onSend={handleSend} />}
        {chatMessages.map((msg, i) => (
          <ChatMessage key={i} message={msg} />
        ))}
      </div>
      <ChatInput onSend={handleSend} disabled={isStreaming} />
    </>
  );
}
