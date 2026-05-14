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
  } = useApp();
  const containerRef = useRef(null);
  const hasAssistantText = useRef(false);
  const textAccum = useRef('');

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const handleSend = useCallback((text) => {
    if (!text.trim() || isStreaming) return;
    setStreaming(true);
    appendMessage({ role: 'user', content: text });
    hasAssistantText.current = false;
    textAccum.current = '';

    const project = projects.find(p => p.id === currentProjectId);
    const cwd = project?.cwd || '/root';
    const sessionId = currentSessionId || 'new';

    // Fire-and-forget — don't await, let callbacks drive state updates
    runAgent({
      sessionId,
      cwd,
      prompt: text,
      options: { model, systemPrompt: systemPrompt || undefined },
      onAssistant: ({ content }) => {
        if (!hasAssistantText.current) {
          hasAssistantText.current = true;
          textAccum.current = content;
          appendMessage({ role: 'assistant', content, streaming: true });
        } else {
          textAccum.current += content;
          updateLastMessage(textAccum.current);
        }
      },
      onToolUse: ({ tool, input, tool_use_id }) => {
        hasAssistantText.current = false;
        appendMessage({ role: 'tool', toolCall: { name: tool, input, tool_use_id } });
      },
      onToolResult: ({ tool_use_id, content, is_error }) => {
        appendMessage({ role: 'tool', toolResult: { tool_use_id, content: typeof content === 'string' ? content : JSON.stringify(content), is_error } });
      },
      onDone: ({ sessionId: newId }) => {
        // Finalize: remove streaming flag from last assistant message
        updateLastMessage(null); // signal completion
        setStreaming(false);
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
        appendMessage({ role: 'system', content: `错误: ${err.message}` });
      },
    });
  }, [isStreaming, setStreaming, appendMessage, updateLastMessage, currentProjectId, currentSessionId, model, systemPrompt, setSessionId, projects, setProjects, setSessions]);

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
