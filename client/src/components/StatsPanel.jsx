import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { getStatsSummary, getStatsUsage, getUsers } from '../api';
import {
  AreaChart, Area, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { getIcon, IconBarChart, IconMail } from './icons';

const COLORS = ['#6366f1', '#22d3ee', '#f59e0b', '#ef4444', '#84cc16', '#a78bfa'];

const PRESETS = [
  { label: '1小时',  value: '1h',       granularity: 'hour',
    compute: (now) => ({ from: new Date(now.getTime() - 3600000), to: now }) },
  { label: '今天',   value: 'today',    granularity: 'hour',
    compute: (now) => ({ from: new Date(now.getFullYear(), now.getMonth(), now.getDate()), to: now }) },
  { label: '昨天',   value: 'yesterday', granularity: 'hour',
    compute: (now) => {
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { from: new Date(todayStart.getTime() - 86400000), to: todayStart };
    } },
  { label: '本周',   value: 'week',     granularity: 'day',
    compute: (now) => {
      const day = now.getDay(); // 0=Sun … 6=Sat
      const diff = day === 0 ? 6 : day - 1; // days back to Monday
      const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
      return { from: mon, to: now };
    } },
  { label: '本月',   value: 'month',    granularity: 'day',
    compute: (now) => ({ from: new Date(now.getFullYear(), now.getMonth(), 1), to: now }) },
  { label: '上周',   value: 'lastWeek', granularity: 'day',
    compute: (now) => {
      const day = now.getDay();
      const diff = day === 0 ? 6 : day - 1;
      const thisMon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
      const lastMon = new Date(thisMon.getTime() - 7 * 86400000);
      return { from: lastMon, to: thisMon };
    } },
  { label: '上月',   value: 'lastMonth', granularity: 'day',
    compute: (now) => ({
      from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      to: new Date(now.getFullYear(), now.getMonth(), 1),
    }) },
];

function fmtTok(n) {
  if (!n && n !== 0) return '0';
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return String(n);
}

function fmtCost(n) {
  if (n == null) return '0';
  return n.toFixed(4);
}

export default function StatsPanel() {
  const { user } = useApp();
  const isAdmin = user?.role === 'admin';

  const [preset, setPreset] = useState('week');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');

  const [summary, setSummary] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Load user list for admin
  useEffect(() => {
    if (isAdmin) {
      getUsers().then(d => setUsers(d.users || [])).catch(() => {});
    }
  }, [isAdmin]);

  const loadData = useCallback(async (from, to, gran) => {
    setLoading(true);
    setError('');
    try {
      const params = { from, to, granularity: gran };
      if (selectedUserId) params.userId = selectedUserId;
      const [s, u] = await Promise.all([
        getStatsSummary(params),
        getStatsUsage(params),
      ]);
      setSummary(s);
      setUsage(u);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }, [selectedUserId]);

  // Reload on preset/custom/user change
  useEffect(() => {
    if (showCustom && customFrom && customTo) {
      loadData(
        new Date(customFrom).toISOString(),
        new Date(customTo + 'T23:59:59').toISOString(),
        'day'
      );
    } else {
      const p = PRESETS.find(x => x.value === preset) || PRESETS[0];
      const { from, to } = p.compute(new Date());
      loadData(from.toISOString(), to.toISOString(), p.granularity);
    }
  }, [preset, showCustom, customFrom, customTo, selectedUserId, loadData]);

  const handlePresetClick = (p) => {
    setPreset(p.value);
    setShowCustom(false);
  };

  const handleCustomApply = () => {
    if (customFrom && customTo) {
      setShowCustom(true);
    }
  };

  const summaryCards = summary ? [
    { label: '总 Tokens', value: fmtTok(summary.totalTokens), icon: getIcon('barChart') },
    { label: '总花费', value: `${summary.currency || '¥'}${fmtCost(summary.totalCost)}`, icon: getIcon('dollar') },
    { label: '会话数', value: summary.sessionCount, icon: getIcon('chat') },
    { label: '主力模型', value: summary.topModel || '—', icon: getIcon('bot') },
  ] : [];

  return (
    <div className="stats-panel">
      <h2><IconBarChart/> 统计</h2>

      {/* Time range & user filter */}
      <div className="stats-controls">
        <div className="stats-presets">
          {PRESETS.map(p => (
            <button key={p.value}
              className={`stats-preset-btn ${!showCustom && preset === p.value ? 'active' : ''}`}
              onClick={() => handlePresetClick(p)}>
              {p.label}
            </button>
          ))}
          <button className={`stats-preset-btn ${showCustom ? 'active' : ''}`}
            onClick={() => setShowCustom(true)}>
            自定义
          </button>
        </div>

        {isAdmin && (
          <select className="stats-user-select" value={selectedUserId}
            onChange={e => setSelectedUserId(e.target.value)}>
            <option value="">仅自己</option>
            {users.map(u => (
              <option key={u.id} value={u.id}>{u.username} ({u.role === 'admin' ? '管理员' : '用户'})</option>
            ))}
          </select>
        )}
      </div>

      {/* Custom date range */}
      <div className={`stats-custom ${showCustom ? 'open' : ''}`}>
        <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
        <span>至</span>
        <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} />
        <button className="stats-apply-btn" onClick={handleCustomApply}>查询</button>
      </div>

      {/* Error state */}
      {error && <div className="stats-error">⚠ {error}</div>}

      {/* Loading state — only show on initial load when no data yet */}
      {loading && !summary && <div className="stats-loading">加载中…</div>}

      {/* Empty state */}
      {!loading && !error && summary && summary.sessionCount === 0 && (
        <div className="stats-empty">
          <div className="stats-empty-icon"><IconMail/></div>
          <div>暂无统计数据</div>
          <div className="stats-empty-hint">开始对话后，统计数据将在此展示</div>
        </div>
      )}

      {/* Subtle reload indicator — doesn't disrupt layout */}
      {loading && summary && <div className="stats-reloading">⟳ 刷新中…</div>}

      {/* Summary cards — stay visible during reload to prevent layout shift */}
      {summary && summary.sessionCount > 0 && (
        <>
          <div className="stats-cards">
            {summaryCards.map((c, i) => (
              <div key={i} className="stats-card">
                <div className="stats-card-icon">{c.icon}</div>
                <div className="stats-card-body">
                  <div className="stats-card-label">{c.label}</div>
                  <div className="stats-card-value" title={String(c.value)}>{c.value}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Charts */}
          {usage?.series?.length > 0 && (
            <>
              {/* Token trend — area chart */}
              <div className="stats-chart-card">
                <div className="stats-chart-header">Token 消耗趋势</div>
                <div className="stats-chart-wrap">
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={usage.series}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                      <XAxis dataKey="time" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                      <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={fmtTok} />
                      <Tooltip
                        contentStyle={{
                          background: 'var(--bg-primary)', border: '1px solid var(--glass-border)',
                          borderRadius: 8, fontSize: 12, color: 'var(--text-primary)',
                        }}
                        formatter={(val, name) => [fmtTok(val), name]}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area type="monotone" dataKey="input" name="输入" stackId="1" stroke="#6366f1" fill="#6366f1" fillOpacity={0.3} />
                      <Area type="monotone" dataKey="output" name="输出" stackId="1" stroke="#22d3ee" fill="#22d3ee" fillOpacity={0.3} />
                      <Area type="monotone" dataKey="cacheRead" name="缓存读取" stackId="1" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.3} />
                      <Area type="monotone" dataKey="cacheWrite" name="缓存写入" stackId="1" stroke="#ef4444" fill="#ef4444" fillOpacity={0.3} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Cost trend — line chart */}
              <div className="stats-chart-card">
                <div className="stats-chart-header">花费趋势</div>
                <div className="stats-chart-wrap">
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={usage.series}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                      <XAxis dataKey="time" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                      <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={v => `${v.toFixed(0)}`} />
                      <Tooltip
                        contentStyle={{
                          background: 'var(--bg-primary)', border: '1px solid var(--glass-border)',
                          borderRadius: 8, fontSize: 12, color: 'var(--text-primary)',
                        }}
                        formatter={(val) => [`${summary.currency || '¥'}${fmtCost(val)}`, '花费']}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Line type="monotone" dataKey="cost" name="花费" stroke="#6366f1" strokeWidth={2}
                        dot={{ r: 3, fill: '#6366f1' }} activeDot={{ r: 5 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Pie charts row */}
              <div className="stats-pie-row">
                {/* Model distribution */}
                <div className="stats-chart-card stats-pie-card">
                  <div className="stats-chart-header">模型分布</div>
                  <div className="stats-chart-wrap">
                    <ResponsiveContainer width="100%" height={260}>
                      <PieChart>
                        <Pie data={usage.byModel} dataKey="cost" nameKey="model"
                          cx="50%" cy="50%" outerRadius={90} innerRadius={50}
                          label={({ model, percent }) => `${model?.slice(0, 12)} ${(percent * 100).toFixed(0)}%`}>
                          {usage.byModel.map((_, i) => (
                            <Cell key={i} fill={COLORS[i % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            background: 'var(--bg-primary)', border: '1px solid var(--glass-border)',
                            borderRadius: 8, fontSize: 12, color: 'var(--text-primary)',
                          }}
                          formatter={(val) => [`${summary.currency || '¥'}${fmtCost(val)}`, '花费']}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Token type breakdown — from summary */}
                <div className="stats-chart-card stats-pie-card">
                  <div className="stats-chart-header">Token 类型占比</div>
                  <div className="stats-chart-wrap">
                    <ResponsiveContainer width="100%" height={260}>
                      <PieChart>
                        <Pie
                          data={(() => {
                            const raw = [
                              { name: '输入', value: summary.totalInput },
                              { name: '输出', value: summary.totalOutput },
                              { name: '缓存读取', value: summary.totalCacheRead },
                              { name: '缓存写入', value: summary.totalCacheWrite },
                            ];
                            return raw.filter(d => d.value > 0);
                          })()}
                          dataKey="value" nameKey="name"
                          cx="50%" cy="50%" outerRadius={90} innerRadius={50}
                          label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                          {(() => {
                            const raw = [
                              { name: '输入', value: summary.totalInput },
                              { name: '输出', value: summary.totalOutput },
                              { name: '缓存读取', value: summary.totalCacheRead },
                              { name: '缓存写入', value: summary.totalCacheWrite },
                            ];
                            return raw.filter(d => d.value > 0).map((_, i) => (
                              <Cell key={i} fill={COLORS[i % COLORS.length]} />
                            ));
                          })()}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            background: 'var(--bg-primary)', border: '1px solid var(--glass-border)',
                            borderRadius: 8, fontSize: 12, color: 'var(--text-primary)',
                          }}
                          formatter={(val) => [fmtTok(val), '']}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
