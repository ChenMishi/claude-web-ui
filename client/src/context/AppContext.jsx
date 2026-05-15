import { createContext, useContext, useReducer, useCallback, useEffect } from 'react';

const AppContext = createContext(null);

function loadState(key, fallback) {
  try {
    const v = localStorage.getItem(`claude-ui:${key}`);
    return v !== null ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}

function saveCache(cache) {
  try {
    // Keep at most 10 sessions, 200 messages each to avoid localStorage overflow
    const trimmed = {};
    const keys = Object.keys(cache).slice(-10);
    for (const k of keys) {
      const msgs = cache[k];
      trimmed[k] = msgs.length > 200 ? msgs.slice(-200) : msgs;
    }
    localStorage.setItem('claude-ui:messageCache', JSON.stringify(trimmed));
  } catch {}
}

const initMessageCache = loadState('messageCache', {});
const initSessionId = loadState('currentSessionId', null);

const initialState = {
  projects: [],
  currentProjectId: loadState('currentProjectId', null),
  sessions: [],
  currentSessionId: initSessionId,
  chatMessages: initSessionId && initMessageCache[initSessionId] ? initMessageCache[initSessionId] : [],
  messageCache: initMessageCache,
  isStreaming: false,
  sidebarOpen: true,
  activeView: 'chat',
  theme: loadState('theme', 'dark'),
  model: loadState('model', 'claude-opus-4-7'),
  systemPrompt: loadState('systemPrompt', ''),
  execStatus: {
    phase: 'idle', // idle | thinking | running | responding | done
    detail: '',
    startTime: 0,
    elapsed: 0,
    tokens: null,  // { input, output, cacheRead, cacheWrite }
    cost: null,
  },
};

function reducer(state, action) {
  let next = state;
  switch (action.type) {
    case 'SET_PROJECTS':
      next = { ...state, projects: action.payload }; break;
    case 'SELECT_PROJECT': {
      // Save current session messages to cache before switching
      const saveKey = state.currentSessionId || '__pending__';
      const newCache = { ...state.messageCache };
      if (state.chatMessages.length > 0) {
        newCache[saveKey] = state.chatMessages;
        saveCache(newCache);
      }
      localStorage.setItem('claude-ui:currentProjectId', JSON.stringify(action.payload));
      localStorage.removeItem('claude-ui:currentSessionId');
      next = { ...state, currentProjectId: action.payload, currentSessionId: null,
        chatMessages: [], messageCache: newCache };
      break;
    }
    case 'SET_SESSIONS':
      next = { ...state, sessions: action.payload }; break;
    case 'SELECT_SESSION': {
      const sid = action.payload;
      localStorage.setItem('claude-ui:currentSessionId', JSON.stringify(sid));
      const cache = { ...state.messageCache };
      const saveKey = state.currentSessionId || '__pending__';
      if (state.chatMessages.length > 0) {
        cache[saveKey] = state.chatMessages;
      }
      const restored = cache[sid] || [];
      saveCache(cache);
      next = { ...state, currentSessionId: sid, chatMessages: restored, messageCache: cache };
      break;
    }
    case 'SET_SESSION_ID': {
      localStorage.setItem('claude-ui:currentSessionId', JSON.stringify(action.payload));
      const cache2 = { ...state.messageCache };
      if (cache2.__pending__) {
        cache2[action.payload] = cache2.__pending__;
        delete cache2.__pending__;
        saveCache(cache2);
      }
      next = { ...state, currentSessionId: action.payload, messageCache: cache2 };
      break;
    }
    case 'SET_MESSAGES':
      next = { ...state, chatMessages: action.payload }; break;
    case 'APPEND_MESSAGE': {
      const newMsgs = [...state.chatMessages, action.payload];
      const newCache = { ...state.messageCache };
      const key = state.currentSessionId || '__pending__';
      newCache[key] = newMsgs;
      saveCache(newCache);
      next = { ...state, chatMessages: newMsgs, messageCache: newCache };
      break;
    }
    case 'UPDATE_LAST_MESSAGE': {
      if (state.chatMessages.length === 0) return state;
      const msgs = [...state.chatMessages];
      if (action.payload === null) {
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], streaming: false };
      } else {
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: action.payload };
      }
      const newCache2 = { ...state.messageCache };
      const k2 = state.currentSessionId || '__pending__';
      newCache2[k2] = msgs;
      saveCache(newCache2);
      next = { ...state, chatMessages: msgs, messageCache: newCache2 };
      break;
    }
    case 'SET_STREAMING':
      next = { ...state, isStreaming: action.payload }; break;
    case 'SET_VIEW':
      next = { ...state, activeView: action.payload }; break;
    case 'TOGGLE_SIDEBAR':
      next = { ...state, sidebarOpen: !state.sidebarOpen }; break;
    case 'SET_SETTING':
      localStorage.setItem(`claude-ui:${action.payload.key}`, JSON.stringify(action.payload.value));
      next = { ...state, [action.payload.key]: action.payload.value }; break;
    // Execution status actions
    case 'EXEC_START':
      next = { ...state, execStatus: { phase: 'thinking', detail: '', startTime: Date.now(), elapsed: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: null } }; break;
    case 'EXEC_PHASE':
      next = { ...state, execStatus: { ...state.execStatus, ...action.payload } }; break;
    case 'EXEC_TICK':
      next = { ...state, execStatus: { ...state.execStatus, elapsed: Math.floor((Date.now() - state.execStatus.startTime) / 1000) } }; break;
    case 'EXEC_TOKENS': {
      const cur = state.execStatus.tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const add = action.payload || {};
      next = { ...state, execStatus: { ...state.execStatus, tokens: {
        input: cur.input + (add.input || 0),
        output: cur.output + (add.output || 0),
        cacheRead: cur.cacheRead + (add.cacheRead || 0),
        cacheWrite: cur.cacheWrite + (add.cacheWrite || 0),
      }}};
      break;
    }
    case 'EXEC_DONE':
      next = { ...state, execStatus: { ...state.execStatus, phase: 'done', tokens: action.payload.tokens, cost: action.payload.cost, elapsed: Math.floor((Date.now() - state.execStatus.startTime) / 1000) } }; break;
    case 'EXEC_RESET':
      next = { ...state, execStatus: initialState.execStatus }; break;
    default:
      return state;
  }
  return next;
}

export function AppContextProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const setProjects = useCallback((projects) => dispatch({ type: 'SET_PROJECTS', payload: projects }), []);
  const selectProject = useCallback((id) => dispatch({ type: 'SELECT_PROJECT', payload: id }), []);
  const setSessions = useCallback((sessions) => dispatch({ type: 'SET_SESSIONS', payload: sessions }), []);
  const selectSession = useCallback((id) => dispatch({ type: 'SELECT_SESSION', payload: id }), []);
  const setSessionId = useCallback((id) => dispatch({ type: 'SET_SESSION_ID', payload: id }), []);
  const setMessages = useCallback((messages) => dispatch({ type: 'SET_MESSAGES', payload: messages }), []);
  const appendMessage = useCallback((msg) => dispatch({ type: 'APPEND_MESSAGE', payload: msg }), []);
  const updateLastMessage = useCallback((content) => dispatch({ type: 'UPDATE_LAST_MESSAGE', payload: content }), []);
  const setStreaming = useCallback((v) => dispatch({ type: 'SET_STREAMING', payload: v }), []);
  const setView = useCallback((v) => dispatch({ type: 'SET_VIEW', payload: v }), []);
  const toggleSidebar = useCallback(() => dispatch({ type: 'TOGGLE_SIDEBAR' }), []);
  const setSetting = useCallback((key, value) => dispatch({ type: 'SET_SETTING', payload: { key, value } }), []);

  const execStart = useCallback(() => dispatch({ type: 'EXEC_START' }), []);
  const execPhase = useCallback((payload) => dispatch({ type: 'EXEC_PHASE', payload }), []);
  const execTick = useCallback(() => dispatch({ type: 'EXEC_TICK' }), []);
  const execTokens = useCallback((payload) => dispatch({ type: 'EXEC_TOKENS', payload }), []);
  const execDone = useCallback((payload) => dispatch({ type: 'EXEC_DONE', payload }), []);
  const execReset = useCallback(() => dispatch({ type: 'EXEC_RESET' }), []);

  // Persist key settings to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('claude-ui:currentProjectId', JSON.stringify(state.currentProjectId));
      localStorage.setItem('claude-ui:currentSessionId', JSON.stringify(state.currentSessionId));
      localStorage.setItem('claude-ui:theme', JSON.stringify(state.theme));
      localStorage.setItem('claude-ui:model', JSON.stringify(state.model));
      localStorage.setItem('claude-ui:systemPrompt', JSON.stringify(state.systemPrompt));
    } catch {}
  }, [state.currentProjectId, state.currentSessionId, state.theme, state.model, state.systemPrompt]);

  // Sync theme to <html data-theme> attribute
  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);

  const value = {
    ...state,
    setProjects, selectProject, setSessions, selectSession, setSessionId,
    setMessages, appendMessage, updateLastMessage, setStreaming,
    setView, toggleSidebar, setSetting,
    execStart, execPhase, execTick, execTokens, execDone, execReset,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppContextProvider');
  return ctx;
}
