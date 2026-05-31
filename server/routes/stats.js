const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { STATS_DIR } = require('../config');
const { authMiddleware } = require('../middleware/auth');

// Ensure stats directory exists
if (!fs.existsSync(STATS_DIR)) {
  fs.mkdirSync(STATS_DIR, { recursive: true });
}

// Helper: read stats for a date range across monthly files
function readStats(fromISO, toISO) {
  const from = new Date(fromISO);
  const to = new Date(toISO);
  const results = [];

  // Iterate months from from to to
  const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
  while (cursor <= to) {
    const ym = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    const file = path.join(STATS_DIR, `${ym}.jsonl`);
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          const t = new Date(record.t);
          if (t >= from && t <= to) {
            results.push(record);
          }
        } catch {}
      }
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return results;
}

// Helper: aggregate records by time bucket
function aggregate(records, granularity) {
  const fmt = (d) => {
    switch (granularity) {
      case 'hour': return d.toISOString().slice(0, 13) + ':00';
      case 'day': return d.toISOString().slice(0, 10);
      case 'week': {
        const start = new Date(d);
        start.setDate(start.getDate() - start.getDay());
        return start.toISOString().slice(0, 10);
      }
      case 'month': return d.toISOString().slice(0, 7);
      default: return d.toISOString().slice(0, 10);
    }
  };

  const buckets = new Map();
  const modelAgg = new Map();

  for (const r of records) {
    const key = fmt(new Date(r.t));
    if (!buckets.has(key)) {
      buckets.set(key, { time: key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, count: 0 });
    }
    const b = buckets.get(key);
    b.input += r.input || 0;
    b.output += r.output || 0;
    b.cacheRead += r.cacheRead || 0;
    b.cacheWrite += r.cacheWrite || 0;
    b.cost += r.cost || 0;
    b.count++;

    const m = r.model || 'unknown';
    if (!modelAgg.has(m)) {
      modelAgg.set(m, { model: m, cost: 0, tokens: 0 });
    }
    const ma = modelAgg.get(m);
    ma.cost += r.cost || 0;
    ma.tokens += (r.input || 0) + (r.output || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0);
  }

  return {
    series: [...buckets.values()].sort((a, b) => a.time.localeCompare(b.time)),
    byModel: [...modelAgg.values()].sort((a, b) => b.cost - a.cost),
  };
}

// GET /api/stats/summary — summary for a user
router.get('/stats/summary', authMiddleware, (req, res) => {
  try {
    let userId = req.user.id;
    if (req.user.role === 'admin' && req.query.userId) {
      userId = parseInt(req.query.userId);
    }

    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString();
    const to = req.query.to || new Date().toISOString();

    const records = readStats(from, to).filter(r => r.userId === userId);

    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
    const modelCount = new Map();
    for (const r of records) {
      totalInput += r.input || 0;
      totalOutput += r.output || 0;
      totalCacheRead += r.cacheRead || 0;
      totalCacheWrite += r.cacheWrite || 0;
      totalCost += r.cost || 0;
      modelCount.set(r.model, (modelCount.get(r.model) || 0) + 1);
    }

    let topModel = '';
    let topCount = 0;
    for (const [m, c] of modelCount) {
      if (c > topCount) { topModel = m; topCount = c; }
    }

    res.json({
      totalTokens: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
      totalInput,
      totalOutput,
      totalCacheRead,
      totalCacheWrite,
      totalCost: Math.round(totalCost * 100000) / 100000,
      sessionCount: records.length,
      topModel,
      currency: records.length > 0 ? records[0].currency : '¥',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/usage — time series + model breakdown
router.get('/stats/usage', authMiddleware, (req, res) => {
  try {
    let userId = req.user.id;
    if (req.user.role === 'admin' && req.query.userId) {
      userId = parseInt(req.query.userId);
    }

    const granularity = req.query.granularity || 'day';
    const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString();
    const to = req.query.to || new Date().toISOString();

    const records = readStats(from, to).filter(r => r.userId === userId);
    const result = aggregate(records, granularity);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
