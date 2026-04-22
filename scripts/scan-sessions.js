#!/usr/bin/env node3
/**
 * Delegation Tracker — Parse OpenClaw session files and build usage stats
 * Run periodically (cron/heartbeat) to update delegation-stats.json
 */
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = '/home/lydstyl/.openclaw/agents';
const DATA_DIR = path.join(__dirname, '..', 'data');
const STATS_FILE = path.join(DATA_DIR, 'delegation-stats.json');

// Model pricing per 1M tokens (input/output) for reference
const MODEL_INFO = {
  'google/gemini-3-flash-preview':   { name: 'Gemini Flash', level: 0, priceIn: 0, priceOut: 0 },
  'google/gemma-4-26b-a4b-it':      { name: 'Gemma 26B', level: 1, priceIn: 0.20, priceOut: 0.20 },
  'google/gemma-4-31b-it':          { name: 'Gemma 31B', level: 2, priceIn: 0.23, priceOut: 0.23 },
  'deepseek/deepseek-v3.2':         { name: 'DeepSeek V3.2', level: 3, priceIn: 0.32, priceOut: 0.32 },
  'kwaipilot/kat-coder-pro-v2':     { name: 'KAT-Coder', level: 4, priceIn: 0.66, priceOut: 0.66 },
  'minimax/minimax-m2.7':           { name: 'MiniMax M2.7', level: 5, priceIn: 0.66, priceOut: 0.66 },
  'moonshotai/kimi-k2.5':           { name: 'Kimi K2.5', level: 6, priceIn: 0.92, priceOut: 0.92 },
  'z-ai/glm-5.1':                   { name: 'GLM-5.1', level: 7, priceIn: 1.83, priceOut: 1.83 },
  'moonshotai/kimi-k2.6':           { name: 'Kimi K2.6', level: 8, priceIn: 2.28, priceOut: 2.28 },
  'anthropic/claude-sonnet-4.6':     { name: 'Claude Sonnet 4.6', level: 9, priceIn: 7.80, priceOut: 7.80 },
  'stepfun/step-3.5-flash':         { name: 'Step 3.5 Flash', level: 0.5, priceIn: 0.15, priceOut: 0.15 },
};

function getModelInfo(modelId) {
  // Try exact match first
  if (MODEL_INFO[modelId]) return MODEL_INFO[modelId];
  // Try partial match
  for (const [key, info] of Object.entries(MODEL_INFO)) {
    if (modelId.includes(key) || key.includes(modelId)) return info;
  }
  return { name: modelId, level: -1, priceIn: 0, priceOut: 0 };
}

function parseSessionFile(filePath) {
  const results = [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    let sessionModel = null;
    let agentName = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        if (entry.type === 'session') {
          // Extract agent name from cwd
          if (entry.cwd) {
            const match = entry.cwd.match(/workspace-([^/]+)/);
            if (match) agentName = match[1];
          }
        }

        if (entry.type === 'model_change') {
          sessionModel = entry.modelId;
        }

        if (entry.type === 'message' && entry.message?.role === 'assistant') {
          const msg = entry.message;
          if (msg.usage && msg.usage.totalTokens > 0) {
            results.push({
              timestamp: entry.timestamp,
              agent: agentName || 'unknown',
              model: msg.model || sessionModel || 'unknown',
              tokensIn: msg.usage.input || 0,
              tokensOut: msg.usage.output || 0,
              tokensCacheRead: msg.usage.cacheRead || 0,
              tokensCacheWrite: msg.usage.cacheWrite || 0,
              totalTokens: msg.usage.totalTokens || 0,
              costTotal: msg.usage.cost?.total || 0,
              costInput: msg.usage.cost?.input || 0,
              costOutput: msg.usage.cost?.output || 0,
              costCacheRead: msg.usage.cost?.cacheRead || 0,
              stopReason: msg.stopReason || 'unknown',
            });
          }
        }
      } catch (e) { /* skip malformed lines */ }
    }
  } catch (e) { /* skip unreadable files */ }
  return results;
}

function scanAllSessions() {
  const allRecords = [];

  try {
    const agents = fs.readdirSync(AGENTS_DIR);
    for (const agent of agents) {
      const sessionsDir = path.join(AGENTS_DIR, agent, 'sessions');
      if (!fs.existsSync(sessionsDir)) continue;
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const records = parseSessionFile(path.join(sessionsDir, file));
        allRecords.push(...records);
      }
    }
  } catch (e) {
    console.error('Error scanning sessions:', e.message);
  }

  return allRecords;
}

function buildStats(records) {
  // Group by model
  const byModel = {};
  // Group by agent
  const byAgent = {};
  // Group by date
  const byDate = {};
  // Recent records (last 24h)
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent24h = [];

  let totalCost = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCalls = 0;
  let errors = 0;

  for (const r of records) {
    totalCost += r.costTotal;
    totalTokensIn += r.tokensIn;
    totalTokensOut += r.tokensOut;
    totalCalls++;
    if (r.stopReason === 'error' || r.stopReason === 'length') errors++;

    // By model
    const modelKey = r.model;
    if (!byModel[modelKey]) {
      byModel[modelKey] = { model: modelKey, ...getModelInfo(modelKey), calls: 0, tokensIn: 0, tokensOut: 0, cost: 0, errors: 0 };
    }
    byModel[modelKey].calls++;
    byModel[modelKey].tokensIn += r.tokensIn;
    byModel[modelKey].tokensOut += r.tokensOut;
    byModel[modelKey].cost += r.costTotal;
    if (r.stopReason === 'error' || r.stopReason === 'length') byModel[modelKey].errors++;

    // By agent
    if (!byAgent[r.agent]) byAgent[r.agent] = { calls: 0, cost: 0, tokensIn: 0, tokensOut: 0 };
    byAgent[r.agent].calls++;
    byAgent[r.agent].cost += r.costTotal;
    byAgent[r.agent].tokensIn += r.tokensIn;
    byAgent[r.agent].tokensOut += r.tokensOut;

    // By date
    const date = r.timestamp ? r.timestamp.slice(0, 10) : 'unknown';
    if (!byDate[date]) byDate[date] = { cost: 0, calls: 0, tokensIn: 0, tokensOut: 0, byModel: {} };
    byDate[date].cost += r.costTotal;
    byDate[date].calls++;
    byDate[date].tokensIn += r.tokensIn;
    byDate[date].tokensOut += r.tokensOut;
    if (!byDate[date].byModel[modelKey]) byDate[date].byModel[modelKey] = { calls: 0, cost: 0 };
    byDate[date].byModel[modelKey].calls++;
    byDate[date].byModel[modelKey].cost += r.costTotal;

    // Recent 24h
    if (new Date(r.timestamp).getTime() > oneDayAgo) recent24h.push(r);
  }

  // Sort by level
  const modelStats = Object.values(byModel).sort((a, b) => a.level - b.level);
  const agentStats = Object.entries(byAgent).sort((a, b) => b[1].cost - a[1].cost).map(([name, s]) => ({ name, ...s }));
  const dateStats = Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0])).map(([date, s]) => ({ date, ...s }));
  const last24hCost = recent24h.reduce((s, r) => s + r.costTotal, 0);
  const last24hCalls = recent24h.length;

  return {
    generatedAt: new Date().toISOString(),
    summary: { totalCost, totalTokensIn, totalTokensOut, totalCalls, errors, last24hCost, last24hCalls },
    byModel: modelStats,
    byAgent: agentStats,
    byDate: dateStats,
    recentRecords: recent24h.slice(-50), // Last 50 recent calls
  };
}

// Main
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

console.log('Scanning OpenClaw sessions...');
const records = scanAllSessions();
console.log(`Found ${records.length} API calls`);

const stats = buildStats(records);
fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
console.log(`Stats written to ${STATS_FILE}`);
console.log(`Total: ${stats.summary.totalCalls} calls, $${stats.summary.totalCost.toFixed(4)}, ${stats.summary.last24hCalls} calls last 24h ($${stats.summary.last24hCost.toFixed(4)})`);
