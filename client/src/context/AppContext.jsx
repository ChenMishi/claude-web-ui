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
    // Keep at most 10 sessions, 100 messages each to avoid localStorage overflow
    const trimmed = {};
    const keys = Object.keys(cache).slice(-10);
    for (const k of keys) {
      const msgs = cache[k];
      trimmed[k] = msgs.length > 100 ? msgs.slice(-100) : msgs;
    }
    localStorage.setItem('claude-ui:messageCache', JSON.stringify(trimmed));
  } catch {}
}

// Strip tool call/result blocks and thinking when restoring a session — only show text conversation
function textOnly(msgs) {
  if (!msgs || !msgs.length) return [];
  const filtered = msgs.filter(m => m.role !== 'tool' && m.role !== 'thinking');
  // 防止大型会话切换时渲染过多消息导致页面卡死（200 条 × 数 KB Markdown = 数十秒阻塞）
  return filtered.length > 50 ? filtered.slice(-50) : filtered;
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
  activeStreams: 0,     // 并行执行的会话数
  busySessions: new Set(), // 正在执行中的会话 ID 集合
  sessionExecStatus: {},   // 每个会话的执行状态 { sessionId: { phase, detail } }
  scheduledTasks: [],      // 定时任务列表
  pendingTaskSessions: new Set(), // 有未读定时任务结果的会话 ID（黄色呼吸灯）
  taskOutputTick: 0,       // 递增计数器，定时任务有新输出时触发聊天刷新
  sidebarOpen: true,
  updateAvailable: false,  // always reset on page load
  activeView: 'chat',
  theme: loadState('theme', 'dark'),
  permissionLevel: loadState('permissionLevel', 'auto'),
  model: loadState('model', 'claude-opus-4-7'),
  availableModels: [],
  modelGroups: {},    // providerId → {name, models}
  currentModel: loadState('currentModel', ''),
  systemPrompt: loadState('systemPrompt', ''),
  displayMode: loadState('displayMode', 'full'),
  execStatus: {
    phase: 'idle', // idle | thinking | running | responding | done
    detail: '',
    startTime: 0,
    elapsed: 0,
    tokens: null,  // { input, output, cacheRead, cacheWrite }
    cost: null,
    currency: null,
  },
  tasks: [],  // current session tasks
  mainTask: null,  // current session main task
  taskCache: {},  // sessionId → { tasks, mainTask }
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
      const taskCache = { ...state.taskCache };
      const saveKey = state.currentSessionId || '__pending__';
      if (state.chatMessages.length > 0) {
        cache[saveKey] = state.chatMessages;
      }
      // Save current tasks to cache
      if (state.tasks.length > 0 || state.mainTask) {
        taskCache[saveKey] = { tasks: state.tasks, mainTask: state.mainTask };
      }
      const isStreamingTarget = state.isStreaming && action.isStreamingSession;
      const raw = cache[sid] || [];
      const restored = (isStreamingTarget ? raw : textOnly(raw)).map(m =>
        m.streaming ? { ...m, streaming: false } : m
      );
      // Restore tasks for target session
      const cachedTasks = taskCache[sid] || { tasks: [], mainTask: null };
      saveCache(cache);
      next = { ...state, currentSessionId: sid, chatMessages: restored, messageCache: cache, tasks: cachedTasks.tasks, mainTask: cachedTasks.mainTask, taskCache };
      break;
    }
    case 'SET_SESSION_ID': {
      localStorage.setItem('claude-ui:currentSessionId', JSON.stringify(action.payload));
      const cache2 = { ...state.messageCache };
      if (cache2.__pending__) {
        cache2[action.payload] = cache2.__pending__;
        delete cache2.__pending__;
      }
      const orphanedMsgs = cache2['new'] || [];
      if (orphanedMsgs.length > 0) {
        cache2[action.payload] = [...(cache2[action.payload] || []), ...orphanedMsgs];
        delete cache2['new'];
      }
      saveCache(cache2);
      const merged = orphanedMsgs.length > 0
        ? [...state.chatMessages, ...orphanedMsgs]
        : state.chatMessages;
      // 新建会话 'new' → 真实 ID，同步更新 busySessions
      const bs3 = new Set(state.busySessions);
      if (bs3.has('new')) { bs3.delete('new'); bs3.add(action.payload); }
      next = { ...state, currentSessionId: action.payload, chatMessages: merged, messageCache: cache2, busySessions: bs3 };
      break;
    }
    case 'SET_MESSAGES': {
      const targetSid = action.targetSessionId;
      if (targetSid && targetSid !== (state.currentSessionId || '__pending__')) {
        const newCache = { ...state.messageCache };
        newCache[targetSid] = action.payload;
        next = { ...state, messageCache: newCache };
      } else {
        next = { ...state, chatMessages: action.payload };
      }
      break;
    }
    case 'APPEND_MESSAGE': {
      const targetSid = action.targetSessionId;
      const currentKey = state.currentSessionId || '__pending__';
      const isCurrent = !targetSid || targetSid === currentKey;
      if (isCurrent) {
        const newMsgs = [...state.chatMessages, action.payload];
        const newCache = { ...state.messageCache };
        newCache[currentKey] = newMsgs;
        if (!state.isStreaming) saveCache(newCache);
        next = { ...state, chatMessages: newMsgs, messageCache: newCache };
      } else {
        const newCache = { ...state.messageCache };
        const cached = newCache[targetSid] || [];
        newCache[targetSid] = [...cached, action.payload];
        next = { ...state, messageCache: newCache };
      }
      break;
    }
    case 'UPDATE_LAST_MESSAGE': {
      const targetSid = action.targetSessionId;
      const currentKey = state.currentSessionId || '__pending__';
      const isCurrent = !targetSid || targetSid === currentKey;
      if (isCurrent) {
        if (state.chatMessages.length === 0) return state;
        const msgs = [...state.chatMessages];
        if (action.payload === null) {
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], streaming: false };
          const newCache = { ...state.messageCache };
          newCache[currentKey] = msgs;
          saveCache(newCache);
          next = { ...state, chatMessages: msgs, messageCache: newCache };
        } else {
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: action.payload };
          next = { ...state, chatMessages: msgs };
        }
      } else {
        const newCache = { ...state.messageCache };
        const cached = [...(newCache[targetSid] || [])];
        if (cached.length === 0) { next = state; break; }
        if (action.payload === null) {
          cached[cached.length - 1] = { ...cached[cached.length - 1], streaming: false };
          saveCache(newCache);
        } else {
          cached[cached.length - 1] = { ...cached[cached.length - 1], content: action.payload };
        }
        newCache[targetSid] = cached;
        next = { ...state, messageCache: newCache };
      }
      break;
    }
    case 'FINISH_ALL_STREAMING': {
      if (state.chatMessages.length === 0) return state;
      const msgs = state.chatMessages.map(m => m.streaming ? { ...m, streaming: false } : m);
      next = { ...state, chatMessages: msgs };
      break;
    }
    case 'FINALIZE_STREAMING': {
      if (state.chatMessages.length === 0) return state;
      // Atomic: mark all messages non-streaming + save cache in one dispatch
      const msgs = state.chatMessages.map(m => m.streaming ? { ...m, streaming: false } : m);
      const newCache = { ...state.messageCache };
      const key = state.currentSessionId || '__pending__';
      newCache[key] = msgs;
      saveCache(newCache);
      next = { ...state, isStreaming: false, chatMessages: msgs, messageCache: newCache };
      break;
    }
    case 'SET_STREAMING':
      if (!action.payload && state.activeStreams > 0) return state; // ignore stale false from aborted stream
      next = { ...state, isStreaming: action.payload }; break;
    case 'STREAM_START': {
      const s = action.payload;
      const bs = new Set(state.busySessions);
      bs.add(s);
      next = { ...state, activeStreams: state.activeStreams + 1, busySessions: bs };
      break;
    }
    case 'STREAM_END': {
      const s = action.payload;
      const bs = new Set(state.busySessions);
      bs.delete(s);
      next = { ...state, activeStreams: Math.max(0, state.activeStreams - 1), busySessions: bs };
      break;
    }
    case 'SESSION_EXEC_UPDATE':
      next = { ...state, sessionExecStatus: { ...state.sessionExecStatus, [action.payload.sid]: action.payload.status } };
      break;
    case 'SET_SCHEDULED_TASKS':
      next = { ...state, scheduledTasks: typeof action.payload === 'function' ? action.payload(state.scheduledTasks) : action.payload };
      break;
    case 'MARK_TASK_SESSION_READ': {
      const pts = new Set(state.pendingTaskSessions);
      pts.delete(action.payload);
      next = { ...state, pendingTaskSessions: pts };
      break;
    }
    case 'ADD_PENDING_TASK_SESSION': {
      const pts2 = new Set(state.pendingTaskSessions);
      pts2.add(action.payload);
      next = { ...state, pendingTaskSessions: pts2 };
      break;
    }
    case 'NOTIFY_TASK_OUTPUT':
      next = { ...state, taskOutputTick: state.taskOutputTick + 1 };
      break;
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
      next = { ...state, availableModels: action.payload.models || [], modelGroups: action.payload.groups || {}, currentModel: action.payload.current || state.currentModel }; break;
    // Execution status actions
    case 'EXEC_START':
      next = { ...state, tasks: [], mainTask: null, taskCache: { ...state.taskCache, [state.currentSessionId || '__pending__']: { tasks: [], mainTask: null } }, execStatus: { phase: 'thinking', detail: '', startTime: Date.now(), elapsed: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: null } }; break;
    case 'EXEC_PHASE':
      next = { ...state, execStatus: { ...state.execStatus, ...action.payload } }; break;
    case 'EXEC_TICK':
      if (state.execStatus.startTime === 0) return state; // guard: don't tick when idle
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
      next = { ...state, mainTask: state.mainTask ? { ...state.mainTask, status: 'completed' } : null, execStatus: { ...state.execStatus, phase: 'done', tokens: action.payload.tokens, cost: action.payload.cost, currency: action.payload.currency, elapsed: state.execStatus.startTime > 0 ? Math.floor((Date.now() - state.execStatus.startTime) / 1000) : state.execStatus.elapsed } }; break;
    case 'EXEC_RESET':
      next = { ...state, execStatus: initialState.execStatus }; break;
    case 'TASK_CREATE': {
      const newTask = {
        id: state.tasks.length + 1,
        subject: action.payload.subject || '',
        description: action.payload.description || '',
        status: 'pending',
        toolUseId: action.payload.toolUseId || null,
        sdkTaskId: null,  // 等 tool result 回来才绑定
      };
      next = { ...state, tasks: [...state.tasks, newTask], taskCache: { ...state.taskCache, [state.currentSessionId || '__pending__']: { tasks: [...state.tasks, newTask], mainTask: state.mainTask } } }; break;
    }
    case 'TASK_BIND_ID': {
      // tool result 返回了 SDK taskId → 用 tool_use_id 精确绑定
      const { toolUseId, sdkTaskId } = action.payload;
      if (!toolUseId || sdkTaskId == null) return state;
      const tasks = [...state.tasks];
      for (let i = 0; i < tasks.length; i++) {
        if (tasks[i].toolUseId === toolUseId) {
          tasks[i] = { ...tasks[i], sdkTaskId };
          break;
        }
      }
      next = { ...state, tasks, taskCache: { ...state.taskCache, [state.currentSessionId || '__pending__']: { tasks, mainTask: state.mainTask } } }; break;
    }
    case 'TASK_UPDATE': {
      const rawId = action.payload.taskId;
      const numId = parseInt(rawId);
      let matched = false;
      const updated = state.tasks.map(t => {
        if (matched) return t;
        // 优先用 SDK taskId 精确匹配
        const hit = (!isNaN(numId) && t.sdkTaskId === numId) || (t.sdkTaskId !== null && String(t.sdkTaskId) === rawId);
        if (hit) {
          matched = true;
          return { ...t, status: action.payload.status || 'pending' };
        }
        return t;
      });
      if (!matched) {
        // 如果精确匹配失败，更新第一个未完成的任务（兜底）
        const fallback = updated.map(t => {
          if (matched) return t;
          if (t.status !== 'completed') {
            matched = true;
            return { ...t, status: action.payload.status || 'pending' };
          }
          return t;
        });
        next = { ...state, tasks: fallback, taskCache: { ...state.taskCache, [state.currentSessionId || '__pending__']: { tasks: fallback, mainTask: state.mainTask } } }; break;
      }
      next = { ...state, tasks: updated, taskCache: { ...state.taskCache, [state.currentSessionId || '__pending__']: { tasks: updated, mainTask: state.mainTask } } }; break;
    }
    case 'TASKS_CLEAR':
      next = { ...state, tasks: [], taskCache: { ...state.taskCache, [state.currentSessionId || '__pending__']: { tasks: [], mainTask: state.mainTask } } }; break;
    case 'SET_MAIN_TASK':
      next = { ...state, mainTask: { subject: action.payload.subject, status: 'in_progress' }, taskCache: { ...state.taskCache, [state.currentSessionId || '__pending__']: { tasks: state.tasks, mainTask: { subject: action.payload.subject, status: 'in_progress' } } } }; break;
    case 'UPDATE_MAIN_TASK':
      if (!state.mainTask) return state;
      next = { ...state, mainTask: { ...state.mainTask, subject: action.payload.subject }, taskCache: { ...state.taskCache, [state.currentSessionId || '__pending__']: { tasks: state.tasks, mainTask: { ...state.mainTask, subject: action.payload.subject } } } }; break;
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
  const selectSession = useCallback((id, isStreamingSession) => dispatch({ type: 'SELECT_SESSION', payload: id, isStreamingSession }), []);
  const setSessionId = useCallback((id) => dispatch({ type: 'SET_SESSION_ID', payload: id }), []);
  const setMessages = useCallback((messages, targetSessionId) => dispatch({ type: 'SET_MESSAGES', payload: messages, targetSessionId }), []);
  const appendMessage = useCallback((msg, targetSessionId) => dispatch({ type: 'APPEND_MESSAGE', payload: msg, targetSessionId }), []);
  const updateLastMessage = useCallback((content, targetSessionId) => dispatch({ type: 'UPDATE_LAST_MESSAGE', payload: content, targetSessionId }), []);
  const setStreaming = useCallback((v) => dispatch({ type: 'SET_STREAMING', payload: v }), []);
  const streamStart = useCallback((sessionId) => dispatch({ type: 'STREAM_START', payload: sessionId }), []);
  const streamEnd = useCallback((sessionId) => dispatch({ type: 'STREAM_END', payload: sessionId }), []);
  const setSessionExecStatus = useCallback((sid, phase, detail) => dispatch({ type: 'SESSION_EXEC_UPDATE', payload: { sid, status: { phase, detail } } }), []);
  const setScheduledTasks = useCallback((tasks) => dispatch({ type: 'SET_SCHEDULED_TASKS', payload: tasks }), []);
  const markTaskSessionRead = useCallback((sid) => dispatch({ type: 'MARK_TASK_SESSION_READ', payload: sid }), []);
  const addPendingTaskSession = useCallback((sid) => dispatch({ type: 'ADD_PENDING_TASK_SESSION', payload: sid }), []);
  const notifyTaskOutput = useCallback(() => dispatch({ type: 'NOTIFY_TASK_OUTPUT' }), []);
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
  const finalizeStreaming = useCallback(() => dispatch({ type: 'FINALIZE_STREAMING' }), []);
  const addTask = useCallback((subject, description, toolUseId) => dispatch({ type: 'TASK_CREATE', payload: { subject, description, toolUseId } }), []);
  const bindTaskId = useCallback((toolUseId, sdkTaskId) => dispatch({ type: 'TASK_BIND_ID', payload: { toolUseId, sdkTaskId } }), []);
  const updateTask = useCallback((taskId, status) => dispatch({ type: 'TASK_UPDATE', payload: { taskId, status } }), []);
  const clearTasks = useCallback(() => dispatch({ type: 'TASKS_CLEAR' }), []);
  const setMainTask = useCallback((subject) => dispatch({ type: 'SET_MAIN_TASK', payload: { subject } }), []);
  const updateMainTask = useCallback((subject) => dispatch({ type: 'UPDATE_MAIN_TASK', payload: { subject } }), []);

  // Load available models from built-in proxy provider on mount
  const loadAvailableModels = useCallback(async () => {
    try {
      const data = await listModels();
      dispatch({ type: 'SET_MODELS', payload: { models: data.models || [], groups: data.groups || {}, current: data.current || '' } });
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
      localStorage.setItem('claude-ui:displayMode', JSON.stringify(state.displayMode));
    } catch {}
  }, [state.currentProjectId, state.currentSessionId, state.theme, state.permissionLevel, state.model, state.systemPrompt, state.displayMode]);

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
    streamStart, streamEnd, setSessionExecStatus,
    setScheduledTasks, markTaskSessionRead, addPendingTaskSession, notifyTaskOutput,
    setView, toggleSidebar, setSetting,
    execStart, execPhase, execTick, execTokens, execDone, execReset,
    addTask, bindTaskId, updateTask, clearTasks, setMainTask, updateMainTask,
    setUpdateAvailable,
    loadAvailableModels, switchCurrentModel,
    triggerRestart, dismissRestart,
    finishAllStreaming,
    finalizeStreaming,
    setNeedInit,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppContextProvider');
  return ctx;
}
