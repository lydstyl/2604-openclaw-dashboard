require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const axios   = require('axios');
const os      = require('os');
const fs      = require('fs');
const { execSync } = require('child_process');
const path    = require('path');

const app  = express();
app.use(express.json());
const PORT = 3015;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';
const OLLAMA_KEY = process.env.OLLAMA_KEY || '';
const KIMI_API_KEY = process.env.KIMI_API_KEY || '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const HA_TOKEN = process.env.HA_TOKEN || '';
const CPU_COUNT = os.cpus().length;
const GB = 1048576; // kB → GB

// ─── Credits History ───────────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'credits_history.json');
const MAX_HISTORY_DAYS = 30;
const MIN_INTERVAL_HOURS = 4;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    console.error('[credits-history] erreur lecture:', e.message);
  }
  return [];
}

function saveHistory(entries) {
  ensureDataDir();
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2));
}

function purgeOldEntries(entries) {
  const cutoff = Date.now() - MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  return entries.filter(e => new Date(e.timestamp).getTime() >= cutoff);
}

function recordCreditBalance(allCredits) {
  const entries = purgeOldEntries(loadHistory());
  const now = Date.now();
  // Vérifier qu'il n'y a pas déjà un point récent (moins de 4h)
  if (entries.length > 0) {
    const last = new Date(entries[entries.length - 1].timestamp).getTime();
    if (now - last < MIN_INTERVAL_HOURS * 60 * 60 * 1000) {
      return; // doublon trop récent
    }
  }
  const total = parseFloat(allCredits.total || '0');
  const orBal = allCredits.or && allCredits.or.ok ? parseFloat(allCredits.or.balance) : null;
  const kimiBal = allCredits.kimi && allCredits.kimi.ok ? parseFloat(allCredits.kimi.balance) : null;
  const dsBal = allCredits.deepseek && allCredits.deepseek.ok ? parseFloat(allCredits.deepseek.balance) : null;
  entries.push({
    timestamp: new Date().toISOString(),
    total: total,
    balances: { or: orBal, kimi: kimiBal, deepseek: dsBal }
  });
  saveHistory(entries);
  console.log(`[credits-history] point enregistré: total=${total}$ (${entries.length} pts)`);
}

async function collectCreditsPeriodically() {
  try {
    const credits = await getAllCredits();
    if (credits.ok) {
      recordCreditBalance(credits);
    } else {
      console.log(`[credits-history] collecte échouée, point non enregistré`);
    }
  } catch (e) {
    console.error('[credits-history] erreur collecte:', e.message);
  }
}

function startCreditsCollector() {
  ensureDataDir();
  // Premier relevé immédiat au démarrage
  collectCreditsPeriodically();
  // Puis toutes les 6 heures
  setInterval(collectCreditsPeriodically, 6 * 60 * 60 * 1000);
}

// ─── Ollama Usage ──────────────────────────────────────────────────────────
async function getOllamaUsage() {
  try {
    const r = await axios.post('https://ollama.com/api/me', {}, {
      headers: { Authorization: `Bearer ${OLLAMA_KEY}` },
      timeout: 5000,
    });
    return { plan: r.data.Plan || r.data.plan || '—', ok: true };
  } catch (e) {
    return { plan: '—', ok: false, error: e.message };
  }
}

// ─── Model Config (from openclaw.json) ──────────────────────────────────────
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
function getModelConfig() {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    const model = cfg.agents?.defaults?.model || {};
    const list = cfg.agents?.list || [];
    const mainAgent = list.find(a => a.id === 'main');
    return {
      primary: model.primary || (mainAgent ? mainAgent.model : '—'),
      fallbacks: model.fallbacks || [],
      models: cfg.agents?.defaults?.models || {},
    };
  } catch (e) {
    return { primary: '—', fallbacks: [], models: {} };
  }
}

function resolveModelName(modelId, models) {
  // Normaliser: enlever le préfixe de provider si présent pour chercher
  const alias = models[modelId]?.alias;
  if (alias) return `${modelId} → ${alias}`;
  // Chercher parmi les workers
  const list = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8')).agents?.list || [];
  const worker = list.find(a => a.model === modelId);
  if (worker) return worker.name || modelId;
  return modelId;
}

// ─── Spending calculation ──────────────────────────────────────────────────
function calcSpending() {
  try {
    const entries = loadHistory();
    const periodMs = 30 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - periodMs;
    const recent = entries.filter(e => new Date(e.timestamp).getTime() >= cutoff);

    if (recent.length < 2) return { or: 0, kimi: 0, deepseek: 0, total: 0 };

    // Somme des baisses de solde entre points consécutifs
    // → les rechargements (hausses) sont ignorés
    let orSpent = 0, kimiSpent = 0, dsSpent = 0;

    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1], curr = recent[i];

      // OpenRouter : balance (ancien format) ou balances.or (nouveau)
      const prevOR = parseFloat(prev.balances?.or ?? prev.balance ?? 0);
      const currOR = parseFloat(curr.balances?.or ?? curr.balance ?? 0);
      if (!isNaN(prevOR) && !isNaN(currOR)) orSpent += Math.max(0, prevOR - currOR);

      // Kimi : uniquement nouveau format
      const prevK = parseFloat(prev.balances?.kimi ?? 0);
      const currK = parseFloat(curr.balances?.kimi ?? 0);
      if (!isNaN(prevK) && !isNaN(currK) && (prev.balances?.kimi != null)) kimiSpent += Math.max(0, prevK - currK);

      // DeepSeek : uniquement nouveau format
      const prevD = parseFloat(prev.balances?.deepseek ?? 0);
      const currD = parseFloat(curr.balances?.deepseek ?? 0);
      if (!isNaN(prevD) && !isNaN(currD) && (prev.balances?.deepseek != null)) dsSpent += Math.max(0, prevD - currD);
    }

    return { or: orSpent, kimi: kimiSpent, deepseek: dsSpent, total: orSpent + kimiSpent + dsSpent };
  } catch (e) {
    return { or: 0, kimi: 0, deepseek: 0, total: 0 };
  }
}

// ─── Spending calculation (last 24 hours) ────────────────────────────────
function calcSpendingLast24h() {
  try {
    const entries = loadHistory();
    const periodMs = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - periodMs;
    const recent = entries.filter(e => new Date(e.timestamp).getTime() >= cutoff);

    if (recent.length < 2) return { or: 0, kimi: 0, deepseek: 0, total: 0 };

    let orSpent = 0, kimiSpent = 0, dsSpent = 0;

    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1], curr = recent[i];

      const prevOR = parseFloat(prev.balances?.or ?? prev.balance ?? 0);
      const currOR = parseFloat(curr.balances?.or ?? curr.balance ?? 0);
      if (!isNaN(prevOR) && !isNaN(currOR)) orSpent += Math.max(0, prevOR - currOR);

      const prevK = parseFloat(prev.balances?.kimi ?? 0);
      const currK = parseFloat(curr.balances?.kimi ?? 0);
      if (!isNaN(prevK) && !isNaN(currK) && (prev.balances?.kimi != null)) kimiSpent += Math.max(0, prevK - currK);

      const prevD = parseFloat(prev.balances?.deepseek ?? 0);
      const currD = parseFloat(curr.balances?.deepseek ?? 0);
      if (!isNaN(prevD) && !isNaN(currD) && (prev.balances?.deepseek != null)) dsSpent += Math.max(0, prevD - currD);
    }

    return { or: orSpent, kimi: kimiSpent, deepseek: dsSpent, total: orSpent + kimiSpent + dsSpent };
  } catch (e) {
    return { or: 0, kimi: 0, deepseek: 0, total: 0 };
  }
}

// ─── OpenRouter live usage (from /auth/key) ──────────────────────────────
async function getLiveUsage() {
  try {
    const r = await axios.get('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}` },
      timeout: 5000,
    });
    const d = r.data.data;
    return { usage: d.usage || 0, usageMonthly: d.usage_monthly || 0, ok: true };
  } catch (e) {
    return { usage: 0, usageMonthly: 0, ok: false };
  }
}

async function getCredits() {
  try {
    const r = await axios.get('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}` },
      timeout: 5000,
    });
    const d = r.data.data;
    return { balance: (d.total_credits - d.total_usage).toFixed(2), total: d.total_credits.toFixed(2), used: d.total_usage.toFixed(2), ok: true };
  } catch (e) {
    return { balance: '—', total: '—', used: '—', ok: false, error: e.message };
  }
}

async function getKimiCredits() {
  try {
    const r = await axios.get('https://api.moonshot.ai/v1/users/me/balance', {
      headers: { Authorization: `Bearer ${KIMI_API_KEY}` },
      timeout: 5000,
    });
    const cash = parseFloat(r.data.data?.cash_balance || 0);
    const voucher = parseFloat(r.data.data?.voucher_balance || 0);
    return { balance: (cash + voucher).toFixed(2), ok: true };
  } catch (e) {
    return { balance: '—', ok: false, error: e.message };
  }
}

async function getDeepSeekCredits() {
  try {
    const r = await axios.get('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      timeout: 5000,
    });
    const bal = parseFloat(r.data.balance_infos?.[0]?.total_balance || r.data.balance || 0);
    return { balance: bal.toFixed(2), ok: true };
  } catch (e) {
    return { balance: '—', ok: false, error: e.message };
  }
}

async function getAllCredits() {
  const [or, kimi, deepseek] = await Promise.all([getCredits(), getKimiCredits(), getDeepSeekCredits()]);
  let total = 0;
  if (or.ok && or.balance !== '—') total += parseFloat(or.balance);
  if (kimi.ok && kimi.balance !== '—') total += parseFloat(kimi.balance);
  if (deepseek.ok && deepseek.balance !== '—') total += parseFloat(deepseek.balance);
  return {
    or, kimi, deepseek,
    total: total.toFixed(2),
    ok: or.ok || kimi.ok || deepseek.ok
  };
}

// ─── Disk ──────────────────────────────────────────────────────────────────
function getDisk() {
  try {
    const { execSync } = require('child_process');
    const output = execSync('df -B1 /host', { encoding: 'utf8' });
    const lines = output.trim().split('\n');
    if (lines.length < 2) throw new Error('df output unexpected');
    // Alpine df peut wrapper → joindre toutes les lignes après le header
    const dataLine = lines.slice(1).join(' ');
    const parts = dataLine.trim().split(/\s+/);
    const totalBytes  = parseInt(parts[1]);
    const usedBytes   = parseInt(parts[2]);
    const availBytes  = parseInt(parts[3]);
    const GB_DIV = 1073741824;
    return {
      total:   (totalBytes / GB_DIV).toFixed(1),
      used:    (usedBytes  / GB_DIV).toFixed(1),
      avail:   (availBytes / GB_DIV).toFixed(1),
      usedPct: ((usedBytes / totalBytes) * 100).toFixed(1),
    };
  } catch (e) {
    return { total: '—', used: '—', avail: '—', usedPct: '0', error: e.message };
  }
}

// ─── Memory ────────────────────────────────────────────────────────────────
function parseMeminfo() {
  const raw = fs.readFileSync('/proc/meminfo', 'utf8');
  const get = key => {
    const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? parseInt(m[1]) : 0;
  };
  const total     = get('MemTotal');
  const free      = get('MemFree');
  const available = get('MemAvailable');
  const buffers   = get('Buffers');
  const cached    = get('Cached');
  const swapTotal = get('SwapTotal');
  const swapFree  = get('SwapFree');
  const usedByApps = total - available;   // RAM réellement utilisée par les processus
  const cache      = buffers + cached;    // cache disque (libérable instantanément)
  return {
    total:      (total      / GB).toFixed(2),
    available:  (available  / GB).toFixed(2),
    usedByApps: (usedByApps / GB).toFixed(2),
    cache:      (cache      / GB).toFixed(2),
    free:       (free       / GB).toFixed(2),
    swapTotal:  (swapTotal  / GB).toFixed(2),
    swapFree:   (swapFree   / GB).toFixed(2),
    swapUsed:   ((swapTotal - swapFree) / GB).toFixed(2),
    appsPct:    ((usedByApps / total) * 100).toFixed(1),
    proxmoxPct: (((total - free) / total) * 100).toFixed(1),
  };
}

// ─── System ────────────────────────────────────────────────────────────────
function getSystem() {
  const mem    = parseMeminfo();
  const load1  = os.loadavg()[0];
  const cpuPct = Math.min(100, (load1 / CPU_COUNT) * 100).toFixed(1);
  return { cpuPct, load1: load1.toFixed(2), cpuCount: CPU_COUNT, mem, uptime: formatUptime(os.uptime()) };
}

function formatUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}j ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─── UI Helpers ────────────────────────────────────────────────────────────
function bar(pct, color, bg) {
  const w = Math.min(100, Math.max(0, parseFloat(pct)));
  return `<div class="bar-bg"><div class="bar-fill" style="width:${w}%;background:${color}"></div>${bg ? `<div class="bar-fill bar-cache" style="width:${bg}%;background:#2a2a2a"></div>` : ''}</div>`;
}

function cpuColor(p) { return p < 50 ? '#4ade80' : p < 80 ? '#facc15' : '#f87171'; }
function ramColor(p) { return p < 50 ? '#4ade80' : p < 75 ? '#facc15' : '#f87171'; }
function diskColor(p) { return p < 60 ? '#4ade80' : p < 85 ? '#facc15' : '#f87171'; }
function creditColor(b) {
  const v = parseFloat(b);
  if (isNaN(v)) return '#6b7280';
  return v > 2 ? '#4ade80' : v > 0.5 ? '#facc15' : '#f87171';
}
function tag(cond1, cond2, l1, l2, l3) {
  return cond1 ? `<span class="tag tag-green">${l1}</span>`
       : cond2 ? `<span class="tag tag-yellow">${l2}</span>`
               : `<span class="tag tag-red">${l3}</span>`;
}

// ─── Card Visibility ────────────────────────────────────────
const VISIBILITY_FILE = path.join(DATA_DIR, 'card_visibility.json');

const DEFAULT_VISIBILITY = {
  'credits': true, 'spending-30d': true, 'spending-24h': true,
  'cpu': true, 'ram': true, 'disk': true, 'ollama': true,
  'pc-gabriel': true, 'pc-louis': true, 'pc-marie': true, 'chart': true
};

function loadCardVisibility() {
  try {
    if (fs.existsSync(VISIBILITY_FILE)) {
      const data = JSON.parse(fs.readFileSync(VISIBILITY_FILE, 'utf8'));
      return { ...DEFAULT_VISIBILITY, ...data };
    }
  } catch (e) { console.error('[card-visibility] erreur lecture:', e.message); }
  return { ...DEFAULT_VISIBILITY };
}

function saveCardVisibility(config) {
  ensureDataDir();
  fs.writeFileSync(VISIBILITY_FILE, JSON.stringify(config, null, 2));
}

// ─── Routes ────────────────────────────────────────────────────────────────

// API: credits history
app.get('/api/credits-history', (req, res) => {
  const entries = loadHistory();
  res.json(entries);
});

// API: delegation stats
app.get('/api/delegation-stats', (req, res) => {
  try {
    // Refresh stats on each API call (fast enough)
    execSync('node ' + path.join(__dirname, 'scripts', 'scan-sessions.js'), { timeout: 15000 });
  } catch (e) { /* use cached data */ }
  const statsFile = path.join(__dirname, 'data', 'delegation-stats.json');
  try {
    const data = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    res.json(data);
  } catch (e) {
    res.json({ error: 'Stats not available', summary: { totalCost: 0, totalCalls: 0, last24hCost: 0, last24hCalls: 0 } });
  }
});

// ─── PC Health Cache ─────────────────────────────────────────────────
const pcCache = { gabriel: null, louis: null, marie: null, gabrielOk: false, louisOk: false, marieOk: false };

async function fetchPcHealth(name, host, port) {
  const http = require('http');
  try {
    return await new Promise((resolve, reject) => {
      let req;
      const timeout = setTimeout(() => { if (req) req.destroy(); reject(new Error('SSE read timeout')); }, 7000);
      req = http.get(`http://${host}:${port}/events`, (res) => {
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString();
          const m = buf.match(/^data:\s*(\{.*?\})\n\n/m);
          if (m) {
            clearTimeout(timeout);
            req.destroy();
            try {
              const data = JSON.parse(m[1]);
              pcCache[name] = data;
              pcCache[name + 'Ok'] = true;
              resolve(data);
            } catch (e) { reject(new Error('JSON parse error')); }
          }
        });
        res.on('error', (e) => { clearTimeout(timeout); reject(e); });
      });
      req.on('error', (e) => { clearTimeout(timeout); reject(e); });
    });
  } catch (e) {
    if (!pcCache[name]) pcCache[name] = { error: e.message };
    pcCache[name + 'Ok'] = false;
    return pcCache[name];
  }
}

function startPcCache() {
  const update = async () => {
    await Promise.all([
      fetchPcHealth('gabriel', '192.168.3.102', 3019),
      fetchPcHealth('louis', '192.168.3.102', 3018),
      fetchPcHealth('marie', '192.168.3.102', 3024),
    ]);
  };
  update(); // first fetch immediately
  setInterval(update, 8000); // then every 8s
}

// API: PC Gabriel
app.get('/api/pc-gabriel', (req, res) => {
  res.json(pcCache.gabriel || { error: 'Waiting for data…' });
});

// API: PC Louis
app.get('/api/pc-louis', (req, res) => {
  res.json(pcCache.louis || { error: 'Waiting for data…' });
});

// API: PC Marie
app.get('/api/pc-marie', (req, res) => {
  res.json(pcCache.marie || { error: 'Waiting for data…' });
});

// API: card visibility
app.get('/api/card-visibility', (req, res) => {
  res.json(loadCardVisibility());
});

app.post('/api/card-visibility', (req, res) => {
  try {
    const { cardId, visible } = req.body;
    const cfg = loadCardVisibility();
    if (cardId in cfg) {
      cfg[cardId] = visible;
      saveCardVisibility(cfg);
      res.json({ ok: true, cardId, visible });
    } else {
      res.status(400).json({ ok: false, error: 'Carte inconnue: ' + cardId });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Home Assistant Smart Plug Control ───────────────────────────
const HA_BASE = 'http://192.168.3.167:8123';
const HA_HEADERS = { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' };

function getPlugEntity(name) {
  if (name === 'louis') return 'switch.bouilloire_commutateur';
  if (name === 'marie') return 'switch.prise3';
  return null;
}

// API: get plug state
app.get('/api/pc-plug-state/:name', async (req, res) => {
  const entityId = getPlugEntity(req.params.name);
  if (!entityId) return res.json({ ok: false, error: 'PC inconnu' });
  try {
    const r = await axios.get(`${HA_BASE}/api/states/${entityId}`, { headers: HA_HEADERS, timeout: 5000 });
    res.json({ ok: true, state: r.data.state, entity_id: entityId });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// API: toggle PC smart plug
app.post('/api/pc-toggle-plug', async (req, res) => {
  const { name } = req.body;
  const entityId = getPlugEntity(name);
  if (!entityId) return res.json({ ok: false, error: 'PC inconnu' });
  try {
    const stateR = await axios.get(`${HA_BASE}/api/states/${entityId}`, { headers: HA_HEADERS, timeout: 5000 });
    const currentState = stateR.data.state;
    const newAction = currentState === 'on' ? 'turn_off' : 'turn_on';
    await axios.post(`${HA_BASE}/api/services/switch/${newAction}`, { entity_id: entityId }, { headers: HA_HEADERS, timeout: 5000 });
    res.json({ ok: true, state: newAction.replace('turn_', ''), entity_id: entityId });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Main dashboard
app.get('/', async (req, res) => {
  const spending = calcSpending();
  const spending24h = calcSpendingLast24h();
  const [credits, sys, ollama, live] = await Promise.all([getAllCredits(), Promise.resolve(getSystem()), getOllamaUsage(), getLiveUsage()]);
  const mem = sys.mem;
  const disk = getDisk();
  const cc  = cpuColor(parseFloat(sys.cpuPct));
  const rc  = ramColor(parseFloat(mem.appsPct));
  const dc  = diskColor(parseFloat(disk.usedPct));
  const kc  = creditColor(credits.total);
  const ts  = new Date().toLocaleTimeString('fr-FR');
  const cachePct = ((parseFloat(mem.cache) / parseFloat(mem.total)) * 100).toFixed(1);

  // ─── Delegation Tracker (server-rendered) ────────────────────────────
  let delegationHtml = '';

  // ─── Card visibility ─────────────────────────────────────────
  const visibility = loadCardVisibility();
  function vis(id) { return visibility[id] !== false; }
  function visHidden(id) { return !vis(id) ? 'card-hidden' : ''; }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.end(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<meta http-equiv="Cache-Control" content="no-store">
<title>Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0a0a;color:#e0e0e0;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;padding:2rem}
  header{display:flex;justify-content:space-between;align-items:center;margin-bottom:2rem;flex-wrap:wrap;gap:1rem}
  h1{font-size:1.4rem;color:#fff;letter-spacing:-0.02em}
  .subtitle{color:#555;font-size:0.8rem;margin-top:0.2rem}
  .refresh-info{color:#444;font-size:0.75rem;text-align:right}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.25rem}
  .card{background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:1.5rem}
  .card-header{display:flex;align-items:center;gap:0.6rem;margin-bottom:1.25rem}
  .icon{font-size:1.2rem}
  .card-title{font-size:0.75rem;color:#666;text-transform:uppercase;letter-spacing:0.08em;font-weight:600}
  .big-value{font-size:2.2rem;font-weight:700;line-height:1;margin-bottom:0.4rem}
  .big-value span{font-size:1rem;color:#666;font-weight:400;margin-left:0.25rem}
  .row{display:flex;justify-content:space-between;align-items:center;margin-top:0.6rem}
  .label{color:#555;font-size:0.8rem}
  .val{color:#aaa;font-size:0.8rem}
  .val-muted{color:#3a3a3a;font-size:0.75rem}
  .bar-bg{height:8px;background:#1a1a1a;border-radius:4px;margin-top:1rem;overflow:hidden;position:relative}
  .bar-fill{height:100%;border-radius:4px;transition:width 0.5s;position:absolute;top:0;left:0}
  .bar-cache{opacity:0.35}
  .tag{display:inline-block;padding:0.15rem 0.55rem;border-radius:20px;font-size:0.7rem;font-weight:600;margin-top:0.75rem}
  .tag-green{background:#14532d;color:#4ade80}
  .tag-yellow{background:#3b2f00;color:#facc15}
  .tag-red{background:#450a0a;color:#f87171}
  .error-note{color:#f87171;font-size:0.75rem;margin-top:0.5rem}
  .divider{border:none;border-top:1px solid #1a1a1a;margin:1rem 0}
  .note{background:#141414;border:1px solid #222;border-radius:8px;padding:0.75rem 1rem;margin-top:1rem;font-size:0.75rem;color:#555;line-height:1.5}
  .note strong{color:#3a3a3a}
  .chart-section{background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:1.5rem;margin-top:1.25rem}
  .chart-section .card-header{margin-bottom:1rem}
  .chart-container{position:relative;height:250px;width:100%}
  .chart-placeholder{color:#555;font-size:0.85rem;text-align:center;padding:3rem 0}
  footer{margin-top:2rem;color:#333;font-size:0.75rem;text-align:center}
  a{color:#333;text-decoration:none}a:hover{color:#666}
  /* PC Health cards */
  .pc-mini-bar{height:6px;background:#1a1a1a;border-radius:3px;margin-top:0.4rem;overflow:hidden}
  .pc-mini-fill{height:100%;border-radius:3px;transition:width 0.5s}
  .pc-row{display:flex;justify-content:space-between;align-items:center;font-size:0.78rem;margin-top:0.35rem}
  .pc-row .lbl{color:#555}
  .pc-row .val{color:#aaa;font-weight:500}
  .pc-status{display:inline-block;padding:0.1rem 0.5rem;border-radius:10px;font-size:0.65rem;font-weight:600}
  .pc-status.on{background:#14532d;color:#4ade80}
  .pc-status.off{background:#450a0a;color:#f87171}
  .pc-llm{font-size:0.72rem;color:#9ca3af;margin-top:0.3rem}
  .pc-llm strong{color:#e0e0e0;font-weight:500}
  /* Alertes */
  .alert-banner{display:none;background:#1a0a0a;border:1px solid #7f1d1d;border-radius:8px;padding:0.6rem 1rem;margin-bottom:1.25rem;font-size:0.8rem;gap:1rem;flex-wrap:wrap}
  .alert-banner.show{display:flex}
  .alert-banner-item{display:flex;align-items:center;gap:0.5rem;color:#fca5a5}
  .alert-banner-dot{width:8px;height:8px;border-radius:50%;background:#f87171;animation:alert-pulse 1.5s infinite}
  @keyframes alert-pulse{0%,100%{opacity:1}50%{opacity:0.3}}
  .alert-badge{display:inline-flex;align-items:center;gap:0.2rem;padding:0.08rem 0.4rem;border-radius:8px;font-size:0.6rem;font-weight:600;background:#450a0a;color:#f87171;margin-left:0.3rem}
  .alert-badge.warn{background:#3b2f00;color:#facc15}
  .alert-toggle{display:inline-flex;align-items:center;gap:0.35rem;cursor:pointer;font-size:0.62rem;color:#555;user-select:none;margin-left:auto}
  .alert-toggle input{display:none}
  .alert-toggle .slider{width:26px;height:13px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:7px;position:relative;transition:background 0.2s;flex-shrink:0}
  .alert-toggle .slider::after{content:'';position:absolute;top:1.5px;left:2px;width:8px;height:8px;background:#555;border-radius:50%;transition:all 0.2s}
  .alert-toggle input:checked+.slider{background:#312e81;border-color:#5b21b6}
  .alert-toggle input:checked+.slider::after{background:#818cf8;left:15px}

  /* PC Action buttons */
  .pc-actions{display:flex;gap:0.4rem;align-items:center;margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid #1a1a1a;flex-wrap:wrap}
  .pc-btn{background:#1a1a2e;color:#818cf8;border:1px solid #312e81;border-radius:6px;padding:0.25rem 0.6rem;font-size:0.68rem;cursor:pointer;transition:all 0.2s;font-family:inherit}
  .pc-btn:hover{background:#272160;border-color:#4f46e5}
  .pc-btn:active{transform:scale(0.97)}
  .pc-btn:disabled{opacity:0.4;cursor:not-allowed}
  .pc-btn-danger{background:#2a0a0a;color:#f87171;border-color:#7f1d1d}
  .pc-btn-danger:hover{background:#3b0a0a;border-color:#dc2626}
  .pc-plug-toggle{display:inline-flex;align-items:center;gap:0.3rem;cursor:pointer;font-size:0.72rem;color:#888;padding:0.15rem 0.35rem;user-select:none}
  .pc-plug-slider{width:28px;height:14px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:7px;position:relative;transition:all 0.2s;flex-shrink:0;display:inline-block}
  .pc-plug-slider::after{content:'';position:absolute;top:1.5px;left:2px;width:8px;height:8px;background:#555;border-radius:50%;transition:all 0.2s}
  .pc-plug-toggle.on .pc-plug-slider{background:#14532d;border-color:#22c55e}
  .pc-plug-toggle.on .pc-plug-slider::after{background:#4ade80;left:17px}
  .pc-plug-toggle.off .pc-plug-slider{background:#2a0a0a;border-color:#7f1d1d}
  .pc-plug-toggle.off .pc-plug-slider::after{background:#f87171;left:2px}
  .pc-plug-status{font-weight:600;font-size:0.68rem;min-width:2.5rem}
  .pc-plug-toggle.on .pc-plug-status{color:#4ade80}
  .pc-plug-toggle.off .pc-plug-status{color:#f87171}
  .pc-auto-label{display:inline-flex;align-items:center;gap:0.3rem;cursor:pointer;font-size:0.65rem;color:#666;margin-left:auto;user-select:none}
  .pc-auto-label input{display:none}
  .pc-auto-label .slider{width:24px;height:12px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:7px;position:relative;transition:background 0.2s;flex-shrink:0}
  .pc-auto-label .slider::after{content:'';position:absolute;top:1.5px;left:2px;width:7px;height:7px;background:#555;border-radius:50%;transition:all 0.2s}
  .pc-auto-label input:checked+.slider{background:#14532d;border-color:#22c55e}
  .pc-auto-label input:checked+.slider::after{background:#4ade80;left:14px}
  .pc-action-result{font-size:0.62rem;color:#888;margin-top:0.3rem;min-height:1rem}
  /* Card visibility */
  .card-hidden{display:none!important}
  .settings-btn{background:none;border:none;color:#555;cursor:pointer;font-size:1.1rem;padding:0.15rem 0.35rem;border-radius:6px;transition:all 0.2s;line-height:1}
  .settings-btn:hover{color:#aaa;background:#1a1a1a}
  .settings-btn.active{color:#818cf8;background:#1a1a2e}
  .settings-panel{display:none;background:#0d0d0d;border:1px solid #222;border-radius:10px;padding:0.75rem 1rem;margin-bottom:1.25rem}
  .settings-panel.show{display:block}
  .settings-title{font-size:0.7rem;color:#555;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.5rem}
  .settings-row{display:flex;align-items:center;gap:0.5rem;padding:0.3rem 0;cursor:pointer;border-radius:6px;transition:background 0.15s}
  .settings-row:hover{background:#151515}
  .settings-row input[type=checkbox]{display:none}
  .settings-row .s-toggle{width:28px;height:14px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:7px;position:relative;transition:all 0.2s;flex-shrink:0}
  .settings-row .s-toggle::after{content:'';position:absolute;top:1.5px;left:2px;width:8px;height:8px;background:#555;border-radius:50%;transition:all 0.2s}
  .settings-row input:checked+.s-toggle{background:#1e3a5f;border-color:#3b82f6}
  .settings-row input:checked+.s-toggle::after{background:#60a5fa;left:16px}
  .settings-row .s-label{font-size:0.75rem;color:#aaa;flex:1}
  .settings-row .s-icon{font-size:0.9rem}
  .settings-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:0.2rem}
</style>
</head>
<body>
<header>
  <div>
    <h1>Dashboard</h1>
    <div class="subtitle">192.168.3.102 &nbsp;·&nbsp; uptime ${sys.uptime}</div>
  </div>
  <div style="display:flex;align-items:center;gap:0.6rem">
    <button id="settingsBtn" class="settings-btn" onclick="toggleSettings()" title="Afficher/masquer des cartes">⚙️</button>
    <div class="refresh-info">Auto-refresh 30s &nbsp;·&nbsp; ${ts}</div>
  </div>
</header>

<!-- Bannière d'alertes -->
<div id="alert-banner" class="alert-banner"></div>

<!-- Panneau de configuration des cartes -->
<div id="settings-panel" class="settings-panel">
  <div class="settings-title">🔄 Cartes à afficher</div>
  <div class="settings-grid">
    <label class="settings-row" data-card-id="credits"><span class="s-icon">💳</span><input type="checkbox"${vis('credits')?' checked':''}><span class="s-toggle"></span><span class="s-label">Crédits</span></label>
    <label class="settings-row" data-card-id="spending-30d"><span class="s-icon">📊</span><input type="checkbox"${vis('spending-30d')?' checked':''}><span class="s-toggle"></span><span class="s-label">Dépenses 30j</span></label>
    <label class="settings-row" data-card-id="spending-24h"><span class="s-icon">⏰</span><input type="checkbox"${vis('spending-24h')?' checked':''}><span class="s-toggle"></span><span class="s-label">Dépenses 24h</span></label>
    <label class="settings-row" data-card-id="cpu"><span class="s-icon">🖥️</span><input type="checkbox"${vis('cpu')?' checked':''}><span class="s-toggle"></span><span class="s-label">CPU</span></label>
    <label class="settings-row" data-card-id="ram"><span class="s-icon">🧠</span><input type="checkbox"${vis('ram')?' checked':''}><span class="s-toggle"></span><span class="s-label">RAM</span></label>
    <label class="settings-row" data-card-id="disk"><span class="s-icon">💾</span><input type="checkbox"${vis('disk')?' checked':''}><span class="s-toggle"></span><span class="s-label">Disque dur</span></label>
    <label class="settings-row" data-card-id="ollama"><span class="s-icon">🦙</span><input type="checkbox"${vis('ollama')?' checked':''}><span class="s-toggle"></span><span class="s-label">Ollama Cloud</span></label>
    <label class="settings-row" data-card-id="pc-gabriel"><span class="s-icon">🖥️</span><input type="checkbox"${vis('pc-gabriel')?' checked':''}><span class="s-toggle"></span><span class="s-label">PC Gabriel</span></label>
    <label class="settings-row" data-card-id="pc-louis"><span class="s-icon">🖥️</span><input type="checkbox"${vis('pc-louis')?' checked':''}><span class="s-toggle"></span><span class="s-label">PC Louis</span></label>
    <label class="settings-row" data-card-id="pc-marie"><span class="s-icon">🖥️</span><input type="checkbox"${vis('pc-marie')?' checked':''}><span class="s-toggle"></span><span class="s-label">PC Marie</span></label>
    <label class="settings-row" data-card-id="chart"><span class="s-icon">📈</span><input type="checkbox"${vis('chart')?' checked':''}><span class="s-toggle"></span><span class="s-label">Graphique</span></label>
  </div>
</div>

<div class="grid">

  <!-- CREDITS -->
  <div class="card ${visHidden('credits')}" data-card-id="credits">
    <div class="card-header"><span class="icon">💳</span><span class="card-title">Crédits — Tous providers</span></div>
    <div class="big-value" style="color:${kc}">${credits.total}<span>$</span></div>
    <hr class="divider">
    <div class="row"><span class="label">OpenRouter</span><span class="val" style="color:${credits.or && credits.or.ok ? '#60a5fa' : '#888'}">${credits.or && credits.or.ok ? credits.or.balance + ' $' : '—'}</span></div>
    <div class="row"><span class="label">Kimi</span><span class="val" style="color:${credits.kimi && credits.kimi.ok ? '#a78bfa' : '#888'}">${credits.kimi && credits.kimi.ok ? credits.kimi.balance + ' $' : '—'}</span></div>
    <div class="row"><span class="label">DeepSeek</span><span class="val" style="color:${credits.deepseek && credits.deepseek.ok ? '#4ade80' : '#888'}">${credits.deepseek && credits.deepseek.ok ? credits.deepseek.balance + ' $' : '—'}</span></div>
    <a href="https://platform.deepseek.com/top_up" target="_blank" style="color:#4ade80;font-size:0.75rem;display:inline-block;margin-top:0.6rem">↗ Recharger DeepSeek</a>
  </div>

  <!-- DÉPENSES 30 JOURS -->
  <div class="card ${visHidden('spending-30d')}" data-card-id="spending-30d">
    <div class="card-header"><span class="icon">📊</span><span class="card-title">Dépenses — 30 derniers jours</span></div>
    <div class="big-value" style="color:#fbbf24;font-size:2.2rem">${spending.total.toFixed(2)}<span>$</span></div>
    <hr class="divider">
    <div class="row"><span class="label">OpenRouter (30j)</span><span class="val" style="color:#60a5fa">${spending.or.toFixed(2)} $</span></div>
    <div class="row"><span class="label">OpenRouter (ce mois, API)</span><span class="val" style="color:#60a5fa">${live.ok ? live.usageMonthly.toFixed(2) + ' $' : '—'}</span></div>
    <div class="row"><span class="label">Kimi</span><span class="val" style="color:#a78bfa">${spending.kimi.toFixed(2)} $</span></div>
    <div class="row"><span class="label">DeepSeek</span><span class="val" style="color:#4ade80">${spending.deepseek.toFixed(2)} $</span></div>
    <div class="note">Basé sur la somme des baisses de solde. Les rechargements ne sont pas comptés comme dépenses.</div>
  </div>

  <!-- DÉPENSES 24H -->
  <div class="card ${visHidden('spending-24h')}" data-card-id="spending-24h">
    <div class="card-header"><span class="icon">⏰</span><span class="card-title">Dépenses — 24 dernières heures</span></div>
    <div class="big-value" style="color:#fbbf24;font-size:2.2rem">${spending24h.total.toFixed(2)}<span>$</span></div>
    <hr class="divider">
    <div class="row"><span class="label">OpenRouter (24h)</span><span class="val" style="color:#60a5fa">${spending24h.or.toFixed(3)} $</span></div>
    <div class="row"><span class="label">Kimi (24h)</span><span class="val" style="color:#a78bfa">${spending24h.kimi.toFixed(3)} $</span></div>
    <div class="row"><span class="label">DeepSeek (24h)</span><span class="val" style="color:#4ade80">${spending24h.deepseek.toFixed(3)} $</span></div>
    <div class="note">Basé sur les relevés de solde ~toutes les 6h.</div>
  </div>

  <!-- CPU -->
  <div class="card ${visHidden('cpu')}" data-card-id="cpu">
    <div class="card-header"><span class="icon">🖥️</span><span class="card-title">CPU</span></div>
    <div class="big-value" style="color:${cc}">${sys.cpuPct}<span>%</span></div>
    ${bar(sys.cpuPct, cc)}
    <hr class="divider">
    <div class="row"><span class="label">Load avg (1m)</span><span class="val">${sys.load1}</span></div>
    <div class="row"><span class="label">Cœurs logiques</span><span class="val">${sys.cpuCount}</span></div>
    ${tag(parseFloat(sys.cpuPct) < 50, parseFloat(sys.cpuPct) < 80, '✓ Normal', '⚠ Élevé', '✕ Critique')}
  </div>

  <!-- RAM -->
  <div class="card ${visHidden('ram')}" data-card-id="ram">
    <div class="card-header"><span class="icon">🧠</span><span class="card-title">Mémoire RAM</span></div>
    <div class="big-value" style="color:${rc}">${mem.usedByApps}<span>GB apps</span></div>
    <div class="bar-bg">
      <div class="bar-fill" style="width:${Math.min(100,parseFloat(mem.appsPct))}%;background:${rc}"></div>
      <div class="bar-fill bar-cache" style="width:${Math.min(100,parseFloat(mem.appsPct)+parseFloat(cachePct))}%;background:#4ade80;opacity:0.12"></div>
    </div>
    <hr class="divider">
    <div class="row"><span class="label">Disponible pour apps</span><span class="val" style="color:#4ade80">${mem.available} GB</span></div>
    <div class="row"><span class="label">Cache disque (libérable)</span><span class="val-muted">${mem.cache} GB</span></div>
    <div class="row"><span class="label">Total VM</span><span class="val">${mem.total} GB</span></div>
    ${parseFloat(mem.swapUsed) > 0.01 ? `<div class="row"><span class="label">Swap utilisé</span><span class="val" style="color:#facc15">${mem.swapUsed} / ${mem.swapTotal} GB</span></div>` : ''}
    ${tag(parseFloat(mem.appsPct) < 50, parseFloat(mem.appsPct) < 75, '✓ Normal', '⚠ Élevé', '✕ Critique')}
    <div class="note">
      <strong>Proxmox affiche ${mem.proxmoxPct}% utilisé</strong> car il compte le cache disque.<br>
      Le vrai usage par les processus est <strong style="color:#aaa">${mem.appsPct}%</strong> — ${mem.available} GB sont librement disponibles.
    </div>
  </div>

  <!-- DISK -->
  <div class="card ${visHidden('disk')}" data-card-id="disk">
    <div class="card-header"><span class="icon">💾</span><span class="card-title">Disque dur</span></div>
    <div class="big-value" style="color:${dc}">${disk.used}<span>GB utilisés</span></div>
    ${bar(disk.usedPct, dc)}
    <hr class="divider">
    <div class="row"><span class="label">Espace libre</span><span class="val" style="color:#4ade80">${disk.avail} GB</span></div>
    <div class="row"><span class="label">Capacité totale</span><span class="val">${disk.total} GB</span></div>
    <div class="row"><span class="label">Utilisation</span><span class="val">${disk.usedPct}%</span></div>
    ${tag(parseFloat(disk.usedPct) < 60, parseFloat(disk.usedPct) < 85, '✓ OK', '⚠ Rempli', '✕ Critique')}
  </div>

  <!-- OLLAMA CLOUD -->
  <div class="card ${visHidden('ollama')}" data-card-id="ollama">
    <div class="card-header"><span class="icon">🦙</span><span class="card-title">Ollama Cloud</span></div>
    <div class="big-value" style="color:#a78bfa">${ollama.plan}<span> plan</span></div>
    <hr class="divider">
    <a href="https://ollama.com/settings" target="_blank" style="color:#60a5fa;font-size:0.8rem">↗ Voir l'usage sur ollama.com</a>
    ${!ollama.ok ? `<p class="error-note">Erreur API : ${ollama.error}</p>` : ''}
  </div>

  <!-- PC GABRIEL -->
  <div class="card ${visHidden('pc-gabriel')}" data-card-id="pc-gabriel" id="pc-gabriel-card">
    <div class="card-header"><span class="icon">🖥️</span><span class="card-title">PC Gabriel <span id="pc-gabriel-time" style="color:#444;font-weight:400;margin-left:0.5rem;font-size:0.65rem"></span></span><label class="alert-toggle" title="Activer alertes CPU/RAM >80%"><input type="checkbox" id="alert-gabriel" checked><span class="slider"></span>🔔</label></div>
    <div id="pc-gabriel-body">
      <div style="text-align:center;padding:1rem 0;color:#555;font-size:0.8rem">⏳ Chargement…</div>
    </div>
    <div class="pc-actions" id="pc-gabriel-actions" style="display:none">
      <button class="pc-btn" onclick="pcAction('gabriel','start_llm')">▶ Lancer LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('gabriel','kill_llm')">⏹ Kill LLM</button>
      <label class="pc-auto-label" title="Kill automatique du LLM si RAM > 90%">
        <input type="checkbox" id="auto-kill-gabriel">
        <span>Auto-kill RAM &gt;90%</span>
      </label>
    </div>
  </div>

  <!-- PC LOUIS -->
  <div class="card ${visHidden('pc-louis')}" data-card-id="pc-louis" id="pc-louis-card">
    <div class="card-header"><span class="icon">🖥️</span><span class="card-title">PC Louis <span id="pc-louis-time" style="color:#444;font-weight:400;margin-left:0.5rem;font-size:0.65rem"></span></span><label class="alert-toggle" title="Activer alertes CPU/RAM >80%"><input type="checkbox" id="alert-louis" checked><span class="slider"></span>🔔</label></div>
    <div id="pc-louis-body">
      <div style="text-align:center;padding:1rem 0;color:#555;font-size:0.8rem">⏳ Chargement…</div>
    </div>
    <div class="pc-actions" id="pc-louis-actions" style="display:none">
      <button class="pc-btn" onclick="pcAction('louis','start_llm')">▶ Lancer LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('louis','kill_llm')">⏹ Kill LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('louis','shutdown')">⏻ Éteindre</button>
      <label class="pc-plug-toggle" id="pc-louis-plug-toggle" title="Allumer/éteindre la prise">🔌 <span class="pc-plug-slider" id="pc-louis-plug-slider"></span><span class="pc-plug-status" id="pc-louis-plug-status">❓</span></label>
      <label class="pc-auto-label" title="Kill automatique du LLM si RAM > 90%">
        <input type="checkbox" id="auto-kill-louis">
        <span>Auto-kill RAM &gt;90%</span>
      </label>
    </div>
  </div>

  <!-- PC MARIE -->
  <div class="card ${visHidden('pc-marie')}" data-card-id="pc-marie" id="pc-marie-card">
    <div class="card-header"><span class="icon">🖥️</span><span class="card-title">PC Marie <span id="pc-marie-time" style="color:#444;font-weight:400;margin-left:0.5rem;font-size:0.65rem"></span></span><label class="alert-toggle" title="Activer alertes CPU/RAM >80%"><input type="checkbox" id="alert-marie" checked><span class="slider"></span>🔔</label></div>
    <div id="pc-marie-body">
      <div style="text-align:center;padding:1rem 0;color:#555;font-size:0.8rem">⏳ Chargement…</div>
    </div>
    <div class="pc-actions" id="pc-marie-actions" style="display:none">
      <button class="pc-btn" onclick="pcAction('marie','start_llm')">▶ Lancer LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('marie','kill_llm')">⏹ Kill LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('marie','shutdown')">⏻ Éteindre</button>
      <label class="pc-plug-toggle" id="pc-marie-plug-toggle" title="Allumer/éteindre la prise">🔌 <span class="pc-plug-slider" id="pc-marie-plug-slider"></span><span class="pc-plug-status" id="pc-marie-plug-status">❓</span></label>
      <label class="pc-auto-label" title="Kill automatique du LLM si RAM > 90%">
        <input type="checkbox" id="auto-kill-marie">
        <span>Auto-kill RAM &gt;90%</span>
      </label>
    </div>
  </div>

</div>

<!-- Chart Section -->
<div class="chart-section ${visHidden('chart')}" data-card-id="chart">
  <div class="card-header"><span class="icon">📈</span><span class="card-title">Évolution des crédits (30 jours)</span></div>
  <div id="chart-container" class="chart-container">
    <div id="chart-placeholder" class="chart-placeholder">Collecte de données en cours...</div>
    <canvas id="creditsChart"></canvas>
  </div>
</div>

<script>
(function() {
  fetch('/api/credits-history')
    .then(r => r.json())
    .then(data => {
      const placeholder = document.getElementById('chart-placeholder');
      const container = document.getElementById('chart-container');

      if (!data || data.length < 2) {
        placeholder.textContent = 'Collecte de données en cours...';
        return;
      }

      placeholder.style.display = 'none';

      // Filtrer les 7 derniers jours
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const filtered = data.filter(d => new Date(d.timestamp).getTime() >= cutoff);

      if (filtered.length < 2) {
        placeholder.textContent = 'Pas assez de données sur 30 jours...';
        return;
      }

      const labels = filtered.map(d => {
        const dt = new Date(d.timestamp);
        return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
      });
      const values = filtered.map(d => { const v = d.total !== undefined ? d.total : d.balance; return (typeof v === 'number') ? v : parseFloat(v || 0); });

      const ctx = document.getElementById('creditsChart').getContext('2d');
      const gradient = ctx.createLinearGradient(0, 0, 0, 250);
      gradient.addColorStop(0, 'rgba(74, 222, 128, 0.25)');
      gradient.addColorStop(1, 'rgba(74, 222, 128, 0.02)');

      new Chart(ctx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: 'Crédits (USD)',
            data: values,
            borderColor: '#4ade80',
            backgroundColor: gradient,
            borderWidth: 2,
            tension: 0.4,
            fill: true,
            pointRadius: 3,
            pointHoverRadius: 5,
            pointBackgroundColor: '#4ade80',
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#1a1a1a',
              titleColor: '#e0e0e0',
              bodyColor: '#4ade80',
              borderColor: '#333',
              borderWidth: 1,
              padding: 10,
              displayColors: false,
              callbacks: {
                label: function(context) {
                  return context.parsed.y.toFixed(2) + ' $';
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: '#1e1e1e' },
              ticks: { color: '#666', maxRotation: 45 }
            },
            y: {
              grid: { color: '#1e1e1e' },
              ticks: {
                color: '#666',
                callback: function(value) { return value + ' $'; }
              }
            }
          }
        }
      });
    })
    .catch(err => {
      console.error('Erreur chargement graphique:', err);
      const placeholder = document.getElementById('chart-placeholder');
      placeholder.textContent = 'Erreur de chargement du graphique.';
    });
})();
</script>

 </div>

<footer><a href="http://192.168.3.102:8042">→ Tableau de bord des sites</a></footer>


<script>
// Delegation tracker charts — loads data via API, no nested template literals
(function() {
  fetch('/api/delegation-stats')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) return;
      var models = data.byModel || [];
      var levelColors = {0:'#4ade80','0.5':'#4ade80',1:'#4ade80',2:'#86efac',3:'#facc15',4:'#fbbf24',5:'#fb923c',6:'#f97316',7:'#60a5fa',8:'#818cf8',9:'#f87171'};

      // Model cost chart
      if (models.length > 0 && document.getElementById('modelCostChart')) {
        var ctx1 = document.getElementById('modelCostChart').getContext('2d');
        new Chart(ctx1, {
          type: 'bar',
          data: {
            labels: models.map(function(m){return m.name;}),
            datasets: [{
              label: 'Coût ($)',
              data: models.map(function(m){return parseFloat(m.cost.toFixed(4));}),
              backgroundColor: models.map(function(m){return levelColors[m.level] || '#888';}),
              borderRadius: 4
            }]
          },
          options: {
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx){return '$'+ctx.parsed.x.toFixed(4);} } } },
            scales: { x: { grid: { color: '#1e1e1e' }, ticks: { color: '#666', callback: function(v){return '$'+v;} } }, y: { grid: { display: false }, ticks: { color: '#aaa', font: { size: 11 } } } }
          }
        });
      }

      // Daily cost chart (stacked by model)
      var days = (data.byDate || []).slice(-7);
      if (days.length > 1 && document.getElementById('dailyCostChart')) {
        var allModelKeys = [];
        days.forEach(function(d){ Object.keys(d.byModel||{}).forEach(function(k){ if(allModelKeys.indexOf(k)===-1) allModelKeys.push(k); }); });
        var modelColors2 = allModelKeys.map(function(mid){
          var info = models.find(function(m){return m.model===mid;});
          return info ? (levelColors[info.level]||'#888') : '#888';
        });
        var modelLabels2 = allModelKeys.map(function(mid){
          var info = models.find(function(m){return m.model===mid;});
          return info ? info.name : mid;
        });
        var datasets2 = allModelKeys.map(function(mid, i){
          return {
            label: modelLabels2[i],
            data: days.map(function(d){return parseFloat(((d.byModel||{})[mid]||{}).cost||0).toFixed(4);}),
            backgroundColor: modelColors2[i]+'99',
            borderRadius: 3
          };
        });
        var ctx2 = document.getElementById('dailyCostChart').getContext('2d');
        new Chart(ctx2, {
          type: 'bar',
          data: { labels: days.map(function(d){return d.date.slice(5);}), datasets: datasets2 },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { position: 'bottom', labels: { color: '#666', boxWidth: 12, font: { size: 10 } } },
              tooltip: { callbacks: { label: function(ctx){return ctx.dataset.label+': $'+parseFloat(ctx.parsed.y).toFixed(4);} } }
            },
            scales: {
              x: { stacked: true, grid: { color: '#1e1e1e' }, ticks: { color: '#666' } },
              y: { stacked: true, grid: { color: '#1e1e1e' }, ticks: { color: '#666', callback: function(v){return '$'+v;} } }
            }
          }
        });
      }
    })
    .catch(function(err){ console.error('Delegation stats error:', err); });
})();
</script>
<script>
// PC Health cards + alertes
(function() {
  var ALERT_CPU = 80, ALERT_RAM = 80;

  function getAlertConfig() {
    try { return JSON.parse(localStorage.getItem('dash_alerts') || '{}'); } catch(e) { return {}; }
  }
  function setAlertConfig(name, val) {
    var cfg = getAlertConfig();
    cfg[name] = val;
    localStorage.setItem('dash_alerts', JSON.stringify(cfg));
  }

  // Restore toggle states from localStorage
  function initToggles() {
    var cfg = getAlertConfig();
    ['gabriel','louis','marie'].forEach(function(name) {
      var el = document.getElementById('alert-' + name);
      if (!el) return;
      // default to true if not set yet
      if (cfg[name] === undefined) cfg[name] = true;
      el.checked = cfg[name];
      el.addEventListener('change', function() {
        setAlertConfig(name, el.checked);
        updateAlertBanner();
      });
    });
    localStorage.setItem('dash_alerts', JSON.stringify(cfg));

    // Plug toggle click handlers
    ['louis','marie'].forEach(function(name) {
      var plugEl = document.getElementById('pc-' + name + '-plug-toggle');
      if (!plugEl) return;
      plugEl.addEventListener('click', function(e) {
        e.preventDefault();
        togglePlug(name);
      });
    });
  }

  function updateAlertBanner() {
    var banner = document.getElementById('alert-banner');
    var cfg = getAlertConfig();
    var active = [];

    ['gabriel','louis','marie'].forEach(function(name) {
      if (!cfg[name]) return;
      var data = window['_pc_' + name];
      if (!data || data.error) return;
      var cpu = parseFloat(data.cpu) || 0;
      var mem = parseFloat(data.mem_pct) || 0;
      var alerts = [];
      if (cpu > ALERT_CPU) alerts.push('CPU ' + cpu.toFixed(0) + '%');
      if (mem > ALERT_RAM) alerts.push('RAM ' + mem.toFixed(0) + '%');
      if (alerts.length > 0) active.push({ name: name, alerts: alerts, cpu: cpu, mem: mem });
    });

    if (active.length === 0) {
      banner.classList.remove('show');
      banner.innerHTML = '';
      return;
    }

    banner.classList.add('show');
    banner.innerHTML = active.map(function(pc) {
      var icon = pc.name === 'gabriel' ? '🖥️' : pc.name === 'louis' ? '💻' : '🖥️';
      var label = pc.name === 'gabriel' ? 'Gabriel' : pc.name === 'louis' ? 'Louis' : 'Marie';
      return '<div class="alert-banner-item"><span class="alert-banner-dot"></span>' + icon + ' <strong>' + label + '</strong> — ' + pc.alerts.join(' · ') + '</div>';
    }).join('');
  }

  function renderPc(data, name) {
    var body = document.getElementById('pc-' + name + '-body');
    var timeEl = document.getElementById('pc-' + name + '-time');
    if (!body) return;

    // Keep data for alert banner
    window['_pc_' + name] = data;

    // Toujours montrer les actions (switch prise compris) — même si SSH échoue
    var actionsEl = document.getElementById('pc-' + name + '-actions');
    if (actionsEl) {
      actionsEl.style.display = (name === 'marie' || name === 'louis' || name === 'gabriel') ? 'flex' : 'none';
    }

    if (!data || data.error) {
      body.innerHTML = '<div class="error-note" style="padding:0.5rem 0;text-align:center">⚠️ ' + (data ? data.error : 'Données indisponibles') + '</div>';
      return;
    }

    var ts = data.timestamp || '—';
    if (timeEl) timeEl.textContent = ts;

    var cpu = parseFloat(data.cpu) || 0;
    var memPct = parseFloat(data.mem_pct) || 0;
    var memUsed = data.mem_used ? (data.mem_used / 1024).toFixed(1) : '—';
    var memTotal = data.mem_total ? (data.mem_total / 1024).toFixed(1) : '—';
    var memAvail = data.mem_avail ? (data.mem_avail / 1024).toFixed(1) : '—';
    var vramPct = parseFloat(data.vram_pct) || 0;
    var vramDetail = data.vram_used ? (data.vram_used / 1024).toFixed(1) + 'G / ' + (data.vram_total / 1024).toFixed(1) + 'G' : '—';
    var vramTemp = data.vram_temp ? data.vram_temp + '°C' : '—';
    // Détection dynamique du LLM — basée sur les process réels, pas systemctl
    var hasLlamaProc = (data.top_procs || []).some(function(p) {
      return p.name && p.name.indexOf('llama-server') >= 0;
    });
    var llmRunning = (parseFloat(data.llm_rss) || 0) > 0 || hasLlamaProc;
    var llmModel = '—';
    if (data.llm_cmd && data.llm_cmd !== '—') {
      var m = data.llm_cmd.match(/-m\s+(\S+)/);
      if (m) { llmModel = m[1].split('/').pop() || m[1]; }
    }
    // Fallback au champ fourni si le parsing a échoué
    if (llmModel === '—' && data.llm_model) { llmModel = data.llm_model; }
    var llmStatus = llmRunning;
    var llmRss = data.llm_rss_gb ? data.llm_rss_gb + ' GB' : '—';
    var llmUptime = data.llm_uptime || '—';

    function c(val, t60, t80) {
      return val < t60 ? '#4ade80' : val < t80 ? '#facc15' : '#f87171';
    }

    function alertBadge(val, threshold) {
      if (val <= threshold) return '';
      var cls = val < 90 ? 'warn' : '';
      return '<span class="alert-badge ' + cls + '">⚠ ' + val.toFixed(0) + '%</span>';
    }

    // Check if alerts are enabled for this PC
    var cfg = getAlertConfig();
    var alertsOn = cfg[name] !== false;

    var cpuBadge = (alertsOn && cpu > ALERT_CPU) ? alertBadge(cpu, ALERT_CPU) : '';
    var ramBadge = (alertsOn && memPct > ALERT_RAM) ? alertBadge(memPct, ALERT_RAM) : '';

    body.innerHTML =
      '<div class="pc-row"><span class="lbl">CPU' + (cpuBadge ? '' : '') + '</span><span class="val" style="color:' + c(cpu,50,80) + '">' + cpu.toFixed(1) + '%' + cpuBadge + '</span></div>' +
      '<div class="pc-mini-bar"><div class="pc-mini-fill" style="width:' + Math.min(100,cpu) + '%;background:' + c(cpu,50,80) + '"></div></div>' +
      '<div class="pc-row"><span class="lbl">RAM' + (ramBadge ? '' : '') + '</span><span class="val" style="color:' + c(memPct,60,80) + '">' + memPct.toFixed(1) + '%' + ramBadge + '</span></div>' +
      '<div class="pc-mini-bar"><div class="pc-mini-fill" style="width:' + Math.min(100,memPct) + '%;background:' + c(memPct,60,80) + '"></div></div>' +
      '<div style="font-size:0.7rem;color:#666;margin-top:0.15rem;display:flex;justify-content:space-between"><span>' + memUsed + ' / ' + memTotal + '</span><span>libre ' + memAvail + '</span></div>' +
      '<div class="pc-row" style="margin-top:0.6rem"><span class="lbl">VRAM</span><span class="val" style="color:' + c(vramPct,70,90) + '">' + vramPct.toFixed(1) + '%</span></div>' +
      '<div class="pc-mini-bar"><div class="pc-mini-fill" style="width:' + Math.min(100,vramPct) + '%;background:' + c(vramPct,70,90) + '"></div></div>' +
      '<div style="font-size:0.7rem;color:#666;margin-top:0.15rem;display:flex;justify-content:space-between"><span>' + vramDetail + '</span><span>' + vramTemp + '</span></div>' +
      '<hr class="divider">' +
      '<div class="pc-llm">🧠 <strong>' + llmModel + '</strong> <span class="pc-status ' + (llmStatus ? 'on' : 'off') + '">' + (llmStatus ? '● Running' : '● Stopped') + '</span></div>' +
      (llmStatus ? '<div class="pc-llm" style="margin-top:0.15rem;font-size:0.68rem">RSS: ' + llmRss + ' · ↑ ' + llmUptime + '</div>' : '') +
      '<div class="pc-action-result" id="pc-' + name + '-result"></div>';

    // Update auto-kill checkbox
      var autoCheck = document.getElementById('auto-kill-' + name);
      if (autoCheck) {
        var wasChecked = autoCheck.checked;
        autoCheck.checked = data.auto_kill_enabled || false;
        if (wasChecked !== autoCheck.checked) {
          // Save state without triggering
          var cfg2 = getAutoKillConfig();
          cfg2[name] = autoCheck.checked;
          localStorage.setItem('dash_auto_kill', JSON.stringify(cfg2));
        }
        autoCheck.onchange = function() {
          pcAction(name, 'set_auto_kill', this.checked);
        };
      }

    // Show last action result
    var resultEl = document.getElementById('pc-' + name + '-result');
    if (resultEl) {
      resultEl.textContent = data.last_action || '';
      if (data.last_action) {
        setTimeout(function() {
          if (resultEl) resultEl.textContent = '';
        }, 5000);
      }
    }

    updateAlertBanner();
  }

  function refreshAll() {
    fetch('/api/pc-gabriel').then(function(r){return r.json();}).then(function(d){renderPc(d,'gabriel');}).catch(function(e){console.error('pc-gabriel:',e);});
    fetch('/api/pc-louis').then(function(r){return r.json();}).then(function(d){renderPc(d,'louis');}).catch(function(e){console.error('pc-louis:',e);});
    fetch('/api/pc-marie').then(function(r){return r.json();}).then(function(d){renderPc(d,'marie');}).catch(function(e){console.error('pc-marie:',e);});
    fetchPlugState('louis');
    fetchPlugState('marie');
  }

  // Auto-kill config helpers
  function getAutoKillConfig() {
    try { return JSON.parse(localStorage.getItem('dash_auto_kill') || '{}'); } catch(e) { return {}; }
  }
  function setAutoKillConfig(name, val) {
    var cfg = getAutoKillConfig();
    cfg[name] = val;
    localStorage.setItem('dash_auto_kill', JSON.stringify(cfg));
  }

  // PC Action handler (exposed globally for onclick)
  window.pcAction = function(pc, action, value) {
    fetch('/api/pc-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pc: pc, action: action, enabled: value })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      console.log('pcAction(' + pc + ', ' + action + '):', res);
      if (!res.ok) {
        // Show error
        var resultEl = document.getElementById('pc-' + pc + '-result');
        if (resultEl) resultEl.textContent = '❌ ' + (res.error || 'Erreur');
      }
    })
    .catch(function(err) {
      console.error('pcAction error:', err);
      var resultEl = document.getElementById('pc-' + pc + '-result');
      if (resultEl) resultEl.textContent = '❌ Erreur réseau';
    });
  }

  // Plug state management
  window.togglePlug = function(name) {
    fetch('/api/pc-toggle-plug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.ok) {
        updatePlugToggle(name, res.state);
      } else {
        var resultEl = document.getElementById('pc-' + name + '-result');
        if (resultEl) resultEl.textContent = '❌ ' + (res.error || 'Erreur prise');
      }
    })
    .catch(function(err) {
      console.error('togglePlug error:', err);
      var resultEl = document.getElementById('pc-' + name + '-result');
      if (resultEl) resultEl.textContent = '❌ Erreur réseau';
    });
  };

  function updatePlugToggle(name, state) {
    var toggle = document.getElementById('pc-' + name + '-plug-toggle');
    if (!toggle) return;
    var statusEl = document.getElementById('pc-' + name + '-plug-status');
    var isOn = state === 'on';
    toggle.className = 'pc-plug-toggle' + (isOn ? ' on' : ' off');
    if (statusEl) statusEl.textContent = isOn ? 'ON' : 'OFF';
  }

  function fetchPlugState(name) {
    fetch('/api/pc-plug-state/' + name)
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.ok) updatePlugToggle(name, res.state);
    })
    .catch(function(err) {
      console.error('fetchPlugState(' + name + '):', err);
    });
  }

  initToggles();
  refreshAll();
  setInterval(refreshAll, 10000);
})();
</script>

<!-- Card visibility toggle JS -->
<script>
(function() {
  var panel = document.getElementById('settings-panel');
  var btn = document.getElementById('settingsBtn');
  var visibleCache = null;

  // Toggle panel
  window.toggleSettings = function() {
    var show = panel.classList.toggle('show');
    btn.classList.toggle('active', show);
  };

  // Close panel on click outside
  document.addEventListener('click', function(e) {
    if (panel && panel.classList.contains('show') &&
        !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      panel.classList.remove('show');
      btn.classList.remove('active');
    }
  });

  // Toggle a card on/off instantly
  function toggleCard(cardId, visible) {
    // Find all elements with this data-card-id
    var els = document.querySelectorAll('[data-card-id="' + cardId + '"]');
    els.forEach(function(el) {
      // Ne pas cacher les lignes du panneau settings — sinon impossible de réafficher
      if (el.closest('#settings-panel')) return;
      if (visible) {
        el.classList.remove('card-hidden');
      } else {
        el.classList.add('card-hidden');
      }
    });
  }

  // Save preference to server
  function saveVisibility(cardId, visible) {
    fetch('/api/card-visibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId: cardId, visible: visible })
    }).catch(function(err) {
      console.error('Erreur sauvegarde visibilité:', err);
    });
  }

  // Init settings panel toggles
  function initSettings() {
    // Fetch current state from server to stay in sync
    fetch('/api/card-visibility')
      .then(function(r) { return r.json(); })
      .then(function(cfg) {
        visibleCache = cfg;
        var rows = panel.querySelectorAll('.settings-row');
        rows.forEach(function(row) {
          var cardId = row.getAttribute('data-card-id');
          var cb = row.querySelector('input[type="checkbox"]');
          if (!cb || !cardId) return;
          // Update checkbox state from server
          var isVisible = cfg[cardId] !== false;
          cb.checked = isVisible;
          // Apply to card
          toggleCard(cardId, isVisible);
          // Listen for changes
          cb.addEventListener('change', function() {
            var visible = cb.checked;
            var cardId2 = row.getAttribute('data-card-id');
            toggleCard(cardId2, visible);
            saveVisibility(cardId2, visible);
          });
        });
      })
      .catch(function(err) {
        console.error('Erreur chargement visibilité:', err);
        // Fallback: use server-rendered state (checkboxes already have correct state)
        var rows = panel.querySelectorAll('.settings-row');
        rows.forEach(function(row) {
          var cardId = row.getAttribute('data-card-id');
          var cb = row.querySelector('input[type="checkbox"]');
          if (!cb || !cardId) return;
          cb.addEventListener('change', function() {
            toggleCard(cardId, cb.checked);
            saveVisibility(cardId, cb.checked);
          });
        });
      });
  }

  if (panel) initSettings();
})();
</script>
</body>
</html>`);
});


// ─── PC Action (POST) — direct SSH to target machine
app.post('/api/pc-action', async (req, res) => {
  try {
    const { pc, action, enabled } = req.body;
    
    if (action === 'set_auto_kill') {
      // Just toggle a local flag file on the target
      let sshHost, sshUser;
      if (pc === 'marie') { sshHost = '192.168.3.58'; sshUser = 'gab'; }
      else if (pc === 'louis') { sshHost = '192.168.3.224'; sshUser = 'gab'; }
      else if (pc === 'gabriel') { sshHost = '192.168.3.220'; sshUser = 'gabpop'; }
      else return res.status(400).json({ ok: false, error: 'PC inconnu' });

      let cmd;
      if (enabled) {
        cmd = `ssh -o StrictHostKeyChecking=no ${sshUser}@${sshHost} 'mkdir -p /tmp/${pc}-dashboard && touch /tmp/${pc}-dashboard/auto_kill_enabled'`;
      } else {
        cmd = `ssh -o StrictHostKeyChecking=no ${sshUser}@${sshHost} 'rm -f /tmp/${pc}-dashboard/auto_kill_enabled'`;
      }
      execSync(cmd, { timeout: 10000 });
      return res.json({ ok: true, enabled: enabled });
    }
    
    if (action === 'kill_llm') {
      let cmd;
      if (pc === 'marie') {
        // Write action file for metrics script to pick up
        cmd = "ssh -o StrictHostKeyChecking=no gab@192.168.3.58 'mkdir -p /tmp/marie-dashboard && echo kill_llm > /tmp/marie-dashboard/queued_action'";
      } else if (pc === 'louis') {
        cmd = "ssh -o StrictHostKeyChecking=no gab@192.168.3.224 'pkill -f llama-server && echo OK'";
      } else {
        cmd = "ssh -o StrictHostKeyChecking=no gabpop@192.168.3.220 'pkill -f llama-server && echo OK'";
      }
      const result = execSync(cmd, { timeout: 10000 }).toString().trim();
      return res.json({ ok: true, result: result });
    }
    
    if (action === 'start_llm') {
      let cmd;
      if (pc === 'marie') {
        // Write action file for metrics script to pick up
        cmd = "ssh -o StrictHostKeyChecking=no gab@192.168.3.58 'mkdir -p /tmp/marie-dashboard && echo start_llm > /tmp/marie-dashboard/queued_action'";
      } else if (pc === 'louis') {
        cmd = "ssh -o StrictHostKeyChecking=no gab@192.168.3.224 '~/run_qwen35-moe.sh >/dev/null 2>&1 & echo OK'";
      } else {
        cmd = "ssh -o StrictHostKeyChecking=no gabpop@192.168.3.220 '~/start-default-llm.sh >/dev/null 2>&1 & echo OK'";
      }
      const result = execSync(cmd, { timeout: 10000 }).toString().trim();
      return res.json({ ok: true, result: result });
    }

    if (action === 'shutdown') {
      let cmd;
      if (pc === 'louis') {
        cmd = "ssh -o StrictHostKeyChecking=no gab@192.168.3.224 'sudo shutdown -h now && echo OK'";
      } else if (pc === 'marie') {
        cmd = "ssh -o StrictHostKeyChecking=no gab@192.168.3.58 'sudo shutdown -h now && echo OK'";
      } else if (pc === 'gabriel') {
        cmd = "ssh -o StrictHostKeyChecking=no gabpop@192.168.3.220 'sudo shutdown -h now && echo OK'";
      } else return res.status(400).json({ ok: false, error: 'PC inconnu' });
      const result = execSync(cmd, { timeout: 30000 }).toString().trim();
      return res.json({ ok: true, result: result });
    }

    return res.status(400).json({ ok: false, error: 'Action inconnue: ' + action });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Start────────
startCreditsCollector();
startPcCache();
app.listen(PORT, () => console.log(`openclaw-dash sur le port ${PORT}`));
