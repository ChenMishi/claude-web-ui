import { createContext, useContext, useReducer, useCallback } from 'react';

const AppContext = createContext(null);

const initialState = {
  projects: [],
  currentProjectId: null,
  sessions: [],
  currentSessionId: null,
  chatMessages: [],
  isStreaming: false,
  sidebarOpen: true,
  activeView: 'chat',
  model: 'claude-opus-4-7',
  systemPrompt: '',
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_PROJECTS':
      return { ...state, projects: action.payload };
    case 'SELECT_PROJECT':
      return { ...state, currentProjectId: action.payload, currentSessionId: null, chatMessages: [] };
    case 'SET_SESSIONS':
      return { ...state, sessions: action.payload };
    case 'SELECT_SESSION':
      return { ...state, currentSessionId: action.payload, chatMessages: [] };
    case 'SET_SESSION_ID':
      return { ...state, currentSessionId: action.payload };
    case 'SET_MESSAGES':
      return { ...state, chatMessages: action.payload };
    case 'APPEND_MESSAGE':
      return { ...state, chatMessages: [...state.chatMessages, action.payload] };
    case 'UPDATE_LAST_MESSAGE':
      if (state.chatMessages.length === 0) return state;
      const msgs = [...state.chatMessages];
      if (action.payload === null) {
        // Finalize: remove streaming flag
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], streaming: false };
      } else {
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: action.payload };
      }
      return { ...state, chatMessages: msgs };
    case 'SET_STREAMING':
      return { ...state, isStreaming: action.payload };
    case 'SET_VIEW':
      return { ...state, activeView: action.payload };
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case 'SET_SETTING':
      return { ...state, [action.payload.key]: action.payload.value };
    default:
      return state;
  }
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

  const value = {
    ...state,
    setProjects, selectProject, setSessions, selectSession, setSessionId,
    setMessages, appendMessage, updateLastMessage, setStreaming,
    setView, toggleSidebar, setSetting,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppContextProvider');
  return ctx;
}
