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

// --- Watchdog extinction PC (cron */15) -----------------------------------
// Etat du watchdog d'extinction (pc-idle-watchdog.py, cron harry) — lisible dans le conteneur
// via le mount `/ -> /host`. Surchargeable par env (WATCHDOG_STATE_PATH) pour tester sur l'hote.
const WATCHDOG_STATE = process.env.WATCHDOG_STATE_PATH || '/host/home/lydstyl/.hermes/cron/output/pc-idle-watchdog/state.json';
const WATCHDOG_MAP = { louis: 'louis', marie: 'marie', boncoin: 'skillorp' };
const WATCHDOG_IDLE_MIN = 30;
const WATCHDOG_TICK_MIN = 15;
const WATCHDOG_MAX_AGE_MS = 2 * WATCHDOG_TICK_MIN * 60000; // etat plus vieux = cron mort : on se tait

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

// ─── Top Processes ───────────────────────────────────────────────
function getTopProcesses() {
  try {
    // Use host's ps via /host chroot (Alpine busybox ps doesn't support --sort)
    const output = execSync('chroot /host ps aux --sort=-%cpu | head -4', { encoding: 'utf8', timeout: 5000 });
    const lines = output.trim().split('\n');
    const result = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts.length >= 11) {
        const cpu = parseFloat(parts[2]);
        const mem = parseFloat(parts[3]);
        const cmd = parts.slice(10).join(' ');
        result.push({ cpu, mem, cmd: cmd.substring(0, 80) });
      }
    }
    return result;
  } catch (e) {
    return [{ cpu: 0, mem: 0, cmd: 'Erreur: ' + e.message }];
  }
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
  'credits': true, 'depenses': true,
  'systeme': true, 'ollama': true,
  'pc-gabriel': true, 'pc-louis': true, 'pc-marie': true, 'pc-boncoin': true, 'chart': true,
  'energie': true
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

// --- Card Order (glisser-deposer) -----------------------------------------
const ORDER_FILE = path.join(DATA_DIR, 'card_order.json');

// Ordre par defaut = ordre de rendu du template (cartes + graphique)
const DEFAULT_ORDER = [
  'energie', 'credits', 'depenses',
  'systeme', 'ollama', 'pc-gabriel', 'pc-louis', 'pc-marie', 'pc-boncoin', 'chart'
];

function loadCardOrder() {
  try {
    if (fs.existsSync(ORDER_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.order) ? raw.order : []);
      const clean = [];
      list.forEach(function(id) {
        if (typeof id === 'string' && DEFAULT_ORDER.indexOf(id) !== -1 && clean.indexOf(id) === -1) clean.push(id);
      });
      // une carte absente du fichier (ajoutee apres coup) retombe en fin, dans l ordre du template
      DEFAULT_ORDER.forEach(function(id) { if (clean.indexOf(id) === -1) clean.push(id); });
      return clean;
    }
  } catch (e) { console.error('[card-order] erreur lecture:', e.message); }
  return DEFAULT_ORDER.slice();
}

function saveCardOrder(order) {
  ensureDataDir();
  const clean = [];
  if (Array.isArray(order)) {
    order.forEach(function(id) {
      if (typeof id === 'string' && DEFAULT_ORDER.indexOf(id) !== -1 && clean.indexOf(id) === -1) clean.push(id);
    });
  }
  // tableau vide ou invalide = retour a l ordre par defaut
  DEFAULT_ORDER.forEach(function(id) { if (clean.indexOf(id) === -1) clean.push(id); });
  fs.writeFileSync(ORDER_FILE, JSON.stringify(clean, null, 2));
  return clean;
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
const pcCache = { gabriel: null, louis: null, marie: null, boncoin: null, gabrielOk: false, louisOk: false, marieOk: false, boncoinOk: false };
// Horodatage du dernier relevé RÉUSSI par PC. Le cache garde le dernier relevé quand le
// backend (FastAPI 3019/3024) est mort → sans ce flag le front affiche des données
// vieilles de plusieurs heures comme si elles étaient live (bug « LLM déjà lancé » 26/09).
const pcCacheTs = { gabriel: 0, louis: 0, marie: 0, boncoin: 0 };
// Au-delà de 3 cycles de collecte (15 s) sans succès, les données sont franchement figées.
const PC_STALE_AFTER_S = 45;

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
              pcCacheTs[name] = Date.now();
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
      fetchPcHealth('boncoin', '192.168.3.102', 3036),
    ]);
  };
  update(); // first fetch immediately
  setInterval(update, 15000); // then every 15s
}

// --- Compte a rebours d extinction : etat du watchdog PC idle ------------
let _wdState = null;
let _wdStateTs = 0;

function loadWatchdogState() {
  const now = Date.now();
  if (_wdStateTs && (now - _wdStateTs) < 60000) return _wdState; // cache 60 s
  _wdStateTs = now;
  try {
    const mtime = fs.statSync(WATCHDOG_STATE).mtimeMs;
    // Cron mort ou desactive : l etat n est plus une prevision, on ne montre rien.
    if (now - mtime > WATCHDOG_MAX_AGE_MS) { _wdState = null; return _wdState; }
    _wdState = JSON.parse(fs.readFileSync(WATCHDOG_STATE, 'utf8'));
  } catch (e) {
    _wdState = null; // fichier absent (hors conteneur) : pas de compte a rebours
  }
  return _wdState;
}

// ⚠️ Le watchdog ecrit des heures LOCALES (Europe/Paris) SANS fuseau ("2026-10-27T11:45:40").
// Le conteneur tourne en UTC : new Date() y interprete 11:45 comme 11:45 UTC = 12:45 Paris,
// soit 1 h d avance -> idleMin negatif et compte a rebours faux. On reconstruit donc
// l instant en interpretant la chaine comme heure de Paris.
function parisOffsetMs(epochMs) {
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Paris', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(epochMs)).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    return asUTC - epochMs;
  } catch (e) {
    return 0; // Intl indisponible : on degrade vers un decalage nul plutot que vers une ETA fausse
  }
}

function parseParisNaive(str) {
  if (!str || typeof str !== 'string') return null;
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(str)) { // deja horodate avec fuseau : lecture directe
    const t = Date.parse(str);
    return isNaN(t) ? null : t;
  }
  const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(str);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return guess - parisOffsetMs(guess);
}

// "2026-10-27T13:23:00" -> "13:23" (les chiffres de la chaine, independamment du fuseau)
function hhmmNaive(str) {
  const m = /[T ](\d{2}):(\d{2})/.exec(str || '');
  return m ? m[1] + ':' + m[2] : '—';
}

// null si PC non gere par le watchdog, actif ou eteint. Sinon :
//   { blocked, cronAt, shutdownAtMs, idleMin }
function getAutoShutdown(name) {
  const key = WATCHDOG_MAP[name];
  if (!key) return null;
  const st = loadWatchdogState();
  if (!st || !st[key]) return null;
  const pc = st[key];
  if (!pc.idle_since || pc.off_since) return null;
  const startMs = parseParisNaive(pc.idle_since);
  if (startMs === null) return null;
  if (startMs > Date.now()) return null; // horloge incoherente : aucune prevision fiable
  const idleMin = Math.floor((Date.now() - startMs) / 60000);

  if (pc.blocked_by_cron) {
    return { blocked: true, cronAt: hhmmNaive(pc.blocked_by_cron), shutdownAtMs: null, idleMin: idleMin };
  }

  // ETA = idle_since + IDLE_MIN, arrondi au prochain tick de 15 min du cron.
  const eta = new Date(startMs + WATCHDOG_IDLE_MIN * 60000);
  const m = eta.getMinutes();
  let add = (WATCHDOG_TICK_MIN - (m % WATCHDOG_TICK_MIN)) % WATCHDOG_TICK_MIN;
  if (add === 0 && eta.getSeconds() !== 0) add = WATCHDOG_TICK_MIN;
  if (add > 0) eta.setMinutes(m + add, 0, 0); else eta.setSeconds(0, 0);
  return { blocked: false, cronAt: null, shutdownAtMs: eta.getTime(), idleMin: idleMin };
}

// ─── Réponse /api/pc-* : marque les données figées ───────────────────
// Le cache survit à la mort du backend. On expose _stale / _age_s pour que le front
// n'affiche jamais un vieux relevé comme s'il était live.
function pcPayload(name) {
  const d = pcCache[name];
  if (!d) return { error: 'Waiting for data…' };
  const ts = pcCacheTs[name] || 0;
  const ageS = ts ? Math.round((Date.now() - ts) / 1000) : null;
  const fresh = pcCache[name + 'Ok'] === true;
  return Object.assign({}, d, {
    auto_shutdown: getAutoShutdown(name),
    _stale: !fresh || (ageS !== null && ageS > PC_STALE_AFTER_S),
    _age_s: ageS,
    _fetched_at: ts ? new Date(ts).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' }) : null,
  });
}

// API: PC Gabriel
app.get('/api/pc-gabriel', (req, res) => {
  res.json(pcPayload('gabriel'));
});

// API: PC Louis
app.get('/api/pc-louis', (req, res) => {
  res.json(pcPayload('louis'));
});

// API: PC Marie
app.get('/api/pc-marie', (req, res) => {
  res.json(pcPayload('marie'));
});

// API: PC SkillORP (ex-carte « PC BonCoin » — backend skillorp-dashboard :3036)
app.get('/api/pc-boncoin', (req, res) => {
  res.json(pcPayload('boncoin'));
});

// ─── LLM du PC Gabriel (192.168.3.224) : état réel par HTTP ────────────────
// Le .224 n'est pas comme Louis/Marie : le moteur qui y tourne change (Strata =
// serve/server.py + engine/strata, ou llama.cpp). `pgrep llama-server` ne voit QUE
// llama.cpp et ment donc sur Strata. Seule sonde fiable pour les deux : HTTP.
// curl n'existe pas dans l'image → module http de Node.
const LLM224_HOST = '192.168.3.224';
const LLM224_PORT = 8080;
const LLM224 = { cache: null, cacheTs: 0, busy: false, startingUntil: 0, lastModel: null };

function httpGetJson(host, port, urlPath, timeoutMs, cb) {
  let done = false;
  let req = null;
  const finish = (err, data) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (req) req.destroy();
    cb(err, data);
  };
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    if (req) req.destroy();
    cb(new Error('timeout ' + timeoutMs + 'ms sur ' + urlPath));
  }, timeoutMs);
  try {
    req = require('http').get({ host: host, port: port, path: urlPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { finish(null, JSON.parse(body)); }
        catch (e) { finish(new Error('JSON invalide sur ' + urlPath + ' : ' + e.message)); }
      });
      res.on('error', (e) => finish(e));
    });
    req.on('error', (e) => finish(e));
  } catch (e) { finish(e); }
}

function llama224WindowOpen() { return Date.now() < LLM224.startingUntil; }
function startLlama224Window(ms) { LLM224.startingUntil = Date.now() + (ms || 180000); LLM224.cache = null; LLM224.cacheTs = 0; }
function clearLlama224Window() { LLM224.startingUntil = 0; LLM224.cache = null; LLM224.cacheTs = 0; }

// Sonde : /health (3 s) puis /v1/models (3 s) pour le nom RÉELLEMENT servi.
// running = /health répond ok · starting = sourd pendant la fenêtre de démarrage · stopped = le reste.
// force = true → ignore le cache (utilisé après un arrêt/démarrage, là où le cache mentirait).
function probeLlama224(cb, force) {
  const now = Date.now();
  const shape = (entry) => {
    const out = Object.assign({}, entry);
    out.age_s = Math.round((Date.now() - entry.ts) / 100) / 10;
    delete out.ts;
    return out;
  };
  if (!force && LLM224.cache && (now - LLM224.cacheTs) < 2000) return cb(null, shape(LLM224.cache));
  if (LLM224.busy) {
    return cb(null, LLM224.cache ? shape(LLM224.cache)
      : { state: llama224WindowOpen() ? 'starting' : 'stopped', model: null, ctx: null, images: null, health: false, age_s: 0, error: 'sonde déjà en cours' });
  }
  LLM224.busy = true;
  const done = (info, errMsg) => {
    LLM224.busy = false;
    if (!info) {
      info = {
        state: llama224WindowOpen() ? 'starting' : 'stopped',
        model: null, ctx: null, images: null, health: false, error: errMsg || null
      };
    }
    if (info.state === 'running') {
      LLM224.startingUntil = 0;               // il répond : plus de démarrage en cours
      if (info.model) LLM224.lastModel = info.model;
    }
    info.ts = Date.now();
    LLM224.cache = info;
    LLM224.cacheTs = info.ts;
    cb(null, shape(info));
  };
  httpGetJson(LLM224_HOST, LLM224_PORT, '/health', 3000, (hErr, health) => {
    if (hErr || !health || health.status !== 'ok') {
      return done(null, hErr ? hErr.message : 'health non ok');
    }
    httpGetJson(LLM224_HOST, LLM224_PORT, '/v1/models', 3000, (mErr, models) => {
      let model = health.model || LLM224.lastModel || null;
      let ctx = health.max_context || null;
      if (!mErr && models && models.data && models.data.length > 0) {
        const m0 = models.data[0];
        if (m0.id) model = m0.id;
        if (m0.meta && m0.meta.n_ctx) ctx = m0.meta.n_ctx;
      }
      // Occupation : /slots (`is_processing`) existe pour llama.cpp ET pour Strata — c'est la
      // même sémantique que le badge des cartes Louis/Marie. /status (Strata seul) enrichit
      // avec le débit ; llama.cpp répond 404 → on l'ignore, jamais bloquant.
      httpGetJson(LLM224_HOST, LLM224_PORT, '/slots', 2500, (sErr, slots) => {
        let busy = null;
        if (!sErr && Array.isArray(slots) && slots.length > 0 && slots[0] && typeof slots[0].is_processing !== 'undefined') {
          busy = slots[0].is_processing === true;
        }
        httpGetJson(LLM224_HOST, LLM224_PORT, '/status', 2500, (stErr, st) => {
          let activity = null;
          if (busy === true && !stErr && st && typeof st === 'object') {
            activity = {
              phase: st.phase || null,
              queued: (typeof st.queued === 'number') ? st.queued : null,
              generated: (typeof st.generated === 'number') ? st.generated : null,
              elapsed_s: (typeof st.elapsed_s === 'number') ? st.elapsed_s : null,
              tokens_per_s: (typeof st.tokens_per_s === 'number') ? st.tokens_per_s : null,
              max_tokens: (typeof st.max_tokens === 'number') ? st.max_tokens : null,
            };
          }
          done({
            state: 'running', model: model, ctx: ctx,
            images: health.images === true, health: true,
            busy: busy, activity: activity,
            error: mErr ? mErr.message : null
          });
        });
      });
    });
  });
}

function probeLlama224Async(force) {
  return new Promise((resolve) => probeLlama224((err, info) => resolve(info), force));
}

// API: état du LLM du .224 (Strata ou llama.cpp) — c'est ce que lit la carte PC Gabriel
app.get('/api/llm-224', (req, res) => {
  probeLlama224((err, info) => {
    if (!info) {
      return res.json({ state: 'stopped', model: null, ctx: null, images: null, health: false, age_s: null, error: err ? err.message : 'sonde indisponible' });
    }
    res.json(Object.assign({ host: LLM224_HOST, port: LLM224_PORT, starting: llama224WindowOpen() }, info));
  });
});

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

// API: débit des LLM locaux (t/s à ~100k de contexte) — c'est ce que lit la barre
// "vitesse" des cartes PC. Source = data/llm-speed.json, écrit par la mesure
// scripts/bench-llm-speed.py (relancer ce script pour rafraîchir les chiffres).
const LLM_SPEED_FILE = '/app/data/llm-speed.json';
app.get('/api/llm-speed', (req, res) => {
  try {
    const parsed = JSON.parse(require('fs').readFileSync(LLM_SPEED_FILE, 'utf8'));
    res.json(parsed);
  } catch (e) {
    res.json({ ok: false, by_node: {}, max_gen_tps: null, error: 'aucune mesure: ' + e.message });
  }
});

// Lance une commande shell DÉTACHÉE : la requête HTTP rend la main tout de suite
// (un démarrage Strata dure 66-120 s, impossible à attendre dans une réponse HTTP).
function spawnDetached(cmd) {
  const child = require('child_process').spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

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

// API: ordre des cartes (glisser-deposer)
app.get('/api/card-order', (req, res) => {
  res.json({ ok: true, order: loadCardOrder() });
});

app.post('/api/card-order', (req, res) => {
  try {
    const body = req.body || {};
    const order = saveCardOrder(body.order);
    res.json({ ok: true, order: order });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// API: top processes
app.get('/api/top-processes', (req, res) => {
  res.json(getTopProcesses());
});

// ─── Home Assistant Smart Plug Control ───────────────────────────
const HA_BASE = 'http://192.168.3.167:8123';
const HA_HEADERS = { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' };

function getPlugEntity(name) {
  if (name === 'gabriel') return 'switch.prise_1_sous_tableau_commutateur';
  if (name === 'louis') return 'switch.bouilloire_commutateur';
  if (name === 'marie') return 'switch.prise3';
  if (name === 'boncoin') return 'switch.cuisine_prisepcboncoin';
  return null;
}

function getPlugPowerEntity(name) {
  if (name === 'gabriel') return 'sensor.prise_1_sous_tableau_puissance';
  if (name === 'louis') return 'sensor.bouilloire_puissance';
  if (name === 'marie') return 'sensor.prise3_puissance';
  if (name === 'boncoin') return 'sensor.cuisine_prisepcboncoin_puissance';
  return null;
}

// API: get plug state + power
app.get('/api/pc-plug-state/:name', async (req, res) => {
  const entityId = getPlugEntity(req.params.name);
  const powerEntityId = getPlugPowerEntity(req.params.name);
  if (!entityId) return res.json({ ok: false, error: 'PC inconnu' });
  try {
    const [r, p] = await Promise.all([
      axios.get(`${HA_BASE}/api/states/${entityId}`, { headers: HA_HEADERS, timeout: 5000 }),
      powerEntityId
        ? axios.get(`${HA_BASE}/api/states/${powerEntityId}`, { headers: HA_HEADERS, timeout: 5000 }).catch(() => null)
        : Promise.resolve(null),
    ]);
    let power = null;
    if (p && p.data && p.data.state !== 'unknown' && p.data.state !== 'unavailable') {
      const parsed = parseFloat(p.data.state);
      power = isNaN(parsed) ? null : parsed;
    }
    // Coût au rythme actuel, au prix du kWh en vigueur (HP/HC courant)
    const priceInfo = currentEnergyPrice(loadEnergyPrices(), new Date());
    const eurH = power === null ? null : (power / 1000) * priceInfo.price;
    const eurMonth = eurH === null ? null : eurH * MONTH_HOURS;
    res.json({
      ok: true, state: r.data.state, entity_id: entityId, power,
      priceKwh: priceInfo.price, priceLabel: priceInfo.label,
      eurH: eurH, eurMonth: eurMonth
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// API: toggle PC smart plug

// ─── Prix de l'énergie (config persistée) ────────────────────
const ENERGY_FILE = path.join(DATA_DIR, 'energy_prices.json');

// Projection mensuelle : 30 jours pleins (les montants « mois » sont des extrapolations
// au rythme actuel, pas une consommation mensuelle mesurée)
const MONTH_HOURS = 30 * 24;

// Tarif Bleu EDF, grille applicable au 1er août 2026 (TTC, €/kWh)
const DEFAULT_ENERGY = {
  mode: 'hphc',          // 'base' | 'hphc'
  prix_base: 0.1985,     // option Base, >= 9 kVA
  prix_hp: 0.2142,       // Heures pleines
  prix_hc: 0.1589,       // Heures creuses
  // Fenêtres heures creuses mesurées sur le compteur Linky (registres TIC) :
  // bascule HP->HC à 01:30, HC->HP à 07:00, HP->HC à 12:00, HC->HP à 14:30 (8 h/jour).
  hc_windows: [[1.5, 7], [12, 14.5]],
  prix_injection: 0      // €/kWh revendu (0 = pas de revente)
};

function loadEnergyPrices() {
  try {
    if (fs.existsSync(ENERGY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ENERGY_FILE, 'utf8'));
      return { ...DEFAULT_ENERGY, ...raw };
    }
  } catch (e) { console.error('[energy-prices] lecture:', e.message); }
  return { ...DEFAULT_ENERGY };
}

function saveEnergyPrices(patch) {
  const cfg = { ...loadEnergyPrices(), ...patch };
  ensureDataDir();
  fs.writeFileSync(ENERGY_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

// Heure locale de Paris (le conteneur tourne en UTC)
function parisClock(date) {
  const hh = date.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false });
  const mm = date.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', minute: '2-digit' });
  const h = parseInt(hh, 10);
  const m = parseInt(mm, 10);
  if (isNaN(h) || isNaN(m)) {
    const d = new Date(date.getTime() + 2 * 3600 * 1000);  // secours : UTC+2
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
  return h * 60 + m;
}

function parisHour(date) { return Math.floor(parisClock(date) / 60); }

// Fenêtres HC en heures décimales (ex. 1.5 = 01:30). Rétro-compat hc_debut/hc_fin.
function hcWindows(cfg) {
  const c = cfg || loadEnergyPrices();
  if (Array.isArray(c.hc_windows) && c.hc_windows.length) {
    return c.hc_windows
      .filter(function (w) { return Array.isArray(w) && w.length === 2 && !isNaN(Number(w[0])) && !isNaN(Number(w[1])); })
      .map(function (w) { return [Number(w[0]), Number(w[1])]; });
  }
  if (c.hc_debut !== undefined && c.hc_fin !== undefined) return [[Number(c.hc_debut), Number(c.hc_fin)]];
  return [];
}

function fmtHour(h) {
  const total = Math.round(Number(h) * 60);
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
}

function hcWindowsLabel(cfg) {
  const list = hcWindows(cfg);
  if (!list.length) return '';
  return list.map(function (w) { return fmtHour(w[0]) + '–' + fmtHour(w[1]); }).join(' & ');
}

function isInHcWindow(min, w) {
  const a = ((Math.round(w[0] * 60) % 1440) + 1440) % 1440;
  const b = ((Math.round(w[1] * 60) % 1440) + 1440) % 1440;
  if (a === b) return false;
  return a < b ? (min >= a && min < b) : (min >= a || min < b);
}

// Prochaine bascule (début ou fin de fenêtre HC) après `min` minutes
function nextBoundary(min, list, inHc) {
  let best = null;
  list.forEach(function (w) {
    const cands = inHc ? [w[1]] : [w[0]];
    cands.forEach(function (b) {
      let bm = ((Math.round(Number(b) * 60) % 1440) + 1440) % 1440;
      let d = bm - min;
      if (d <= 0) d += 1440;
      if (best === null || d < best.minutes) best = { minutes: d, at: bm };
    });
  });
  return best;
}

function currentEnergyPrice(cfg, date) {
  const c = cfg || loadEnergyPrices();
  if (c.mode !== 'hphc') {
    return { price: Number(c.prix_base) || 0, label: 'Base', slot: 'prix_base', hc: false, nextAt: null, nextInMin: null };
  }
  const min = parisClock(date || new Date());
  const list = hcWindows(c);
  let inHc = false;
  list.forEach(function (w) { if (isInHcWindow(min, w)) inHc = true; });
  const nb = nextBoundary(min, list, inHc);
  return {
    price: Number(inHc ? c.prix_hc : c.prix_hp) || 0,
    label: inHc ? 'Heures creuses' : 'Heures pleines',
    slot: inHc ? 'prix_hc' : 'prix_hp',
    hc: inHc,
    nextAt: nb ? fmtHour(nb.at / 60) : null,
    nextInMin: nb ? nb.minutes : null
  };
}

// ─── Solaire : production + import réseau (HA) ────────────────
// ─── Solar Production & Grid Import ───────────────────────────
let _solaireCache = { ts: 0, data: null };

function parseSolarValue(state) {
  if (state === 'unknown' || state === 'unavailable' || state === '') return { val: 0, ok: false };
  const n = parseFloat(state);
  if (isNaN(n)) return { val: 0, ok: false };
  return { val: n, ok: true };
}

async function fetchSolarData() {
  const entities = [
    'sensor.prise_solaire_puissance',
    'sensor.prise_solaire_summation_delivered',
    'sensor.prise4_cabanon_solaire_puissance',
    'sensor.prise4_cabanon_solaire_consommation',
    'sensor.lixee_zlinky_tic_puissance_apparente',
    'sensor.lixee_zlinky_tic_consommation_partie_1',
    'sensor.lixee_zlinky_tic_consommation_partie_2'
  ];
  
  const responses = await Promise.all(
    entities.map(id => 
      axios.get(HA_BASE + '/api/states/' + id, { headers: HA_HEADERS, timeout: 5000 })
        .catch(() => null)
    )
  );

  const getVal = (idx) => {
    if (!responses[idx] || !responses[idx].data) return { val: 0, ok: false };
    return parseSolarValue(responses[idx].data.state);
  };

  const p1 = getVal(0);
  const c1 = getVal(1);
  const p2 = getVal(2);
  const c2 = getVal(3);
  const g1 = getVal(4);
  const g2 = getVal(5);
  const g3 = getVal(6);

  const prodPriseW = p1.val;
  const cumulPriseKWh = c1.val;
  const prodCabanonW = p2.val;
  const cumulCabanonKWh = c2.val;
  const gridW = g1.val;
  // Registres Linky : tranche 1 = index Heures creuses, tranche 2 = index Heures pleines
  // (mesuré : bascules 01:30/07:00/12:00/14:30 sur 8 jours de séries HA)
  const cumulGridHcKWh = g2.val;
  const cumulGridHpKWh = g3.val;
  const cumulGridKWh = cumulGridHcKWh + cumulGridHpKWh;
  const prodW = prodPriseW + prodCabanonW;

  // Estimation en euros sur 1 h au rythme actuel (TTC)
  const energyCfg = loadEnergyPrices();
  const now = new Date();
  const priceInfo = currentEnergyPrice(energyCfg, now);
  const prodEurH = (prodW / 1000) * priceInfo.price;
  const gridEurH = (gridW / 1000) * priceInfo.price;
  const prodEurMonth = prodEurH * MONTH_HOURS;
  const gridEurMonth = gridEurH * MONTH_HOURS;
  const cumulProdEur = (cumulPriseKWh + cumulCabanonKWh) * priceInfo.price;
  // Cumul réseau valorisé au vrai prix de chaque registre
  const cumulGridEur = (energyCfg.mode === 'hphc')
    ? (cumulGridHcKWh * (Number(energyCfg.prix_hc) || 0) + cumulGridHpKWh * (Number(energyCfg.prix_hp) || 0))
    : (cumulGridKWh * (Number(energyCfg.prix_base) || 0));

  const timeStr = now.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour12: false });

  return {
    ok: true,
    prodW: prodW,
    prodPriseW: prodPriseW,
    prodCabanonW: prodCabanonW,
    priseOk: p1.ok,
    cabanonOk: p2.ok,
    cumulPriseKWh: cumulPriseKWh,
    cumulCabanonKWh: cumulCabanonKWh,
    gridW: gridW,
    cumulGridKWh: cumulGridKWh,
    cumulGridOk: (g2.ok && g3.ok),
    autonomie: (gridW === 0 && prodW > 0),
    priceKwh: priceInfo.price,
    priceLabel: priceInfo.label,
    priceSlot: priceInfo.slot,
    priceMode: energyCfg.mode,
    priceNextAt: priceInfo.nextAt,
    priceNextInMin: priceInfo.nextInMin,
    hcWindowsLabel: energyCfg.mode === 'hphc' ? hcWindowsLabel(energyCfg) : '',
    prixHp: Number(energyCfg.prix_hp) || 0,
    prixHc: Number(energyCfg.prix_hc) || 0,
    cumulGridHcKWh: cumulGridHcKWh,
    cumulGridHpKWh: cumulGridHpKWh,
    prodEurH: prodEurH,
    gridEurH: gridEurH,
    prodEurMonth: prodEurMonth,
    gridEurMonth: gridEurMonth,
    monthHours: MONTH_HOURS,
    cumulProdEur: cumulProdEur,
    cumulGridEur: cumulGridEur,
    updated_at: timeStr,
    stale: false,
    age_s: 0
  };
}

app.get('/api/solaire', async (req, res) => {
  const force = req.query.force === 'true';
  const now = Date.now();
  
  if (!force && _solaireCache.data && (now - _solaireCache.ts) < 10000) {
    const age_s = Math.floor((now - _solaireCache.ts) / 1000);
    const data = { ..._solaireCache.data, age_s: age_s, stale: age_s > 10 };
    return res.json(data);
  }

  try {
    const data = await fetchSolarData();
    _solaireCache = { ts: now, data: data };
    res.json(data);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Prix du kWh : lecture / écriture (le mode et les prix sont persistés)
app.get('/api/energy-prices', (req, res) => {
  const cfg = loadEnergyPrices();
  const cur = currentEnergyPrice(cfg, new Date());
  res.json({ ok: true, ...cfg, current: cur });
});

app.post('/api/energy-prices', (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};
    if (body.mode === 'base' || body.mode === 'hphc') patch.mode = body.mode;
    ['prix_base', 'prix_hp', 'prix_hc', 'prix_injection'].forEach(function (k) {
      if (body[k] !== undefined) {
        const n = Number(body[k]);
        if (isNaN(n) || n < 0 || n > 5) return;
        patch[k] = n;
      }
    });
    if (Array.isArray(body.hc_windows)) {
      const wins = body.hc_windows
        .filter(function (w) { return Array.isArray(w) && w.length === 2 && !isNaN(Number(w[0])) && !isNaN(Number(w[1])) &&
          Number(w[0]) >= 0 && Number(w[0]) <= 24 && Number(w[1]) >= 0 && Number(w[1]) <= 24; })
        .map(function (w) { return [Number(w[0]), Number(w[1])]; });
      if (wins.length) patch.hc_windows = wins;
    }
    ['hc_debut', 'hc_fin'].forEach(function (k) {
      if (body[k] !== undefined) {
        const n = parseInt(body[k], 10);
        if (!isNaN(n) && n >= 0 && n <= 23) patch[k] = n;
      }
    });
    if (!Object.keys(patch).length) return res.json({ ok: false, error: 'aucun champ valide' });
    const cfg = saveEnergyPrices(patch);
    _solaireCache = { ts: 0, data: null };  // force le recalcul au prochain appel
    res.json({ ok: true, ...cfg, current: currentEnergyPrice(cfg, new Date()) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

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
  const ts  = new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour12: false });
  const cachePct = ((parseFloat(mem.cache) / parseFloat(mem.total)) * 100).toFixed(1);

  // ─── Delegation Tracker (server-rendered) ────────────────────────────
  let delegationHtml = '';

  // ─── Card visibility ─────────────────────────────────────────
  const visibility = loadCardVisibility();
  function vis(id) { return visibility[id] !== false; }
  function visHidden(id) { return !vis(id) ? 'card-hidden' : ''; }

  // --- Card order (glisser-deposer) ---
  const cardOrder = loadCardOrder();
  function orderOf(id) {
    var idx = cardOrder.indexOf(id);
    return 'style="order:' + (idx === -1 ? cardOrder.length : idx) + '"';
  }

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
  .pc-llm-link{display:inline-block;margin-top:0.35rem;padding:0.2rem 0.55rem;background:#0a1a2a;color:#60a5fa;border:1px solid #1e3a5f;border-radius:5px;font-size:0.68rem;text-decoration:none}
  .pc-llm-link:hover{background:#0f2540;color:#93c5fd;border-color:#2563eb}
  .pc-llm-link-row{line-height:1.1}
  .pc-stale-banner{background:#2a0a0a;color:#fca5a5;border:1px solid #7f1d1d;border-radius:6px;padding:0.35rem 0.5rem;font-size:0.68rem;margin-bottom:0.45rem;line-height:1.3}
  .pc-countdown{margin-top:.45rem;font-size:.72rem;font-weight:600;color:#fbbf24}
  .pc-countdown.warn{color:#fb923c}
  .pc-countdown.soon{color:#f87171}
  .pc-countdown.blocked{color:#94a3b8}
  .proc-row{display:flex;justify-content:space-between;align-items:center;font-size:0.7rem;margin-top:0.25rem;font-family:'SF Mono','Fira Code','Consolas',monospace}
  .proc-row .proc-cpu{color:#4ade80;font-weight:600;min-width:2.2rem;text-align:right}
  .proc-row .proc-cmd{color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-left:0.5rem}
  .proc-row .proc-mem{color:#666;font-size:0.65rem;min-width:1.8rem;text-align:right}
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
  .pc-status.busy{background:#451a03;color:#fcd34d;border:1px solid #d97706}
  .pc-status.idle{background:#1a2a21;color:#86c5a8}
  .pc-status.img{background:#2a1a0a;color:#fb923c;border:1px solid #7c2d12}
  .pc-img-port,.pc-img-uptime{font-size:0.65rem;color:#888;margin-left:0.35rem}
  .pc-llm-link-img{background:#231404;color:#fb923c;border-color:#7c2d12}
  .pc-llm-link-img:hover{background:#331e06;color:#fdba74;border-color:#ea580c}
  .pc-llm{font-size:0.72rem;color:#9ca3af;margin-top:0.3rem}
  .pc-llm strong{color:#e0e0e0;font-weight:500}
  .pc-ctx-badge{display:inline-block;padding:0.08rem 0.4rem;border-radius:8px;font-size:0.62rem;font-weight:600;background:#1e293b;color:#93c5fd;margin-left:0.3rem;vertical-align:middle}
  .pc-speed-wrap{margin-top:0.5rem;border-top:1px dashed #1f1f1f;padding-top:0.45rem}
  .pc-speed-wrap:empty{display:none;border-top:none;padding-top:0}
  .pc-speed-row{display:flex;justify-content:space-between;align-items:baseline;font-size:0.7rem;color:#888}
  .pc-speed-val{font-weight:700;color:#e5e5e5}
  .pc-speed-bar{height:8px;background:#1a1a1a;border-radius:4px;margin-top:0.3rem;overflow:hidden}
  .pc-speed-fill{height:100%;border-radius:4px;transition:width 0.5s}
  .pc-speed-sub{font-size:0.62rem;color:#555}
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
  .pc-plug-power{font-size:0.62rem;color:#888;margin-left:0.25rem;font-weight:500}
  .pc-plug-toggle.on .pc-plug-power{color:#86efac}
  .pc-auto-label{display:inline-flex;align-items:center;gap:0.3rem;cursor:pointer;font-size:0.65rem;color:#666;margin-left:auto;user-select:none}
  .pc-auto-label input{display:none}
  .pc-auto-label .slider{width:24px;height:12px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:7px;position:relative;transition:background 0.2s;flex-shrink:0}
  .pc-auto-label .slider::after{content:'';position:absolute;top:1.5px;left:2px;width:7px;height:7px;background:#555;border-radius:50%;transition:all 0.2s}
  .pc-auto-label input:checked+.slider{background:#14532d;border-color:#22c55e}
  .pc-auto-label input:checked+.slider::after{background:#4ade80;left:14px}
  .pc-action-result{font-size:0.62rem;color:#888;margin-top:0.3rem;min-height:1rem}
  /* Card visibility */
  .card-hidden{display:none!important}
  /* --- Glisser-deposer des cartes --- */
  .grid > [data-card-id]{position:relative}
  .grid > .chart-section{grid-column:1/-1;margin-top:0}
  .grid > [data-card-id] .card-header{padding-right:1.7rem}
  .card-drag-handle{position:absolute;top:0.3rem;right:0.35rem;width:26px;height:30px;display:flex;align-items:center;justify-content:center;cursor:grab;user-select:none;-webkit-user-select:none;border:1px solid #262626;border-radius:8px;background:#141414;transition:background .15s,border-color .15s;z-index:5}
  .card-drag-handle::before{content:"";width:12px;height:16px;background-image:radial-gradient(#b4b4b4 1.7px,transparent 1.8px);background-size:6px 6px;background-position:0 0}
  .card-drag-handle:hover{background:#1d2430;border-color:#3b82f6}
  .card-drag-handle:hover::before{background-image:radial-gradient(#60a5fa 1.7px,transparent 1.8px)}
  .card-drag-handle:active{cursor:grabbing}
  [data-card-id].dragging{opacity:.35}
  [data-card-id].drop-before{box-shadow:inset 3px 0 0 0 #3b82f6}
  [data-card-id].drop-after{box-shadow:inset -3px 0 0 0 #3b82f6}
  .settings-hint{font-size:0.7rem;color:#666;margin:0.35rem 0 0.7rem;display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap}
  .settings-reset{background:#151515;color:#aaa;border:1px solid #2a2a2a;border-radius:6px;padding:0.2rem 0.55rem;font-size:0.68rem;cursor:pointer;font-family:inherit}
  .settings-reset:hover{color:#3b82f6;border-color:#3b82f6}
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

  /* Solaire */
  .solaire-kw{font-size:0.8rem;color:#666;margin-top:-0.2rem}
  .solaire-cols{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
  .solaire-col-label{font-size:0.7rem;color:#555;margin-bottom:0.3rem}
  .solaire-col-val{font-size:1.15rem;font-weight:700;line-height:1.1}
  .solaire-col-sub{font-size:0.7rem;color:#555;margin-top:0.2rem}
  .solaire-time{font-size:0.65rem;color:#3a3a3a;margin-top:0.75rem}
  .solaire-grid-sub{font-size:0.75rem;color:#555;margin-top:0.4rem}
  .solaire-grid-badge{margin-top:0.5rem}
  .solaire-eur{font-size:0.85rem;font-weight:700;margin-top:0.35rem}
  .solaire-detail{font-size:0.68rem;color:#555;margin-top:0.15rem}
  .solaire-price{font-size:0.65rem;color:#3a3a3a;margin-top:0.5rem;cursor:pointer}
  .solaire-price:hover{color:#60a5fa}
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
  <div class="settings-hint">Glisser-déposer une carte par sa poignée ⠿ pour la placer où tu veux.<button class="settings-reset" onclick="resetCardOrder()">↺ Ordre par défaut</button></div>
  <div class="settings-grid">
    <label class="settings-row" data-card-id="credits"><span class="s-icon">💳</span><input type="checkbox"${vis('credits')?' checked':''}><span class="s-toggle"></span><span class="s-label">Crédits</span></label>
    <label class="settings-row" data-card-id="depenses"><span class="s-icon">💰</span><input type="checkbox"${vis('depenses')?' checked':''}><span class="s-toggle"></span><span class="s-label">Dépenses LLM (30j + 24h)</span></label>
    <label class="settings-row" data-card-id="systeme"><span class="s-icon">🖥️</span><input type="checkbox"${vis('systeme')?' checked':''}><span class="s-toggle"></span><span class="s-label">Système (CPU/RAM/Disque)</span></label>
    <label class="settings-row" data-card-id="ollama"><span class="s-icon">🦙</span><input type="checkbox"${vis('ollama')?' checked':''}><span class="s-toggle"></span><span class="s-label">Ollama Cloud</span></label>
    <label class="settings-row" data-card-id="pc-gabriel"><span class="s-icon">🖥️</span><input type="checkbox"${vis('pc-gabriel')?' checked':''}><span class="s-toggle"></span><span class="s-label">PC Gabriel</span></label>
    <label class="settings-row" data-card-id="pc-louis"><span class="s-icon">🖥️</span><input type="checkbox"${vis('pc-louis')?' checked':''}><span class="s-toggle"></span><span class="s-label">PC Louis</span></label>
    <label class="settings-row" data-card-id="pc-marie"><span class="s-icon">🖥️</span><input type="checkbox"${vis('pc-marie')?' checked':''}><span class="s-toggle"></span><span class="s-label">PC Marie</span></label>
    <label class="settings-row" data-card-id="pc-boncoin"><span class="s-icon">🖥️</span><input type="checkbox"${vis('pc-boncoin')?' checked':''}><span class="s-toggle"></span><span class="s-label">PC SkillORP</span></label>
    <label class="settings-row" data-card-id="chart"><span class="s-icon">📈</span><input type="checkbox"${vis('chart')?' checked':''}><span class="s-toggle"></span><span class="s-label">Graphique</span></label>
    <label class="settings-row" data-card-id="energie"><span class="s-icon">⚡</span><input type="checkbox"${vis('energie')?' checked':''}><span class="s-toggle"></span><span class="s-label">Énergie (solaire + Linky)</span></label>
  </div>
</div>

<div class="grid">

  <!-- ÉNERGIE : production solaire + import réseau, avec coût/économie €/h -->
  <div class="card ${visHidden('energie')}" data-card-id="energie"${orderOf('energie')} >
    <div class="card-header"><span class="icon">⚡</span><span class="card-title">Énergie en temps réel</span></div>
    <div class="solaire-cols">
      <div class="solaire-col">
        <div class="solaire-col-label">☀️ Production solaire</div>
        <div class="solaire-col-val" style="color:#fbbf24"><span id="energie-prod-w">—<span style="font-size:0.7rem;font-weight:400">W</span></span></div>
        <div class="solaire-col-sub" id="energie-prod-kw">—</div>
        <div class="solaire-eur" id="energie-prod-eur" style="color:#fbbf24">—</div>
        <div class="solaire-detail" id="energie-prod-detail">—</div>
      </div>
      <div class="solaire-col">
        <div class="solaire-col-label">⚡ Import EDF (Linky)</div>
        <div class="solaire-col-val" id="energie-grid-w" style="color:#22c55e">— <span style="font-size:0.7rem;font-weight:400">W</span></div>
        <div class="solaire-col-sub" id="energie-grid-kw">—</div>
        <div class="solaire-eur" id="energie-grid-eur" style="color:#60a5fa">—</div>
        <div class="solaire-detail" id="energie-grid-detail">—</div>
      </div>
    </div>
    <div class="solaire-grid-sub" id="energie-net" style="margin-top:0.6rem">—</div>
    <div class="solaire-grid-badge" id="energie-badge"></div>
    <div class="solaire-detail" id="energie-hc" style="margin-top:0.55rem">—</div>
    <div class="solaire-price" id="energie-price" onclick="editEnergyPrice()" title="Cliquer pour changer le prix du kWh">—</div>
    <div class="solaire-time" id="energie-time">—</div>
  </div>

  <!-- CREDITS -->
  <div class="card ${visHidden('credits')}" data-card-id="credits"${orderOf('credits')} >
    <div class="card-header"><span class="icon">💳</span><span class="card-title">Crédits — Tous providers</span></div>
    <div class="big-value" style="color:${kc}">${credits.total}<span>$</span></div>
    <hr class="divider">
    <div class="row"><span class="label">OpenRouter</span><span class="val" style="color:${credits.or && credits.or.ok ? '#60a5fa' : '#888'}">${credits.or && credits.or.ok ? credits.or.balance + ' $' : '—'}</span></div>
    <div class="row"><span class="label">Kimi</span><span class="val" style="color:${credits.kimi && credits.kimi.ok ? '#a78bfa' : '#888'}">${credits.kimi && credits.kimi.ok ? credits.kimi.balance + ' $' : '—'}</span></div>
    <div class="row"><span class="label">DeepSeek</span><span class="val" style="color:${credits.deepseek && credits.deepseek.ok ? '#4ade80' : '#888'}">${credits.deepseek && credits.deepseek.ok ? credits.deepseek.balance + ' $' : '—'}</span></div>
    <a href="https://platform.deepseek.com/top_up" target="_blank" style="color:#4ade80;font-size:0.75rem;display:inline-block;margin-top:0.6rem">↗ Recharger DeepSeek</a>
  </div>

  <!-- DÉPENSES LLM : 30 jours + 24 h dans une seule carte -->
  <div class="card ${visHidden('depenses')}" data-card-id="depenses"${orderOf('depenses')} >
    <div class="card-header"><span class="icon">💰</span><span class="card-title">Dépenses LLM</span></div>
    <div class="big-value" style="color:#fbbf24;font-size:2.2rem">${spending.total.toFixed(2)}<span>$ · 30 j</span></div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:0.4rem;font-size:0.8rem"><span style="color:#888">Dernières 24 h</span><span style="color:#fbbf24;font-weight:700">${spending24h.total.toFixed(3)} $</span></div>
    <hr class="divider">
    <div class="row" style="opacity:0.65"><span class="label">Provider</span><span class="val-muted">30 j · 24 h</span></div>
    <div class="row"><span class="label">OpenRouter</span><span class="val" style="color:#60a5fa">${spending.or.toFixed(2)} $ · ${spending24h.or.toFixed(3)} $</span></div>
    <div class="row"><span class="label">OpenRouter (ce mois, API)</span><span class="val" style="color:#60a5fa">${live.ok ? live.usageMonthly.toFixed(2) + ' $' : '—'}</span></div>
    <div class="row"><span class="label">Kimi</span><span class="val" style="color:#a78bfa">${spending.kimi.toFixed(2)} $ · ${spending24h.kimi.toFixed(3)} $</span></div>
    <div class="row"><span class="label">DeepSeek</span><span class="val" style="color:#4ade80">${spending.deepseek.toFixed(2)} $ · ${spending24h.deepseek.toFixed(3)} $</span></div>
    <div class="note">Somme des baisses de solde · relevés ~6 h.</div>
  </div>

  <!-- SYSTÈME : CPU + RAM + Disque réunis dans une seule carte -->
  <div class="card ${visHidden('systeme')}" data-card-id="systeme"${orderOf('systeme')} >
    <div class="card-header"><span class="icon">🖥️</span><span class="card-title">Système — serveur</span></div>
    <div class="big-value" style="color:${cc}">${sys.cpuPct}<span>%</span></div>
    ${bar(sys.cpuPct, cc)}
    <div class="row"><span class="label">Load avg (1m)</span><span class="val">${sys.load1}</span></div>
    <div class="row"><span class="label">Cœurs logiques</span><span class="val">${sys.cpuCount}</span></div>
    ${tag(parseFloat(sys.cpuPct) < 50, parseFloat(sys.cpuPct) < 80, '✓ Normal', '⚠ Élevé', '✕ Critique')}
    <div id="top-processes">
      <div class="proc-row" style="text-align:center;padding:0;color:#444;font-size:0.7rem">⏳ Top process…</div>
    </div>
    <hr class="divider">
    <div class="big-value" style="color:${rc}">${mem.usedByApps}<span>GB apps</span></div>
    <div class="bar-bg">
      <div class="bar-fill" style="width:${Math.min(100,parseFloat(mem.appsPct))}%;background:${rc}"></div>
      <div class="bar-fill bar-cache" style="width:${Math.min(100,parseFloat(mem.appsPct)+parseFloat(cachePct))}%;background:#4ade80;opacity:0.12"></div>
    </div>
    <div class="row"><span class="label">Disponible pour apps</span><span class="val" style="color:#4ade80">${mem.available} GB</span></div>
    <div class="row"><span class="label">Cache disque (libérable)</span><span class="val-muted">${mem.cache} GB</span></div>
    <div class="row"><span class="label">Total VM</span><span class="val">${mem.total} GB</span></div>
    ${parseFloat(mem.swapUsed) > 0.01 ? `<div class="row"><span class="label">Swap utilisé</span><span class="val" style="color:#facc15">${mem.swapUsed} / ${mem.swapTotal} GB</span></div>` : ''}
    ${tag(parseFloat(mem.appsPct) < 50, parseFloat(mem.appsPct) < 75, '✓ Normal', '⚠ Élevé', '✕ Critique')}
    <div class="note">Proxmox affiche ${mem.proxmoxPct}% (cache disque inclus) · usage réel des processus <strong style="color:#aaa">${mem.appsPct}%</strong> · ${mem.available} GB libres</div>
    <hr class="divider">
    <div class="big-value" style="color:${dc}">${disk.used}<span>GB utilisés</span></div>
    ${bar(disk.usedPct, dc)}
    <div class="row"><span class="label">Espace libre</span><span class="val" style="color:#4ade80">${disk.avail} GB</span></div>
    <div class="row"><span class="label">Capacité totale</span><span class="val">${disk.total} GB</span></div>
    <div class="row"><span class="label">Utilisation</span><span class="val">${disk.usedPct}%</span></div>
    ${tag(parseFloat(disk.usedPct) < 60, parseFloat(disk.usedPct) < 85, '✓ OK', '⚠ Rempli', '✕ Critique')}
  </div>

  <!-- OLLAMA CLOUD -->
  <div class="card ${visHidden('ollama')}" data-card-id="ollama"${orderOf('ollama')} >
    <div class="card-header"><span class="icon">🦙</span><span class="card-title">Ollama Cloud</span></div>
    <div class="big-value" style="color:#a78bfa">${ollama.plan}<span> plan</span></div>
    <hr class="divider">
    <a href="https://ollama.com/settings" target="_blank" style="color:#60a5fa;font-size:0.8rem">↗ Voir l'usage sur ollama.com</a>
    ${!ollama.ok ? `<p class="error-note">Erreur API : ${ollama.error}</p>` : ''}
  </div>

  <!-- PC GABRIEL -->
  <div class="card ${visHidden('pc-gabriel')}" data-card-id="pc-gabriel"${orderOf('pc-gabriel')} id="pc-gabriel-card">
    <div class="card-header"><span class="icon">🖥️</span><span class="card-title">PC Gabriel <span id="pc-gabriel-ip" style="color:#444;font-weight:400;margin-left:0.5rem;font-size:0.7rem">192.168.3.224</span><span id="pc-gabriel-time" style="color:#444;font-weight:400;margin-left:0.5rem;font-size:0.65rem"></span></span><label class="alert-toggle" title="Activer alertes CPU/RAM >80%"><input type="checkbox" id="alert-gabriel" checked><span class="slider"></span>🔔</label></div>
    <div id="pc-gabriel-body">
      <div style="text-align:center;padding:1rem 0;color:#555;font-size:0.8rem">⏳ Chargement…</div>
    </div>
    <div class="pc-actions" id="pc-gabriel-actions" style="display:none">
      <button class="pc-btn" onclick="pcAction('gabriel','start_llm')">▶ Démarrer LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('gabriel','kill_llm')">⏹ Arrêter LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('gabriel','shutdown')">⏻ Éteindre</button>
      <label class="pc-plug-toggle" id="pc-gabriel-plug-toggle" title="Allumer/éteindre la prise">🔌 <span class="pc-plug-slider" id="pc-gabriel-plug-slider"></span><span class="pc-plug-status" id="pc-gabriel-plug-status">❓</span><span class="pc-plug-power" id="pc-gabriel-plug-power"></span></label>
      <label class="pc-auto-label" title="Kill automatique du LLM si RAM > 90%">
        <input type="checkbox" id="auto-kill-gabriel">
        <span>Auto-kill RAM &gt;90%</span>
      </label>
    </div>
  </div>

  <!-- PC LOUIS -->
  <div class="card ${visHidden('pc-louis')}" data-card-id="pc-louis"${orderOf('pc-louis')} id="pc-louis-card">
    <div class="card-header"><span class="icon">🖥️</span><span class="card-title">PC Louis <span id="pc-louis-ip" style="color:#444;font-weight:400;margin-left:0.5rem;font-size:0.7rem">192.168.3.206</span><span id="pc-louis-time" style="color:#444;font-weight:400;margin-left:0.5rem;font-size:0.65rem"></span></span><label class="alert-toggle" title="Activer alertes CPU/RAM >80%"><input type="checkbox" id="alert-louis" checked><span class="slider"></span>🔔</label></div>
    <div id="pc-louis-body">
      <div style="text-align:center;padding:1rem 0;color:#555;font-size:0.8rem">⏳ Chargement…</div>
    </div>
    <div class="pc-actions" id="pc-louis-actions" style="display:none">
      <button class="pc-btn" onclick="pcAction('louis','start_llm')">▶ Lancer LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('louis','kill_llm')">⏹ Kill LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('louis','shutdown')">⏻ Éteindre</button>
      <label class="pc-plug-toggle" id="pc-louis-plug-toggle" title="Allumer/éteindre la prise">🔌 <span class="pc-plug-slider" id="pc-louis-plug-slider"></span><span class="pc-plug-status" id="pc-louis-plug-status">❓</span><span class="pc-plug-power" id="pc-louis-plug-power"></span></label>
      <label class="pc-auto-label" title="Kill automatique du LLM si RAM > 90%">
        <input type="checkbox" id="auto-kill-louis">
        <span>Auto-kill RAM &gt;90%</span>
      </label>
    </div>
  </div>

  <!-- PC MARIE -->
  <div class="card ${visHidden('pc-marie')}" data-card-id="pc-marie"${orderOf('pc-marie')} id="pc-marie-card">
    <div class="card-header"><span class="icon">🖥️</span><span class="card-title">PC Marie <span id="pc-marie-ip" style="color:#444;font-weight:400;margin-left:0.5rem;font-size:0.7rem">192.168.3.57</span><span id="pc-marie-time" style="color:#444;font-weight:400;margin-left:0.5rem;font-size:0.65rem"></span></span><label class="alert-toggle" title="Activer alertes CPU/RAM >80%"><input type="checkbox" id="alert-marie" checked><span class="slider"></span>🔔</label></div>
    <div id="pc-marie-body">
      <div style="text-align:center;padding:1rem 0;color:#555;font-size:0.8rem">⏳ Chargement…</div>
    </div>
    <div class="pc-actions" id="pc-marie-actions" style="display:none">
      <button class="pc-btn" onclick="pcAction('marie','start_llm')">▶ Lancer LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('marie','kill_llm')">⏹ Kill LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('marie','shutdown')">⏻ Éteindre</button>
      <label class="pc-plug-toggle" id="pc-marie-plug-toggle" title="Allumer/éteindre la prise">🔌 <span class="pc-plug-slider" id="pc-marie-plug-slider"></span><span class="pc-plug-status" id="pc-marie-plug-status">❓</span><span class="pc-plug-power" id="pc-marie-plug-power"></span></label>
      <label class="pc-auto-label" title="Kill automatique du LLM si RAM > 90%">
        <input type="checkbox" id="auto-kill-marie">
        <span>Auto-kill RAM &gt;90%</span>
      </label>
    </div>
  </div>

  <!-- PC SKILLORP (tour d'occasion) — backend skillorp-dashboard :3036, SSH 192.168.3.249, prise HA -->
  <div class="card ${visHidden('pc-boncoin')}" data-card-id="pc-boncoin"${orderOf('pc-boncoin')} id="pc-boncoin-card">
    <div class="card-header"><span class="icon">🖥️</span><span class="card-title">PC SkillORP <span id="pc-boncoin-ip" style="color:#444;font-weight:400;margin-left:0.5rem;font-size:0.7rem">192.168.3.249</span><span id="pc-boncoin-time" style="color:#444;font-weight:400;margin-left:0.5rem;font-size:0.65rem"></span></span><label class="alert-toggle" title="Activer alertes CPU/RAM >80%"><input type="checkbox" id="alert-boncoin" checked><span class="slider"></span>🔔</label></div>
    <div id="pc-boncoin-body">
      <div style="text-align:center;padding:1rem 0;color:#555;font-size:0.8rem">⏳ Chargement…</div>
    </div>
    <div class="pc-actions" id="pc-boncoin-actions" style="display:none">
      <button class="pc-btn" onclick="pcAction('boncoin','start_llm')">▶ Lancer LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('boncoin','kill_llm')">⏹ Kill LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('boncoin','shutdown')">⏻ Éteindre</button>
      <label class="pc-plug-toggle" id="pc-boncoin-plug-toggle" title="Allumer/éteindre la prise">🔌 <span class="pc-plug-slider" id="pc-boncoin-plug-slider"></span><span class="pc-plug-status" id="pc-boncoin-plug-status">❓</span><span class="pc-plug-power" id="pc-boncoin-plug-power"></span></label>
      <label class="pc-auto-label" title="Kill automatique du LLM si RAM >90%">
        <input type="checkbox" id="auto-kill-boncoin">
        <span>Auto-kill RAM &gt;90%</span>
      </label>
    </div>
    <div class="pc-action-result" id="pc-boncoin-result"></div>
  </div>


  <!-- Chart Section -->
  <div class="chart-section ${visHidden('chart')}" data-card-id="chart" ${orderOf('chart')}>
  <div class="card-header"><span class="icon">📈</span><span class="card-title">Évolution des crédits (30 jours)</span></div>
  <div id="chart-container" class="chart-container">
    <div id="chart-placeholder" class="chart-placeholder">Collecte de données en cours...</div>
    <canvas id="creditsChart"></canvas>
    </div>
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

<script>
// Top processes — refresh every 15s
(function() {
  function renderProcs(data) {
    var el = document.getElementById('top-processes');
    if (!el) return;
    var html = '';
    for (var i = 0; i < data.length; i++) {
      var p = data[i];
      var cpuStr = p.cpu.toFixed(1) + '%';
      var memStr = p.mem.toFixed(1) + '%';
      var cmd = p.cmd.length > 55 ? p.cmd.substring(0, 52) + '…' : p.cmd;
      html += '<div class="proc-row">'
        + '<span class="proc-cpu" style="color:' + (p.cpu < 30 ? '#4ade80' : p.cpu < 60 ? '#facc15' : '#f87171') + '">' + cpuStr + '</span>'
        + '<span class="proc-cmd">' + cmd + '</span>'
        + '<span class="proc-mem">' + memStr + '</span>'
        + '</div>';
    }
    el.innerHTML = html;
  }

  function fetchProcs() {
    fetch('/api/top-processes')
      .then(function(r) { return r.json(); })
      .then(renderProcs)
      .catch(function() { /* silently retry next cycle */ });
  }

  fetchProcs();
  setInterval(fetchProcs, 15000);
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
    ['gabriel','louis','marie','boncoin'].forEach(function(name) {
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
      if (data._stale === true || data._stale === 'true') return; // données figées → pas d'alerte fantôme
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

  // Extrait le contexte max (ctx-size) d'une commande llama-server.
  // Matche -c N ou --ctx-size N, JAMAIS --ctx-size-draft N (espace requis après le flag).
  // NOTE: backslashes doubles (\\s) — le HTML est servi via une template literal
  // qui droppe les backslashes simples (\s devient s à l'exécution).
  function extractCtxSize(cmd) {
    if (!cmd || cmd === '—') return null;
    var m = cmd.match(/(?:^|\\s)--ctx-size\\s+(\\d+)/);
    if (!m) m = cmd.match(/(?:^|\\s)-c\\s+(\\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  // Format lisible : 98304 -> 96K, 1310720 -> 1.25M, 262144 -> 256K
  function formatCtxSize(n) {
    if (n >= 1048576) {
      return (n / 1048576).toFixed(2).replace(/\\.?0+$/, '') + 'M';
    }
    if (n >= 1024) return Math.round(n / 1024) + 'K';
    return String(n);
  }
  // IP LAN de chaque carte (pour le lien direct vers l'interface web du serveur LLM)
  var PC_IPS = { gabriel: '192.168.3.224', louis: '192.168.3.206', marie: '192.168.3.57', boncoin: '192.168.3.249' };
  // Port d'ecoute du serveur LLM : --port (llama.cpp) ou --listen-port (sd-server), sinon 8080.
  // Parsing par split volontairement (pas de regex : une regex ici devrait doubler ses backslashes).
  function extractLlmPort(cmd) {
    if (!cmd || cmd === '—') return null;
    var parts = String(cmd).split(' ');
    for (var i = 0; i < parts.length; i++) {
      if ((parts[i] === '--port' || parts[i] === '--listen-port') && parts[i + 1]) {
        var digits = parts[i + 1].replace(/[^0-9]/g, '');
        return digits || null;
      }
    }
    return null;
  }
  // Age lisible : 42 -> 42s, 180 -> 3min, 5400 -> 1h30
  function formatAge(sec) {
    var s = Math.max(0, Math.round(parseFloat(sec) || 0));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'min';
    var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h + 'h' + (m > 0 ? String(m).padStart(2, '0') : '00');
  }
  // Extrait le nombre de slots paralleles (--parallel N / -np N) d'une commande llama-server.
  // Absent -> 1. Ne matche pas --parallel-draft ni d'autres flags (espace requis apres le flag).
  function extractParallel(cmd) {
    if (!cmd || cmd === '—') return 1;
    var m = cmd.match(/(?:^|\\s)--parallel\\s+(\\d+)/);
    if (!m) m = cmd.match(/(?:^|\\s)-np\\s+(\\d+)/);
    var n = m ? parseInt(m[1], 10) : 1;
    return n > 0 ? n : 1;
  }

  // Vision multimodale : le serveur llama.cpp a un projecteur multimodal charge (--mmproj).
  // Source de verite = la ligne de commande du process VIVANT (deja presente dans llm_cmd,
  // remontee par les agents dashboard) -> aucune modif cote machines distantes.
  // Priorite a llm_vision si un agent l'expose un jour. Pas de regex : dans la template
  // literal servie, les backslashes devraient etre doubles (cf. extractCtxSize).
  function llmHasVision(d) {
    if (!d) return false;
    if (d.llm_vision === true || d.llm_vision === 1 || d.llm_vision === '1') return true;
    var cmd = d.llm_cmd;
    return !!(cmd && cmd !== '—' && cmd.indexOf('--mmproj') !== -1);
  }

  // ── Barre de VITESSE (t/s à ~100k de contexte) ────────────────────────────
  // Source : /api/llm-speed → data/llm-speed.json (mesure scripts/bench-llm-speed.py).
  // Un chiffre par nœud, barre remplie au prorata du PLUS RAPIDE (100 % = le plus rapide).
  // ⚠️ Bloc dans une template literal : pas de backtick, pas d'antislash.
  var _llmSpeed = null;

  function speedInnerHtml(name) {
    var s = _llmSpeed;
    if (!s || !s.by_node) return '';
    var n = s.by_node[name];
    if (!n || !n.ok || !n.gen_tps) return '';
    var max = parseFloat(s.max_gen_tps) || n.gen_tps;
    var pct = Math.max(3, Math.min(100, (n.gen_tps / max) * 100));
    var col = (pct > 99) ? '#22c55e' : (pct >= 60 ? '#38bdf8' : '#f59e0b');
    var ctxTxt = s.context_tokens ? Math.round(s.context_tokens / 1000) + 'k' : '?';
    var sub = (n.model ? n.model : '') +
      (n.prefill_tps ? ' · prefill ' + n.prefill_tps + ' t/s' : '') +
      (n.steps_s ? ' · décode ' + n.steps_s + ' steps/s' : '') +
      (n.contended ? ' · ⚠ mesuré sous charge partagée' : '');
    // Deux regimes mesures : le t/s du serveur inclut la speculation, donc il depend du
    // CONTENU genere (meme machine : 28 t/s sur du texte libre, 84 t/s sur une enumeration).
    // La barre reste sur le regime texte (ce que l'utilisateur voit en pratique) ; les deux
    // chiffres sont affiches pour que personne ne compare un t/s isole.
    var reg = n.gen_tps_repeat
      ? '<div class="pc-speed-row pc-speed-sub" style="margin-top:0.15rem"><span>texte libre ' + n.gen_tps +
        ' t/s · sortie répétitive ' + n.gen_tps_repeat + ' t/s</span></div>'
      : '';
    return '<div class="pc-speed-row"><span>⚡ Vitesse <span class="pc-speed-sub">texte libre @' + ctxTxt + ' ctx</span></span>' +
      '<span class="pc-speed-val">' + n.gen_tps + ' t/s</span></div>' +
      '<div class="pc-speed-bar"><div class="pc-speed-fill" style="width:' + pct.toFixed(1) + '%;background:' + col + '"></div></div>' +
      '<div class="pc-speed-row pc-speed-sub" style="margin-top:0.2rem"><span>' + sub + '</span>' +
      '<span>' + Math.round(pct) + '% du max</span></div>' + reg +
      intelInnerHtml(name);
  }

  // Seconde barre (prévue) : intelligence mesurée. N'apparaît que si la mesure existe
  // dans data/llm-speed.json (champ by_node.<pc>.intel.score), donc rien à faire tant
  // que le banc d'intelligence n'a pas tourné.
  function intelInnerHtml(name) {
    var s = _llmSpeed;
    if (!s || !s.by_node || !s.by_node[name]) return '';
    var it = s.by_node[name].intel;
    if (!it || !it.score) return '';
    var max = parseFloat(s.max_intel_score) || it.score;
    var pct = Math.max(3, Math.min(100, (it.score / max) * 100));
    var col = (pct > 99) ? '#a78bfa' : (pct >= 60 ? '#818cf8' : '#f472b6');
    return '<div class="pc-speed-row" style="margin-top:0.4rem"><span>🧠 Intelligence <span class="pc-speed-sub">' + (it.bench || 'score') + '</span></span>' +
      '<span class="pc-speed-val">' + it.score + (it.unit || '%') + '</span></div>' +
      '<div class="pc-speed-bar"><div class="pc-speed-fill" style="width:' + pct.toFixed(1) + '%;background:' + col + '"></div></div>' +
      '<div class="pc-speed-row pc-speed-sub" style="margin-top:0.2rem"><span>' + (it.detail || '') + '</span>' +
      '<span>absolu / 100</span></div>';
  }

  function speedBlockHtml(name) {
    return '<div class="pc-speed-wrap" id="pc-' + name + '-speed">' + speedInnerHtml(name) + '</div>';
  }

  function refreshSpeedBars() {
    ['gabriel', 'louis', 'marie'].forEach(function(n) {
      var el = document.getElementById('pc-' + n + '-speed');
      if (el) el.innerHTML = speedInnerHtml(n);
    });
  }

  function fetchLlmSpeed() {
    fetch('/api/llm-speed').then(function(r) { return r.json(); }).then(function(d) {
      _llmSpeed = d;
      refreshSpeedBars();
    }).catch(function() {});
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
      actionsEl.style.display = (name === 'marie' || name === 'louis' || name === 'gabriel' || name === 'boncoin') ? 'flex' : 'none';
    }

    if (!data || data.error) {
      body.innerHTML = '<div class="error-note" style="padding:0.5rem 0;text-align:center">⚠️ ' + (data ? data.error : 'Données indisponibles') + '</div>';
      return;
    }

    // Données figées : le backend n'a pas pu rafraîchir (SSH/backend mort) — le cache
    // conserve le dernier relevé. On l'AFFICHE COMME PÉRIMÉ, jamais comme live.
    var stale = (data._stale === true || data._stale === 'true');
    var staleAge = (data._age_s === 0 || data._age_s) ? formatAge(data._age_s) : '—';
    var ts = data.timestamp || '—';
    if (timeEl) timeEl.textContent = stale ? ('⛔ ' + ts + ' · figé') : ts;

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
    // ⚠️ OBLIGATOIRE : 2 backslashes en source → le JS servi passe par une template
    // literal (1 backslash y devient 0) → regex cassée, nom du modèle jamais extrait.
    if (data.llm_cmd && data.llm_cmd !== '—') {
      var m = data.llm_cmd.match(/-m\\s+(\\S+)/);
      if (m) { llmModel = m[1].split('/').pop() || m[1]; }
    }
    // Contexte max (ctx-size) depuis la commande + parallel (slots) : badge ex: ctx 256K/req x 5
    // ctx par slot = ctx_total / parallel (entier, arrondi) ; si parallel absent ou <= 1 -> ctx total seul
    var llmCtx = extractCtxSize(data.llm_cmd);
    var llmParallel = extractParallel(data.llm_cmd);
    var llmCtxBadge = '';
    if (llmCtx) {
      if (llmParallel > 1) {
        var perSlot = Math.round(llmCtx / llmParallel);
        llmCtxBadge = '<span class="pc-ctx-badge">ctx ' + formatCtxSize(perSlot) + '/req x ' + llmParallel + '</span>';
      } else {
        llmCtxBadge = '<span class="pc-ctx-badge">ctx ' + formatCtxSize(llmCtx) + '</span>';
      }
    }
    // Fallback au champ fourni si le parsing a échoué
    if (llmModel === '—' && data.llm_model) { llmModel = data.llm_model; }
    var llmStatus = llmRunning;
    // Occupation LLM — cle llm_busy (1/0) issue du sondage /slots cote machine (is_processing)
    // Données figées => on ne prétend RIEN sur l'état du LLM (ni Running ni Stopped).
    var llmBusy = !stale && llmRunning && (data.llm_busy === 1 || data.llm_busy === '1' || data.llm_busy === true);
    // Compteur de taches en cours : llm_slots_used / llm_slots_total, remontes par les
    // collecteurs qui interrogent /slots (Marie : --parallel 2 => 2 requetes simultanees).
    // Affiche uniquement si le serveur a PLUSIEURS slots, sinon "0/1" ne serait que du bruit.
    var slotsUsed = parseInt(data.llm_slots_used, 10);
    var slotsTotal = parseInt(data.llm_slots_total, 10);
    var hasSlots = !isNaN(slotsUsed) && !isNaN(slotsTotal) && slotsTotal > 1 && slotsUsed >= 0;
    var llmActivityBadge = '';
    if (!stale && llmStatus) {
      if (hasSlots) {
        var slotsLbl = slotsUsed + '/' + slotsTotal + (slotsUsed > 1 ? ' tâches' : ' tâche');
        llmActivityBadge = slotsUsed > 0
          ? '<span class="pc-status busy">⚡ ' + slotsLbl + ' en cours</span>'
          : '<span class="pc-status idle">LIBRE · ' + slotsLbl + '</span>';
      } else {
        llmActivityBadge = llmBusy ? '<span class="pc-status busy">⚡ TACHE EN COURS</span>' : '<span class="pc-status idle">LIBRE</span>';
      }
    }
    // Vision multimodale (mmproj) : meme badge que la carte .224, mais deduit du process vivant.
    var llmVisionBadge = (!stale && llmStatus && llmHasVision(data)) ? ' <span class="pc-status img">🖼 vision</span>' : '';
    var llmStateHtml = stale
      ? '<span class="pc-status off">● État inconnu (figé)</span>'
      : '<span class="pc-status ' + (llmStatus ? 'on' : 'off') + '">' + (llmStatus ? '● Running' : '● Stopped') + '</span>';
    var llmModelTxt = stale ? '—' : llmModel;
    var llmCtxBadgeTxt = stale ? '' : llmCtxBadge;
    var llmRss = data.llm_rss_gb ? data.llm_rss_gb + ' GB' : '—';
    var llmUptime = data.llm_uptime || '—';
    // Lien direct vers l'interface web du serveur LLM de la machine (llama.cpp :8080, ou le
    // port reel lu dans la ligne de commande --port / --listen-port)
    var llmPort = extractLlmPort(data.llm_cmd) || '8080';
    var pcIp = PC_IPS[name] || '';
    var llmLinkHtml = pcIp
      ? '<a class="pc-llm-link" href="http://' + pcIp + ':' + llmPort + '/" target="_blank" rel="noopener">🔗 LLM :' + llmPort + '</a>'
      : '';
    // Serveur d'images Qwen-Image (sd-server) : ligne dediee + lien vers SON interface.
    // Sans ca, la carte du .224 ne voyait que les llama-server : pendant une generation
    // d'images elle affichait "● Stopped" et un lien vers un 8080 eteint.
    var imgRunning = (data.img_status === 'active') || (data.img_running === true);
    var imgPort = parseInt(data.img_port, 10) || 0;
    var imgHtml = '';
    var imgLinkHtml = '';
    if (!stale && imgRunning) {
      var imgModel = data.img_model || 'Qwen-Image';
      var imgCount = parseInt(data.img_count, 10) || 0;
      imgHtml = '<div class="pc-llm">🎨 <strong>' + imgModel + '</strong>' +
        '<span class="pc-status img">● Running</span>' +
        (imgPort ? '<span class="pc-img-port">:' + imgPort + '</span>' : '') +
        (data.img_uptime && data.img_uptime !== '-' ? '<span class="pc-img-uptime">↑ ' + data.img_uptime + '</span>' : '') +
        (imgCount > 1 ? '<span class="pc-img-uptime">×' + imgCount + ' serveurs</span>' : '') +
        '</div>';
      if (pcIp && imgPort) {
        imgLinkHtml = '<a class="pc-llm-link pc-llm-link-img" href="http://' + pcIp + ':' + imgPort + '/" target="_blank" rel="noopener">🔗 Image :' + imgPort + '</a>';
      }
    }

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

    var cpuBadge = (alertsOn && !stale && cpu > ALERT_CPU) ? alertBadge(cpu, ALERT_CPU) : '';
    var ramBadge = (alertsOn && !stale && memPct > ALERT_RAM) ? alertBadge(memPct, ALERT_RAM) : '';

    // VRAM : une ligne par GPU si data.gpus est présent, sinon fallback agrégé (compat 1 GPU)
    var vramHtml;
    if (data.gpus && data.gpus.length > 0) {
      vramHtml = data.gpus.map(function(g) {
        var gp = parseFloat(g.pct) || 0;
        var gName = g.name || ('GPU ' + g.index);
        var gDetail = (g.total > 0) ? (g.used / 1024).toFixed(1) + 'G / ' + (g.total / 1024).toFixed(1) + 'G' : '—';
        var gTemp = g.temp ? g.temp + '°C' : '—';
        return '<div class="pc-row" style="margin-top:0.6rem"><span class="lbl">' + gName + '</span><span class="val" style="color:' + c(gp,70,90) + '">' + gp.toFixed(1) + '%</span></div>' +
          '<div class="pc-mini-bar"><div class="pc-mini-fill" style="width:' + Math.min(100,gp) + '%;background:' + c(gp,70,90) + '"></div></div>' +
          '<div style="font-size:0.7rem;color:#666;margin-top:0.15rem;display:flex;justify-content:space-between"><span>' + gDetail + '</span><span>' + gTemp + '</span></div>';
      }).join('');
    } else {
      vramHtml = '<div class="pc-row" style="margin-top:0.6rem"><span class="lbl">VRAM</span><span class="val" style="color:' + c(vramPct,70,90) + '">' + vramPct.toFixed(1) + '%</span></div>' +
        '<div class="pc-mini-bar"><div class="pc-mini-fill" style="width:' + Math.min(100,vramPct) + '%;background:' + c(vramPct,70,90) + '"></div></div>' +
        '<div style="font-size:0.7rem;color:#666;margin-top:0.15rem;display:flex;justify-content:space-between"><span>' + vramDetail + '</span><span>' + vramTemp + '</span></div>';
    }

    // Compte a rebours d extinction (watchdog PC idle). PC actif => aucune ligne.
    var countdownHtml = '';
    var asd = data.auto_shutdown;
    if (asd && !stale) {
      if (asd.blocked) {
        countdownHtml = '<div class="pc-countdown blocked">⏻ Extinction suspendue (cron ' + (asd.cronAt || '—') + ')</div>';
      } else if (asd.shutdownAtMs) {
        var remaining = Math.round((asd.shutdownAtMs - Date.now()) / 60000);
        if (remaining <= 0) {
          countdownHtml = '<div class="pc-countdown soon">⏻ Extinction imminente</div>';
        } else {
          var cdCls = remaining <= 5 ? ' soon' : (remaining <= 10 ? ' warn' : '');
          countdownHtml = '<div class="pc-countdown' + cdCls + '">⏻ Extinction dans ' + remaining + ' min</div>';
        }
      }
    }

    var staleBanner = stale
      ? '<div class="pc-stale-banner">⛔ Données figées — backend injoignable. Dernier relevé il y a ' + staleAge + ' (' + (data.timestamp || '?') + ')</div>'
      : '';

    body.innerHTML =
      staleBanner +
      '<div class="pc-row"><span class="lbl">CPU' + (cpuBadge ? '' : '') + '</span><span class="val" style="color:' + c(cpu,50,80) + '">' + cpu.toFixed(1) + '%' + cpuBadge + '</span></div>' +
      '<div class="pc-mini-bar"><div class="pc-mini-fill" style="width:' + Math.min(100,cpu) + '%;background:' + c(cpu,50,80) + '"></div></div>' +
      '<div class="pc-row"><span class="lbl">RAM' + (ramBadge ? '' : '') + '</span><span class="val" style="color:' + c(memPct,60,80) + '">' + memPct.toFixed(1) + '%' + ramBadge + '</span></div>' +
      '<div class="pc-mini-bar"><div class="pc-mini-fill" style="width:' + Math.min(100,memPct) + '%;background:' + c(memPct,60,80) + '"></div></div>' +
      '<div style="font-size:0.7rem;color:#666;margin-top:0.15rem;display:flex;justify-content:space-between"><span>' + memUsed + ' / ' + memTotal + '</span><span>libre ' + memAvail + '</span></div>' +
      vramHtml +
      countdownHtml +
      '<hr class="divider">' +
      ((name === 'gabriel')
        ? '<div class="pc-llm" id="pc-gabriel-llm">🧠 <strong>—</strong> <span class="pc-status idle">⏳ état…</span></div>'
        : '<div class="pc-llm" id="pc-' + name + '-llm">🧠 <strong>' + llmModelTxt + '</strong>' + llmCtxBadgeTxt + ' ' + llmStateHtml + llmVisionBadge + llmActivityBadge + '</div>') +
      ((!stale && llmStatus) ? '<div class="pc-llm" style="margin-top:0.15rem;font-size:0.68rem">RSS: ' + llmRss + ' · ↑ ' + llmUptime + '</div>' : '') +
      speedBlockHtml(name) +
      imgHtml +
      '<div class="pc-llm-link-row">' + llmLinkHtml + imgLinkHtml + '</div>' +
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

    if (name === 'gabriel') refreshLlm224();

    updateAlertBanner();
  }

  // ── État du LLM du .224 (Strata ou llama.cpp) ────────────────────────────
  // Lu sur /api/llm-224 (sonde HTTP /health + /v1/models côté serveur), JAMAIS sur les
  // process : le .224 change de moteur et Strata (Python) n'a aucun llama-server.
  // ⚠️ Ce bloc vit dans une template literal : pas de backtick, pas d'interpolation, pas d'antislash.
  var _llm224Busy = false;
  var _llm224StartTs = 0;

  function renderLlm224(info) {
    var el = document.getElementById('pc-gabriel-llm');
    if (!el) return;
    var html = '';
    if (info.state === 'stopped') {
      html = '🧠 <strong>—</strong> <span class="pc-status off">● Arrêté</span>';
    } else if (info.state === 'starting') {
      html = '🧠 <strong>démarrage…</strong> <span class="pc-status busy">● En cours de démarrage…</span> <span class="pc-status idle">(66-120 s, première charge)</span>';
    } else if (info.state === 'running') {
      var modelTxt = info.model ? info.model : 'modèle inconnu';
      html = '🧠 <strong>' + modelTxt + '</strong>';
      if (info.ctx) { html += ' <span class="pc-ctx-badge">ctx ' + formatCtxSize(info.ctx) + '</span>'; }
      html += ' <span class="pc-status on">● En marche :8080</span>';
      if (info.images === true) { html += ' <span class="pc-status img">🖼 vision</span>'; }
      // Occupation — même badge que les cartes Louis/Marie, mais lu sur /slots (Strata n'a
      // pas de processus llama-server : c'est le badge du backend SSE qui manquait ici).
      if (info.busy === true) {
        html += ' <span class="pc-status busy">⚡ TACHE EN COURS</span>';
        var act = info.activity || null;
        var det = '';
        if (act) {
          if (act.tokens_per_s) { det += act.tokens_per_s + ' t/s'; }
          if (act.generated) { det += (det ? ' · ' : '') + act.generated + ' tok'; }
          if (typeof act.elapsed_s === 'number') { det += (det ? ' · ' : '') + act.elapsed_s + ' s'; }
        }
        if (det) { html += ' <span class="pc-status idle">' + det + '</span>'; }
      } else if (info.busy === false) {
        html += ' <span class="pc-status idle">LIBRE</span>';
      }
    } else {
      html = '🧠 <strong>—</strong> <span class="pc-status off">● État inconnu</span>';
    }
    el.innerHTML = html;
  }

  function refreshLlm224() {
    if (_llm224Busy) return;
    _llm224Busy = true;
    fetch('/api/llm-224').then(function(r) { return r.json(); }).then(function(data) {
      _llm224Busy = false;
      renderLlm224(data);
      // Pendant un démarrage on re-sonde toutes les 5 s, mais jamais plus de 4 min
      // (au-delà : le démarrage a échoué, on laisse la carte dire « Arrêté »).
      if (data && data.state === 'starting') {
        if (!_llm224StartTs) _llm224StartTs = Date.now();
        if ((Date.now() - _llm224StartTs) < 240000) setTimeout(function() { refreshLlm224(); }, 5000);
      } else {
        _llm224StartTs = 0;
      }
    }).catch(function(e) {
      _llm224Busy = false;
      _llm224StartTs = 0;
      renderLlm224({ state: 'unknown', error: 'réseau' });
    });
  }

  function refreshAll() {
    fetch('/api/pc-gabriel').then(function(r){return r.json();}).then(function(d){renderPc(d,'gabriel');}).catch(function(e){console.error('pc-gabriel:',e);});
    fetch('/api/pc-louis').then(function(r){return r.json();}).then(function(d){renderPc(d,'louis');}).catch(function(e){console.error('pc-louis:',e);});
    fetch('/api/pc-marie').then(function(r){return r.json();}).then(function(d){renderPc(d,'marie');}).catch(function(e){console.error('pc-marie:',e);});
    fetch('/api/pc-boncoin').then(function(r){return r.json();}).then(function(d){renderPc(d,'boncoin');}).catch(function(e){console.error('pc-boncoin:',e);});
    fetchPlugState('gabriel');
    fetchPlugState('louis');
    fetchPlugState('marie');
    fetchPlugState('boncoin');
    fetchLlmSpeed();
    fetchSolaire();
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
    var resultEl = document.getElementById('pc-' + pc + '-result');
    // Feedback visuel immédiat pendant la requête (start_llm peut prendre plusieurs secondes)
    if (resultEl && action === 'start_llm') resultEl.textContent = '⏳ Lancement…';
    if (resultEl && action === 'kill_llm' && pc === 'gabriel') resultEl.textContent = '⏳ Arrêt en cours…';

    fetch('/api/pc-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pc: pc, action: action, enabled: value })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      console.log('pcAction(' + pc + ', ' + action + '):', res);
      // Toujours afficher le résultat final (ok ou échec) — le bouton ne doit plus rester muet
      if (resultEl) {
        if (res.ok) {
          // Un démarrage lancé n'est PAS un démarrage réussi : on l'annonce comme en cours
          // tant que la sonde /health ne confirme pas l'état « running ».
          resultEl.textContent = (res.state === 'starting' ? '⏳ ' : '✅ ') + (res.result || 'OK');
        } else {
          resultEl.textContent = '❌ ' + (res.error || 'Erreur');
        }
      }
      // État réel du LLM (le .224 ne se lit pas dans les process) : on re-sonde tout de suite,
      // puis refreshLlm224 se reprogramme toutes les 5 s tant que c'est « en cours de démarrage ».
      if (pc === 'gabriel' && (action === 'start_llm' || action === 'kill_llm')) refreshLlm224();
      // Rafraîchir les métriques du PC concerné ~3-4s après (temps de démarrage + collecte)
      if (action === 'start_llm') {
        setTimeout(function() {
          fetch('/api/pc-' + pc).then(function(r) { return r.json(); }).then(function(d) { renderPc(d, pc); }).catch(function(e) { console.error('pc-' + pc + ':', e); });
        }, 3500);
      }
    })
    .catch(function(err) {
      console.error('pcAction error:', err);
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

  // Format court d'un montant en euros (3 décimales sous 0,10 €)
  function fmtEurShort(v) {
    var n = Number(v) || 0;
    var dec = (n !== 0 && Math.abs(n) < 0.1) ? 3 : 2;
    return n.toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + ' €';
  }

  function updatePlugToggle(name, state, power, eurH, eurMonth) {
    var toggle = document.getElementById('pc-' + name + '-plug-toggle');
    if (!toggle) return;
    var statusEl = document.getElementById('pc-' + name + '-plug-status');
    var powerEl = document.getElementById('pc-' + name + '-plug-power');
    var isOn = state === 'on';
    toggle.className = 'pc-plug-toggle' + (isOn ? ' on' : ' off');
    if (statusEl) statusEl.textContent = isOn ? 'ON' : 'OFF';
    if (powerEl && power !== undefined) {
      if (isOn && power !== null && !isNaN(power)) {
        var txt = ' · ⚡ ' + (power >= 100 ? String(Math.round(power)) : power.toFixed(1).replace('.', ',')) + ' W';
        if (eurH !== null && eurH !== undefined && !isNaN(eurH)) {
          txt += ' · ' + fmtEurShort(eurH) + '/h';
          if (eurMonth !== null && eurMonth !== undefined && !isNaN(eurMonth)) {
            txt += ' · ' + fmtEurShort(eurMonth) + '/mois';
          }
        }
        powerEl.textContent = txt;
        powerEl.title = 'Coût estimé au rythme actuel (prix du kWh en vigueur) : heure et projection sur 30 jours';
      } else {
        powerEl.textContent = '';
      }
    }
  }

  function fetchPlugState(name) {
    fetch('/api/pc-plug-state/' + name)
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.ok) updatePlugToggle(name, res.state, res.power, res.eurH, res.eurMonth);
    })
    .catch(function(err) {
      console.error('fetchPlugState(' + name + '):', err);
    });
  }

function fetchSolaire() {
    fetch('/api/solaire').then(function(r){return r.json();}).then(function(d){renderEnergie(d);}).catch(function(e){console.error('solaire:',e);});
  }

  function renderEnergie(d) {
    var prodW = document.getElementById('energie-prod-w');
    var prodKw = document.getElementById('energie-prod-kw');
    var prodEur = document.getElementById('energie-prod-eur');
    var prodDetail = document.getElementById('energie-prod-detail');
    var gridW = document.getElementById('energie-grid-w');
    var gridKw = document.getElementById('energie-grid-kw');
    var gridEur = document.getElementById('energie-grid-eur');
    var gridDetail = document.getElementById('energie-grid-detail');
    var netEl = document.getElementById('energie-net');
    var badge = document.getElementById('energie-badge');
    var hcEl = document.getElementById('energie-hc');
    var priceEl = document.getElementById('energie-price');
    var timeEl = document.getElementById('energie-time');
    if (!prodW) return;

    function money(v, dec) {
      var n = Number(v) || 0;
      return n.toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + ' €';
    }
    function eur(v) {
      var n = Number(v) || 0;
      return money(n, (n !== 0 && Math.abs(n) < 0.1) ? 3 : 2);
    }
    function cents(v) { return (Number(v) * 100).toFixed(2).replace('.', ',') + ' c€'; }
    function W(v) { return '<span style="font-size:0.7rem;font-weight:400">' + v + '</span>'; }

    if (!d || !d.ok) {
      window._energyData = {};
      prodW.textContent = '—';
      prodKw.textContent = '⛔ Énergie indisponible';
      prodEur.textContent = '';
      prodDetail.textContent = '';
      gridW.innerHTML = '— ' + W('W');
      gridKw.textContent = '⛔ capteur indisponible';
      gridEur.textContent = '';
      gridDetail.textContent = '';
      if (netEl) netEl.textContent = '';
      badge.innerHTML = '';
      if (hcEl) hcEl.textContent = '';
      priceEl.textContent = '';
      if (timeEl) timeEl.textContent = '';
      return;
    }
    window._energyData = d;

    var prod = Math.round(d.prodW || 0);
    var gw = Math.round(d.gridW || 0);
    var priseOk = d.priseOk === true || d.priseOk === 'true';
    var cabOk = d.cabanonOk === true || d.cabanonOk === 'true';

    prodW.innerHTML = prod + ' ' + W('W');
    prodKw.textContent = ((d.prodW || 0) / 1000).toFixed(2).replace('.', ',') + ' kW';
    prodEur.textContent = '💰 ' + eur(d.prodEurH) + ' / h · ≈ ' + eur(d.prodEurMonth) + ' / mois économisés';
    prodEur.title = 'Économie estimée au rythme actuel : par heure puis projection sur 30 jours (720 h)';
    prodDetail.innerHTML = 'Prise ' + (priseOk ? Math.round(d.prodPriseW || 0) + ' W' : 'hors ligne')
      + ' · Cabanon ' + (cabOk ? Math.round(d.prodCabanonW || 0) + ' W' : 'hors ligne')
      + ' · cumul ' + ((d.cumulPriseKWh || 0) + (d.cumulCabanonKWh || 0)).toFixed(1).replace('.', ',') + ' kWh ≈ ' + money(d.cumulProdEur, 2);

    gridW.innerHTML = gw + ' ' + W('W');
    gridW.style.color = gw > 0 ? '#60a5fa' : '#22c55e';
    gridKw.textContent = ((d.gridW || 0) / 1000).toFixed(2).replace('.', ',') + ' kW';
    gridEur.textContent = '💸 ' + eur(d.gridEurH) + ' / h · ≈ ' + eur(d.gridEurMonth) + ' / mois à payer';
    gridEur.title = 'Coût estimé au rythme actuel : par heure puis projection sur 30 jours (720 h), au prix ' + (d.priceLabel || '');
    var splitHc = (d.priceMode === 'hphc')
      ? ' <span style="color:#888">(HC ' + (d.cumulGridHcKWh || 0).toFixed(1).replace('.', ',')
        + ' · HP ' + (d.cumulGridHpKWh || 0).toFixed(1).replace('.', ',') + ' kWh)</span>'
      : '';
    gridDetail.innerHTML = 'cumul ' + (d.cumulGridKWh || 0).toFixed(1).replace('.', ',') + ' kWh ≈ ' + money(d.cumulGridEur, 2)
      + splitHc + (d.cumulGridOk === false ? ' ⚠ partiel' : '');

    var netH = (Number(d.gridEurH) || 0) - (Number(d.prodEurH) || 0);
    var netM = (Number(d.gridEurMonth) || 0) - (Number(d.prodEurMonth) || 0);
    if (netEl) {
      var netTxt = '⚖️ Net 1 h : ' + (netH > 0 ? '+' : '') + eur(netH)
        + ' · 30 j : ' + (netM > 0 ? '+' : '') + eur(netM);
      netEl.innerHTML = netH > 0
        ? netTxt + ' <span style="color:#888">(import ' + eur(d.gridEurH) + ' − production ' + eur(d.prodEurH) + ')</span>'
        : '<span style="color:#22c55e">' + netTxt + ' (production couvre tout)</span>';
    }

    if (d.autonomie) {
      badge.innerHTML = '<span class="tag tag-green">✅ Autonome — aucun import réseau</span>';
    } else if (gw > 0) {
      badge.innerHTML = '';
    } else {
      badge.innerHTML = '';
    }

    var nextTxt = '';
    if (d.priceMode === 'hphc' && d.priceNextInMin !== null && d.priceNextInMin !== undefined && d.priceNextAt) {
      var mn = Number(d.priceNextInMin);
      var dans = mn >= 60 ? Math.floor(mn / 60) + ' h ' + (mn % 60 ? (mn % 60) + ' min' : '') : mn + ' min';
      nextTxt = ' → ' + (d.priceLabel === 'Heures creuses' ? 'HP' : 'HC') + ' dans ' + dans.replace('  ', ' ') + ' (à ' + d.priceNextAt + ')';
    }
    priceEl.textContent = 'Prix : ' + cents(d.priceKwh) + ' / kWh · ' + (d.priceLabel || '—') + nextTxt + ' · cliquer pour modifier';
    if (hcEl) {
      hcEl.textContent = (d.priceMode === 'hphc' && d.hcWindowsLabel)
        ? '🕐 Heures creuses : ' + d.hcWindowsLabel + ' — HC ' + cents(d.prixHc) + ' / HP ' + cents(d.prixHp)
        : '';
    }

    var ts = d.updated_at || '—';
    if (timeEl) timeEl.textContent = (d.stale === true || d.stale === 'true') ? ('⛔ ' + ts) : ts;
  }

  // Édition du prix du kWh (appliqué au tarif en cours : base / HP / HC)
  window.editEnergyPrice = function () {
    var d = window._energyData || {};
    var slot = d.priceSlot || 'prix_base';
    var label = d.priceLabel || 'Base';
    var cur = ((Number(d.priceKwh) || 0) * 100).toFixed(2).replace('.', ',');
    var rep = window.prompt('Prix du kWh en c€ TTC (' + label + ') :', cur);
    if (rep === null) return;
    var n = parseFloat(String(rep).replace(',', '.'));
    if (isNaN(n) || n <= 0 || n > 300) { window.alert('Valeur invalide'); return; }
    var body = { mode: d.priceMode || 'base' };
    body[slot] = n / 100;
    fetch('/api/energy-prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res.ok) { fetchSolaire(); } else { window.alert('Erreur : ' + (res.error || 'inconnue')); }
    }).catch(function (e) { window.alert('Erreur réseau : ' + e.message); });
  };

  initToggles();
  refreshAll();
  // Refresh adaptatif : 10s onglet visible, 60s onglet caché (économie de requêtes)
  var REFRESH_VISIBLE = 10000;
  var REFRESH_HIDDEN = 60000;
  function scheduleRefresh() {
    setTimeout(function() {
      refreshAll();
      scheduleRefresh();
    }, document.hidden ? REFRESH_HIDDEN : REFRESH_VISIBLE);
  }
  scheduleRefresh();
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) refreshAll();
  });
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

<!-- Card drag &amp; drop JS -->
<script>
(function(){
  var grid = document.querySelector(".grid");
  if (!grid) { return; }
  if (grid.querySelector(".card-drag-handle")) { return; }   // anti double-init
  var draggingEl = null;
  var currentTarget = null;
  var currentPos = null;

  // Seuls les enfants porteurs d un data-card-id sont deplacables (jamais les <script> eventuels)
  function gridCards(){
    var out = [];
    var kids = grid.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].getAttribute && kids[i].getAttribute("data-card-id")) { out.push(kids[i]); }
    }
    return out;
  }

  // Ordre VISUEL = tri par la propriete CSS order (la grille reordonne l affichage, pas le DOM)
  function getVisualOrder(){
    return gridCards().sort(function(a, b){
      var oa = parseInt(a.style.order, 10);
      var ob = parseInt(b.style.order, 10);
      if (isNaN(oa)) { oa = 0; }
      if (isNaN(ob)) { ob = 0; }
      return oa - ob;
    });
  }

  function clearDropClasses(){
    var kids = grid.children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].classList.remove("drop-before");
      kids[i].classList.remove("drop-after");
    }
  }

  function findCard(node){
    var t = node;
    while (t && t !== grid) {
      if (t.getAttribute && t.getAttribute("data-card-id")) { return t; }
      t = t.parentNode;
    }
    return null;
  }

  function applyOrder(ids){
    var map = {};
    var kids = gridCards();
    for (var i = 0; i < kids.length; i++) {
      map[kids[i].getAttribute("data-card-id")] = kids[i];
    }
    for (var j = 0; j < ids.length; j++) {
      if (map[ids[j]]) { map[ids[j]].style.order = j; }
    }
  }

  function sendOrder(ids){
    fetch("/api/card-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: ids })
    }).then(function(r){ return r.json(); }).then(function(data){
      if (data && data.ok && data.order) { applyOrder(data.order); }
    }).catch(function(){});
  }

  // Poignee de glissement (la carte entiere n est pas draggable : clics et selection de texte preserves)
  var kids = gridCards();
  for (var i = 0; i < kids.length; i++) {
    (function(card){
      var handle = document.createElement("span");
      handle.className = "card-drag-handle";
      handle.title = "Glisser pour déplacer cette carte";
      card.insertBefore(handle, card.firstChild);

      handle.addEventListener("mousedown", function(){ card.draggable = true; });

      card.addEventListener("dragstart", function(e){
        draggingEl = card;
        card.classList.add("dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", card.getAttribute("data-card-id") || "");
        }
      });

      card.addEventListener("dragend", function(){
        card.draggable = false;
        card.classList.remove("dragging");
        clearDropClasses();
        draggingEl = null;
        currentTarget = null;
        currentPos = null;
      });
    })(kids[i]);
  }

  // Un simple clic sur la poignee (sans drag) ne doit pas laisser la carte draggable
  document.addEventListener("mouseup", function(){
    if (draggingEl) { return; }
    var k = gridCards();
    for (var n = 0; n < k.length; n++) { k[n].draggable = false; }
  });

  grid.addEventListener("dragover", function(e){
    e.preventDefault();
    if (!draggingEl) { return; }
    var target = findCard(e.target);
    if (!target || target === draggingEl) {
      clearDropClasses();
      currentTarget = null;
      currentPos = null;
      return;
    }
    clearDropClasses();
    var rect = target.getBoundingClientRect();
    var isBefore = e.clientX < rect.left + rect.width / 2;
    target.classList.add(isBefore ? "drop-before" : "drop-after");
    currentTarget = target;
    currentPos = isBefore ? "before" : "after";
  });

  grid.addEventListener("dragleave", function(e){
    if (e.target === grid) { clearDropClasses(); }
  });

  grid.addEventListener("drop", function(e){
    e.preventDefault();
    if (!draggingEl || !currentTarget || !currentPos) {
      clearDropClasses();
      return;
    }
    var visual = getVisualOrder();
    var fromIdx = visual.indexOf(draggingEl);
    if (fromIdx === -1) { clearDropClasses(); return; }
    visual.splice(fromIdx, 1);
    var toIdx = visual.indexOf(currentTarget);
    if (toIdx === -1) { clearDropClasses(); return; }
    if (currentPos === "after") { toIdx = toIdx + 1; }
    visual.splice(toIdx, 0, draggingEl);
    var ids = [];
    for (var i = 0; i < visual.length; i++) {
      visual[i].style.order = i;
      ids.push(visual[i].getAttribute("data-card-id"));
    }
    sendOrder(ids);
    clearDropClasses();
  });

  window.resetCardOrder = function(){
    fetch("/api/card-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: [] })
    }).then(function(r){ return r.json(); }).then(function(data){
      if (data && data.ok && data.order) { applyOrder(data.order); }
    }).catch(function(){});
  };
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
      let sshHost, sshUser, sshKey;
      if (pc === 'marie') { sshHost = '192.168.3.57'; sshUser = 'gab'; sshKey = '/root/.ssh/id_ed25519_marie'; }
      else if (pc === 'louis') { sshHost = '192.168.3.206'; sshUser = 'gab'; sshKey = ''; }
      else if (pc === 'gabriel') { sshHost = '192.168.3.224'; sshUser = 'gab'; sshKey = ''; }
      else if (pc === 'boncoin') { sshHost = '192.168.3.249'; sshUser = 'gab'; sshKey = ''; }
      else return res.status(400).json({ ok: false, error: 'PC inconnu' });

      let cmd;
      if (enabled) {
        cmd = `ssh -o StrictHostKeyChecking=no ${sshKey ? '-i ' + sshKey + ' ' : ''}${sshUser}@${sshHost} 'mkdir -p /tmp/${pc}-dashboard && touch /tmp/${pc}-dashboard/auto_kill_enabled'`;
      } else {
        cmd = `ssh -o StrictHostKeyChecking=no ${sshKey ? '-i ' + sshKey + ' ' : ''}${sshUser}@${sshHost} 'rm -f /tmp/${pc}-dashboard/auto_kill_enabled'`;
      }
      execSync(cmd, { timeout: 10000 });
      return res.json({ ok: true, enabled: enabled });
    }
    
    if (action === 'kill_llm') {
      if (pc === 'gabriel') {
        // .224 : deux moteurs possibles, un seul à la fois. stop-strata.sh gère Strata
        // (serve/server.py + engine/strata) ; pkill -x llama-server gère llama.cpp.
        // ⛔ jamais 'pkill -f llama' : les chemins des builds nvcc contiennent 'llama.cpp'.
        const stopCmd = "ssh -o StrictHostKeyChecking=no gab@192.168.3.224 '~/script/stop-strata.sh >/tmp/stop-strata-dashboard.log 2>&1; pkill -x llama-server 2>/dev/null; echo OK'";
        spawnDetached(stopCmd);   // détaché : stop-strata.sh attend la VRAM jusqu'à 60 s
        // Retour HONNÊTE : la commande qui répond OK ne prouve rien. On interroge le port
        // jusqu'à ce qu'il se taise, et on ne dit « Arrêté » que là.
        let last = null;
        for (let i = 0; i < 12; i++) {
          await sleepMs(2000);
          last = await probeLlama224Async(true);
          if (!last || last.health !== true) break;
        }
        clearLlama224Window();
        if (last && last.health === true) {
          return res.json({ ok: false, state: 'running', error: 'Le port 8080 repond encore sur 192.168.3.224 (modele ' + (last.model || 'inconnu') + ') — arret NON confirme.' });
        }
        return res.json({ ok: true, state: 'stopped', result: 'LLM arrete — 192.168.3.224:8080 ne repond plus' });
      }
      let cmd;
      if (pc === 'marie') {
        cmd = "ssh -o StrictHostKeyChecking=no -i /root/.ssh/id_ed25519_marie gab@192.168.3.57 'pkill llama-server 2>/dev/null; echo OK'";
      } else if (pc === 'louis') {
        cmd = "ssh -o StrictHostKeyChecking=no gab@192.168.3.206 'pkill llama-server 2>/dev/null; echo OK'";
      } else if (pc === 'boncoin') {
        cmd = "ssh -o StrictHostKeyChecking=no gab@192.168.3.249 'pkill llama-server 2>/dev/null; echo OK'";
      } else {
        cmd = "ssh -o StrictHostKeyChecking=no gab@192.168.3.224 'pkill llama-server 2>/dev/null; echo OK'";
      }
      const result = execSync(cmd, { timeout: 10000 }).toString().trim();
      return res.json({ ok: true, result: result });
    }
    
    if (action === 'start_llm') {
      if (pc === 'gabriel') {
        // Strata met 66-120 s à charger. L'ancien code attendait 23 s puis testait
        // `pgrep llama-server` : avec Strata (Python + engine/strata) c'était un faux
        // négatif systématique (« Le LLM n'a pas demarre » alors qu'il chargeait).
        // Ici : fenêtre de démarrage ouverte, lancement détaché, réponse immédiate.
        startLlama224Window(180000);
        const launchCmd = "ssh -o StrictHostKeyChecking=no gab@192.168.3.224 'nohup ~/script/start-default-llm.sh >/tmp/start-default-llm-dashboard.log 2>&1 & echo OK'";
        try {
          spawnDetached(launchCmd);
        } catch (e) {
          clearLlama224Window();
          return res.json({ ok: false, error: 'Lancement impossible : ' + e.message });
        }
        return res.json({ ok: true, state: 'starting', result: 'Demarrage lance (Strata, 66-120 s) — l etat se rafraichit tout seul' });
      }
      let sshPrefix;
      // Script dans ~/script/ — nohup pour détacher du shell SSH (sinon tué à la fermeture)
      if (pc === 'marie') {
        sshPrefix = "ssh -o StrictHostKeyChecking=no -i /root/.ssh/id_ed25519_marie gab@192.168.3.57";
      } else if (pc === 'louis') {
        sshPrefix = "ssh -o StrictHostKeyChecking=no gab@192.168.3.206";
      } else if (pc === 'gabriel') {
        sshPrefix = "ssh -o StrictHostKeyChecking=no gab@192.168.3.224";
      } else if (pc === 'boncoin') {
        sshPrefix = "ssh -o StrictHostKeyChecking=no gab@192.168.3.249";
      } else {
        return res.status(400).json({ ok: false, error: 'PC inconnu' });
      }
      // Lancement réel (nohup + sortie masquée, code retour non fiable) — on vérifie ensuite
      const launchCmd = sshPrefix + " 'nohup ~/script/start-default-llm.sh >/dev/null 2>&1 & echo OK'";
      execSync(launchCmd, { timeout: 20000 });
      // Laisser ~3s au LLM pour démarrer, puis vérifier que le serveur tourne réellement sur la cible
      execSync('sleep 3', { timeout: 10000 });
      const checkCmd = sshPrefix + " 'pgrep llama-server >/dev/null 2>&1 && echo RUNNING || echo STOPPED'";
      const checkOut = execSync(checkCmd, { timeout: 20000 }).toString().trim();
      if (checkOut.indexOf('RUNNING') !== -1) {
        return res.json({ ok: true, result: 'Demarre' });
      }
      // La commande a répondu OK mais rien ne tourne : erreur honnête au lieu d'un faux succès
      return res.json({ ok: false, error: "Le LLM n'a pas demarre sur " + pc + ". Verifier le GPU ou le script distant (~/script/start-default-llm.sh)." });
    }

    if (action === 'shutdown') {
      let cmd;
      if (pc === 'louis') {
        cmd = "ssh -o StrictHostKeyChecking=no gab@192.168.3.206 'sudo poweroff; echo OK'";
      } else if (pc === 'marie') {
        cmd = "ssh -o StrictHostKeyChecking=no -i /root/.ssh/id_ed25519_marie gab@192.168.3.57 'sudo shutdown -h now; echo OK'";
      } else if (pc === 'gabriel') {
        cmd = "ssh -o StrictHostKeyChecking=no gab@192.168.3.224 'sudo shutdown -h now; echo OK'";
      } else if (pc === 'boncoin') {
        cmd = "ssh -o StrictHostKeyChecking=no gab@192.168.3.249 'sudo -n shutdown -h now; echo OK'";
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
