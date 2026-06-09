import { createContext, useContext, useReducer, useCallback, useEffect, useRef } from 'react';
import { getMe, getAuthStatus, setTokens, clearTokens, setOnTokenExpired, listModels, switchModel as apiSwitchModel, restartServer } from '../api';

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

// Strip tool call/result blocks and thinking when restoring a session — only show text conversation
function textOnly(msgs) {
  if (!msgs || !msgs.length) return [];
  return msgs.filter(m => m.role !== 'tool' && m.role !== 'thinking');
}

const initMessageCache = loadState('messageCache', {});
const initSessionId = loadState('currentSessionId', null);

const initialState = {
  user: null,          // { id, username, role } or null
  authLoading: true,   // true while checking auth status on startup
  projects: [],
  currentProjectId: loadState('currentProjectId', null),
  sessions: [],
  currentSessionId: initSessionId,
  chatMessages: initSessionId && initMessageCache[initSessionId] ? textOnly(initMessageCache[initSessionId]) : [],
  messageCache: initMessageCache,
  isStreaming: false,
  sidebarOpen: true,
  updateAvailable: false,  // always reset on page load
  activeView: 'chat',
  theme: loadState('theme', 'dark'),
  permissionLevel: loadState('permissionLevel', 'auto'),
  model: loadState('model', 'claude-opus-4-7'),
  availableModels: [],
  currentModel: loadState('currentModel', ''),
  systemPrompt: loadState('systemPrompt', ''),
  execStatus: {
    phase: 'idle', // idle | thinking | running | responding | done
    detail: '',
    startTime: 0,
    elapsed: 0,
    tokens: null,  // { input, output, cacheRead, cacheWrite }
    cost: null,
    currency: null,
  },
  tasks: [],  // { id, subject, description, status: 'pending'|'in_progress'|'completed' }
  mainTask: null,  // { subject: string, status: 'in_progress'|'completed' }
  restartStatus: null,  // null | 'restarting' | 'done' | 'timeout' | 'error'
  restartError: '',
  needInit: true,  // assume needs init until proven otherwise
};

function reducer(state, action) {
  let next = state;
  switch (action.type) {
    case 'SET_USER':
      next = { ...state, user: action.payload, authLoading: false }; break;
    case 'LOGOUT':
      next = { ...state, user: null, authLoading: false, activeView: 'chat' }; break;
    case 'AUTH_LOADED':
      next = { ...state, authLoading: false }; break;
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
      const restored = textOnly(cache[sid] || []);
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
      // 流式期间不写缓存 — 每条消息 append 都写 localStorage 会造成主线程阻塞。
      // 重连时更严重：buffer 回放 50+ 事件在同一同步循环里各写一次，页面直接卡死。
      // 缓存在 done 信号（UPDATE_LAST_MESSAGE null）时统一写入一次完整状态。
      if (!state.isStreaming) {
        saveCache(newCache);
      }
      next = { ...state, chatMessages: newMsgs, messageCache: newCache };
      break;
    }
    case 'UPDATE_LAST_MESSAGE': {
      if (state.chatMessages.length === 0) return state;
      const msgs = [...state.chatMessages];
      if (action.payload === null) {
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], streaming: false };
        // 仅在 done 信号（payload=null）时写缓存 —— 每轮对话仅 1 次，不会卡死。
        // 流式内容更新（payload=string）每帧触发数百次，跳过 localStorage 写入。
        const newCache = { ...state.messageCache };
        const key = state.currentSessionId || '__pending__';
        newCache[key] = msgs;
        saveCache(newCache);
        next = { ...state, chatMessages: msgs, messageCache: newCache };
      } else {
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: action.payload };
        next = { ...state, chatMessages: msgs };
      }
      break;
    }
    case 'FINISH_ALL_STREAMING': {
      if (state.chatMessages.length === 0) return state;
      const msgs = state.chatMessages.map(m => m.streaming ? { ...m, streaming: false } : m);
      next = { ...state, chatMessages: msgs };
      break;
    }
    case 'SET_STREAMING':
      next = { ...state, isStreaming: action.payload }; break;
    case 'SET_VIEW':
      next = { ...state, activeView: action.payload }; break;
    case 'TOGGLE_SIDEBAR':
      next = { ...state, sidebarOpen: !state.sidebarOpen }; break;
    case 'SET_UPDATE':
      localStorage.setItem('claude-ui:updateAvailable', JSON.stringify(action.payload));
      next = { ...state, updateAvailable: action.payload }; break;
    case 'SET_SETTING':
      localStorage.setItem(`claude-ui:${action.payload.key}`, JSON.stringify(action.payload.value));
      next = { ...state, [action.payload.key]: action.payload.value }; break;
    case 'SET_MODELS':
      next = { ...state, availableModels: action.payload.models || [], currentModel: action.payload.current || state.currentModel }; break;
    // Execution status actions
    case 'EXEC_START':
      next = { ...state, tasks: [], mainTask: null, execStatus: { phase: 'thinking', detail: '', startTime: Date.now(), elapsed: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: null } }; break;
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
      next = { ...state, mainTask: state.mainTask ? { ...state.mainTask, status: 'completed' } : null, execStatus: { ...state.execStatus, phase: 'done', tokens: action.payload.tokens, cost: action.payload.cost, currency: action.payload.currency, elapsed: Math.floor((Date.now() - state.execStatus.startTime) / 1000) } }; break;
    case 'EXEC_RESET':
      next = { ...state, execStatus: initialState.execStatus }; break;
    case 'TASK_CREATE': {
      const newTask = {
        id: state.tasks.length + 1,
        subject: action.payload.subject || '',
        description: action.payload.description || '',
        status: 'pending',
        sdkTaskId: null,  // 等 tool result 回来才绑定
      };
      next = { ...state, tasks: [...state.tasks, newTask] }; break;
    }
    case 'TASK_BIND_ID': {
      // tool result 返回了 SDK taskId → 绑定到最后一个未绑定的任务
      const sdkTaskId = action.payload;
      const tasks = [...state.tasks];
      for (let i = tasks.length - 1; i >= 0; i--) {
        if (tasks[i].sdkTaskId === null) {
          tasks[i] = { ...tasks[i], sdkTaskId };
          break;
        }
      }
      next = { ...state, tasks }; break;
    }
    case 'TASK_UPDATE': {
      const rawId = action.payload.taskId;
      const numId = parseInt(rawId);
      let matched = false;
      const updated = state.tasks.map(t => {
        if (matched) return t;
        // 优先用 SDK taskId 精确匹配
        const hit = (!isNaN(numId) && t.sdkTaskId === numId) || (t.sdkTaskId !== null && String(t.sdkTaskId) === rawId);
        if (hit && t.status === 'pending') {
          matched = true;
          return { ...t, status: action.payload.status || 'pending' };
        }
        return t;
      });
      if (!matched) {
        // 如果精确匹配失败，更新第一个 pending 任务（兜底）
        const fallback = updated.map(t => {
          if (matched) return t;
          if (t.status === 'pending') {
            matched = true;
            return { ...t, status: action.payload.status || 'pending' };
          }
          return t;
        });
        next = { ...state, tasks: fallback }; break;
      }
      next = { ...state, tasks: updated }; break;
    }
    case 'TASKS_CLEAR':
      next = { ...state, tasks: [] }; break;
    case 'SET_MAIN_TASK':
      next = { ...state, mainTask: { subject: action.payload.subject, status: 'in_progress' } }; break;
    case 'UPDATE_MAIN_TASK':
      if (!state.mainTask) return state;
      next = { ...state, mainTask: { ...state.mainTask, subject: action.payload.subject } }; break;
    case 'RESTART_STATUS':
      next = { ...state, restartStatus: action.payload.status, restartError: action.payload.error || '' }; break;
    case 'SET_NEED_INIT':
      next = { ...state, needInit: action.payload }; break;
    default:
      return state;
  }
  return next;
}

export function AppContextProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const setUser = useCallback((user) => dispatch({ type: 'SET_USER', payload: user }), []);
  const logout = useCallback(() => {
    clearTokens();
    dispatch({ type: 'LOGOUT' });
  }, []);
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
  const setUpdateAvailable = useCallback((v) => dispatch({ type: 'SET_UPDATE', payload: v }), []);
  const setSetting = useCallback((key, value) => dispatch({ type: 'SET_SETTING', payload: { key, value } }), []);

  const execStart = useCallback(() => dispatch({ type: 'EXEC_START' }), []);
  const execPhase = useCallback((payload) => dispatch({ type: 'EXEC_PHASE', payload }), []);
  const execTick = useCallback(() => dispatch({ type: 'EXEC_TICK' }), []);
  const execTokens = useCallback((payload) => dispatch({ type: 'EXEC_TOKENS', payload }), []);
  const execDone = useCallback((payload) => dispatch({ type: 'EXEC_DONE', payload }), []);
  const execReset = useCallback(() => dispatch({ type: 'EXEC_RESET' }), []);
  const finishAllStreaming = useCallback(() => dispatch({ type: 'FINISH_ALL_STREAMING' }), []);
  const addTask = useCallback((subject, description) => dispatch({ type: 'TASK_CREATE', payload: { subject, description } }), []);
  const bindTaskId = useCallback((sdkTaskId) => dispatch({ type: 'TASK_BIND_ID', payload: sdkTaskId }), []);
  const updateTask = useCallback((taskId, status) => dispatch({ type: 'TASK_UPDATE', payload: { taskId, status } }), []);
  const clearTasks = useCallback(() => dispatch({ type: 'TASKS_CLEAR' }), []);
  const setMainTask = useCallback((subject) => dispatch({ type: 'SET_MAIN_TASK', payload: { subject } }), []);
  const updateMainTask = useCallback((subject) => dispatch({ type: 'UPDATE_MAIN_TASK', payload: { subject } }), []);

  // Load available models from built-in proxy provider on mount
  const loadAvailableModels = useCallback(async () => {
    try {
      const data = await listModels();
      dispatch({ type: 'SET_MODELS', payload: { models: data.models || [], current: data.current || '' } });
    } catch {}
  }, []);

  const switchCurrentModel = useCallback(async (model) => {
    setSetting('currentModel', model);
    try { await apiSwitchModel(model); } catch {}
  }, [setSetting]);

  // Shared restart handler — used by Sidebar dropdown and VersionCard upgrade completion
  const restartRef = useRef(null);
  const triggerRestart = useCallback(async () => {
    dispatch({ type: 'RESTART_STATUS', payload: { status: 'restarting' } });
    restartRef.current = 'restarting';
    try {
      await restartServer();
      await new Promise(r => setTimeout(r, 4000));
      const poll = setInterval(async () => {
        try {
          const res = await fetch('/api/auth/status');
          if (res.ok) {
            clearInterval(poll);
            restartRef.current = 'done';
            dispatch({ type: 'RESTART_STATUS', payload: { status: 'done' } });
            setTimeout(() => window.location.reload(), 1000);
          }
        } catch {}
      }, 2000);
      setTimeout(() => {
        clearInterval(poll);
        if (restartRef.current === 'restarting') {
          dispatch({ type: 'RESTART_STATUS', payload: { status: 'timeout' } });
          restartRef.current = 'timeout';
        }
      }, 60000);
    } catch (err) {
      dispatch({ type: 'RESTART_STATUS', payload: { status: 'error', error: err.message } });
      restartRef.current = 'error';
    }
  }, []);

  const dismissRestart = useCallback(() => {
    dispatch({ type: 'RESTART_STATUS', payload: { status: null } });
  }, []);

  const setNeedInit = useCallback((v) => dispatch({ type: 'SET_NEED_INIT', payload: v }), []);

  // Load models once on mount
  useEffect(() => { loadAvailableModels(); }, [loadAvailableModels]);

  // Persist key settings to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('claude-ui:currentProjectId', JSON.stringify(state.currentProjectId));
      localStorage.setItem('claude-ui:currentSessionId', JSON.stringify(state.currentSessionId));
      localStorage.setItem('claude-ui:theme', JSON.stringify(state.theme));
      localStorage.setItem('claude-ui:permissionLevel', JSON.stringify(state.permissionLevel));
      localStorage.setItem('claude-ui:model', JSON.stringify(state.model));
      localStorage.setItem('claude-ui:systemPrompt', JSON.stringify(state.systemPrompt));
    } catch {}
  }, [state.currentProjectId, state.currentSessionId, state.theme, state.permissionLevel, state.model, state.systemPrompt]);

  // Sync theme to <html data-theme> attribute
  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);

  // Startup auth check
  useEffect(() => {
    setOnTokenExpired(() => dispatch({ type: 'LOGOUT' }));
    const accessToken = localStorage.getItem('claude-ui:accessToken');
    const refreshTokenVal = localStorage.getItem('claude-ui:refreshToken');
    if (accessToken || refreshTokenVal) {
      // Try to validate token
      getMe().then(data => {
        dispatch({ type: 'SET_USER', payload: data.user });
      }).catch(() => {
        // Token invalid, check if auth is required
        getAuthStatus().then(status => {
          if (!status.authRequired) {
            dispatch({ type: 'AUTH_LOADED' });
          } else {
            clearTokens();
            dispatch({ type: 'AUTH_LOADED' });
          }
        }).catch(() => {
          clearTokens();
          dispatch({ type: 'AUTH_LOADED' });
        });
      });
    } else {
      // No tokens, check auth status
      getAuthStatus().then(status => {
        if (!status.authRequired) {
          dispatch({ type: 'AUTH_LOADED' });
        } else {
          dispatch({ type: 'AUTH_LOADED' });
        }
      }).catch(() => {
        dispatch({ type: 'AUTH_LOADED' });
      });
    }
  }, []);

  const value = {
    ...state,
    setUser, logout,
    setProjects, selectProject, setSessions, selectSession, setSessionId,
    setMessages, appendMessage, updateLastMessage, setStreaming,
    setView, toggleSidebar, setSetting,
    execStart, execPhase, execTick, execTokens, execDone, execReset,
    addTask, bindTaskId, updateTask, clearTasks, setMainTask, updateMainTask,
    setUpdateAvailable,
    loadAvailableModels, switchCurrentModel,
    triggerRestart, dismissRestart,
    finishAllStreaming,
    setNeedInit,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppContextProvider');
  return ctx;
}
