require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const axios   = require('axios');
const os      = require('os');
const fs      = require('fs');
const { execSync } = require('child_process');
const path    = require('path');

// ─── Logique pure (lib/) — l'I/O (fs, axios, execSync) reste ici ─────────
const { wmo } = require('./lib/render');
const { calcSpending: calcSpendingFrom, calcSpendingLast24h: calcSpendingLast24hFrom,
        calcSpendingLast7d: calcSpendingLast7dFrom, parseMeminfo: parseMeminfoFrom, formatUptime } = require('./lib/usage');
const { POUR_IA_AGENTS, normalizePourIAAgent, pourIAEstimateFromDoc,
        buildPourIACardBody: buildPourIACardBodyFrom } = require('./lib/pour-ia');
const { computePcTaskHistory } = require('./lib/pc');
const { parseParisNaive, hhmmNaive,
        hcWindows: hcWindowsFrom, hcWindowsLabel: hcWindowsLabelFrom } = require('./lib/dates');
const { currentEnergyPrice: currentEnergyPriceFrom, parseSolarValue } = require('./lib/energy');
const { renderPage } = require('./lib/page');
const { getPlugEntity, getPlugPowerEntity, smoothedPower } = require('./lib/plugs');
const { occSlotsStats } = require('./lib/occ');


const app  = express();
app.use(express.json());
// ── Alias /dashboard → / (URL Tailscale parlante, 18/11/2026) ──────────
// https://u2404server.tail780269.ts.net/dashboard = ce même dashboard.
// Rewrite TOP-LEVEL (pas de mount) : Express 5 restaure req.url après
// next() dans un middleware monté, le rewrite doit être sans chemin.
// /dashboard → /, /dashboard/x → /x. Routes existantes intactes.
app.use((req, res, next) => {
  if (req.url.startsWith('/dashboard')) {
    req.url = req.url.replace(/^\/dashboard(?=\/|$)/, '') || '/';
  }
  next();
});
// SortableJS servi en local (pas de dep CDN : le dashboard tourne en LAN)
app.get('/sortable.min.js', (req, res) => res.sendFile(path.join(__dirname, 'sortable.min.js')));
const PORT = parseInt(process.env.PORT, 10) || 3015;
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
const WATCHDOG_MAP = { louis: 'louis', marie: 'marie', boncoin: 'skillorp', gabriel: 'gabriel' };
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
function calcSpending() { return calcSpendingFrom(loadHistory(), Date.now()); }

// ─── Spending calculation (last 24 hours) ────────────────────────────────
function calcSpendingLast24h() { return calcSpendingLast24hFrom(loadHistory(), Date.now()); }

// ─── Spending calculation (last 7 days) ──────────────────────────────────
// Logique pure dans lib/usage.js ; le wrapper fournit l'historique (I/O).
function calcSpendingLast7d() { return calcSpendingLast7dFrom(loadHistory(), Date.now()); }

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
// I/O : lecture /proc/meminfo ; parsing pur dans lib/usage.js (parseMeminfo).
function parseMeminfo() { return parseMeminfoFrom(fs.readFileSync('/proc/meminfo', 'utf8'), GB); }

// ─── System ────────────────────────────────────────────────────────────────
function getSystem() {
  const mem    = parseMeminfo();
  const load1  = os.loadavg()[0];
  const cpuPct = Math.min(100, (load1 / CPU_COUNT) * 100).toFixed(1);
  return { cpuPct, load1: load1.toFixed(2), cpuCount: CPU_COUNT, mem, uptime: formatUptime(os.uptime()) };
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


// ─── Card Visibility ────────────────────────────────────────
const VISIBILITY_FILE = path.join(DATA_DIR, 'card_visibility.json');

const DEFAULT_VISIBILITY = {
  'meteo': true, 'liens': true,
  'credits': true, 'depenses': true,
  'systeme': true, 'ollama': true,
  'pc-gabriel': true, 'pc-louis': true, 'pc-marie': true, 'pc-boncoin': true, 'chart': true,
  'energie': true, 'pour-ia': true, 'pc-history': true
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
  'energie', 'pour-ia', 'pc-history', 'meteo', 'liens', 'credits', 'depenses',
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

// ─── Météo Valenciennes (Open-Meteo, sans clé) ────────────────────────────
// Prévisions 3 jours (aujourd'hui / demain / après-demain). Cache 15 min en mémoire
// pour ne pas marteler l'API à chaque refresh de page (meta refresh 30 s).
const WEATHER_CACHE = { ts: 0, data: null };
const WEATHER_TTL_MS = 15 * 60 * 1000;

// Codes météo WMO → icône + libellé (soleil / pluie en priorité)

async function getWeather() {
  if (WEATHER_CACHE.data && (Date.now() - WEATHER_CACHE.ts) < WEATHER_TTL_MS) return WEATHER_CACHE.data;
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=50.3597&longitude=3.5271'
      + '&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max'
      + '&timezone=Europe%2FParis&forecast_days=3&wind_speed_unit=kn';
    const r = await axios.get(url, { timeout: 8000 });
    const d = r.data;
    const days = (d.daily && d.daily.time ? d.daily.time : []).map(function(t, i) {
      const code = d.daily.weathercode[i];
      const w = wmo(code);
      return {
        date: t,
        icon: w[0],
        label: w[1],
        tmin: d.daily.temperature_2m_min[i],
        tmax: d.daily.temperature_2m_max[i],
        rainPct: (d.daily.precipitation_probability_max && d.daily.precipitation_probability_max[i] != null) ? d.daily.precipitation_probability_max[i] : null,
        windKts: (d.daily.wind_speed_10m_max && d.daily.wind_speed_10m_max[i] != null) ? d.daily.wind_speed_10m_max[i] : null,
        gustKts: (d.daily.wind_gusts_10m_max && d.daily.wind_gusts_10m_max[i] != null) ? d.daily.wind_gusts_10m_max[i] : null
      };
    });
    WEATHER_CACHE.data = { ok: true, days: days, fetchedAt: new Date().toISOString() };
    return WEATHER_CACHE.data;
  } catch (e) {
    // API KO : on renvoie le cache même périmé (stale) plutôt que de casser la carte
    if (WEATHER_CACHE.data) return WEATHER_CACHE.data;
    return { ok: false, days: [], error: e.message };
  }
}

// ─── Liens (carte cliquable) ───────────────────────────────────────────────
const LINKS_FILE = path.join(DATA_DIR, 'links.json');
const DEFAULT_LINKS = [
  { id: 'gtd', label: 'GTD', url: 'https://gtd3.duckdns.org' }
];
function loadLinks() {
  try {
    if (fs.existsSync(LINKS_FILE)) {
      const data = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
      return Array.isArray(data) && data.length ? data : DEFAULT_LINKS.slice();
    }
  } catch (e) { console.error('[links] erreur lecture:', e.message); }
  // Premier démarrage : on persiste le lien GTD par défaut
  try { ensureDataDir(); fs.writeFileSync(LINKS_FILE, JSON.stringify(DEFAULT_LINKS, null, 2)); } catch (e) {}
  return DEFAULT_LINKS.slice();
}
function saveLinks(links) {
  ensureDataDir();
  fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
}

// ─── GTD Pour IA (file écrite par le cron pour-ia-dispatch, profil ron) ───
const POUR_IA_FILE = process.env.POUR_IA_FILE || path.join(DATA_DIR, 'pour-ia.json');
const POUR_IA_LOCK_DIR = '/host/home/lydstyl/.hermes/state/pour-ia';

// Normalise une entrée `agents[]` du JSON (champs tous optionnels → jamais de crash)

// Le `pid` d'une lock est le PID du wrapper SUR L'HÔTE (192.168.3.102), pas un
// PID du conteneur → `os.kill(pid, 0)` ici testerait le namespace du conteneur
// (faux). On vérifie donc la vie via la vue en lecture seule /host/proc/<pid>.
// C'est le même critère que `lock_alive()` dans pour-ia-dispatch.py, appliqué
// en temps réel côté dashboard (le cron 15 min ne nettoie que par paquets).
function hostPidAlive(pid) {
  const n = Number(pid);
  if (!n || !Number.isFinite(n)) return false;
  try { return fs.existsSync('/host/proc/' + n); } catch (e) { return false; }
}

// Host LLM de chaque agent (même mapping que pour-ia-dispatch.py AGENTS). Un agent
// n'est "en cours" que si son LLM répond — sinon c'est un fantôme (machine redémarrée,
// wrapper collé mais LLM KO). Complément du check hostPidAlive() ci-dessus.
const POUR_IA_AGENT_HOSTS = { luna: '192.168.3.57', harry: '192.168.3.224', ron: '192.168.3.206', dobby: '192.168.3.249', dsh: '192.168.3.57' };
const POUR_IA_LLM_TTL_MS = 10000; // 10 s — fraîcheur du statut LLM, sans marteler les nœuds
const pourIALlmCache = {};        // { <agent>: { up: bool, ts: number } }

function refreshAgentLlmUp(agent) {
  const host = POUR_IA_AGENT_HOSTS[agent];
  if (!host) return true; // agent inconnu → on ne bloque pas l'affichage
  const now = Date.now();
  const c = pourIALlmCache[agent];
  if (c && (now - c.ts) < POUR_IA_LLM_TTL_MS) return c.up !== false;
  const last = (c && typeof c.up === 'boolean') ? c.up : false; // défaut false : pas "en cours" tant que le LLM n'a pas répondu (anti-fantôme, y.c. cold start)
  pourIALlmCache[agent] = { up: last, ts: now }; // "sonde en cours" → throttle les re-sondes
  httpGetJson(host, 8080, '/v1/models', 2500, (err) => {
    pourIALlmCache[agent] = { up: !err, ts: Date.now() };
  });
  return last;
}

function loadPourIA() {
  const out = { count: 0, tasks: [], updated_at: null, working: [], paused: [], cooldown: [], pending: 0, agents: null, agents_from_json: false };
  try {
    if (fs.existsSync(POUR_IA_FILE)) {
      const d = JSON.parse(fs.readFileSync(POUR_IA_FILE, 'utf8'));
      out.count = d.count || 0;
      out.tasks = Array.isArray(d.tasks) ? d.tasks : [];
      out.updated_at = d.updated_at || null;
      // Nouveau contrat (13/11/2026) : `agents` peut être absent → repli sur les locks.
      if (Array.isArray(d.agents) && d.agents.length) {
        out.agents = d.agents.map(normalizePourIAAgent).filter(Boolean);
        out.agents_from_json = out.agents.length > 0;
      }
    }
  } catch (e) { console.error('[pour-ia] erreur lecture file:', e.message); }
  // locks actives = agents locaux en train de traiter (1 par agent, dispatch parallèle)
  try {
    if (fs.existsSync(POUR_IA_LOCK_DIR)) {
      for (const f of fs.readdirSync(POUR_IA_LOCK_DIR)) {
        if (f.endsWith('.paused')) {
          out.paused.push(f.replace('.paused', '').toUpperCase());
          continue;
        }
        if (f.endsWith('.cooldown')) {
          // Cooldown post-échec (15 min, posé par le wrapper / clear_stale_locks) :
          // le dispatch exclut l'agent mais la carte le montrait « 🟢 dispo » →
          // Gabriel ne comprenait pas pourquoi Dispatch n'attribuait rien (12/11/2026).
          try {
            const age = Date.now() - fs.statSync(path.join(POUR_IA_LOCK_DIR, f)).mtimeMs;
            const LEFT = 15 * 60 * 1000;
            if (age < LEFT) {
              out.cooldown.push({ agent: f.replace('.cooldown', '').toUpperCase(), remaining_min: Math.max(1, Math.ceil((LEFT - age) / 60000)) });
            }
          } catch (e) { /* cooldown illisible : on l'ignore */ }
          continue;
        }
        if (!f.endsWith('.lock')) continue;
        try {
          const l = JSON.parse(fs.readFileSync(path.join(POUR_IA_LOCK_DIR, f), 'utf8'));
          // BUG FIX (GTD cmwdty49t002klq01ftwn4abt) : un fichier .lock ≠ agent vivant.
          // Si le wrapper (pid hôte) est mort — redémarrage, crash, SIGKILL — la lock
          // est orpheline et le trap du wrapper n'a pas pu la supprimer. Sans ce check,
          // la carte afficherait « HARRY sur : … » alors que Harry est éteint. On ne la
          // montre PAS comme « en cours » et on la supprime (overlay rw), comme le fait
          // clear_stale_locks() côté dispatch, mais en temps réel.
          if (!hostPidAlive(l.pid)) {
            try { fs.unlinkSync(path.join(POUR_IA_LOCK_DIR, f)); console.error('[pour-ia] lock orpheline supprimée : ' + f); } catch (e) {}
            continue;
          }
          // Wrapper vivant MAIS LLM éteint (machine redémarrée, hermes collé en attente) :
          // on ne montre PAS "sur : <tâche>" tant que le LLM ne répond pas de nouveau.
          if (!refreshAgentLlmUp(f.replace('.lock', ''))) continue;
          out.working.push({ agent: f.replace('.lock', '').toUpperCase(), task_id: l.task_id || null, task_name: l.task_name || '?', started_at: l.started_at || null });
        } catch (e) { /* lock illisible : on l'ignore */ }
      }
    }
  } catch (e) { console.error('[pour-ia] erreur lecture locks:', e.message); }
  // ─── Bloc agents (nouveau contrat) ────────────────────────────────────
  // Les locks restent la vérité TEMPS RÉEL pour les agents locaux (le JSON est
  // réécrit au tick du cron) : pause/en cours écrasent le statut du fichier.
  // Les agents API (hermione) n'ont ni lock ni flag → statut du JSON seul.
  if (out.agents) {
    const seen = {};
    out.agents.forEach(function(a) { seen[a.key] = true; });
    POUR_IA_AGENTS.forEach(function(k) { // agents locaux absents du JSON → ajoutés (boutons pause conservés)
      if (seen[k]) return;
      out.agents.push({ key: k, disp: POUR_IA_DISP[k] || k.toUpperCase(), status: 'idle', task: '', api: false, from_json: false });
    });
    out.agents.forEach(function(a) {
      const A = a.key.toUpperCase();
      const w = out.working.find(function(x) { return x.agent === A; });
      const isPaused = out.paused.indexOf(A) !== -1;
      if (isPaused) a.status = 'paused';
      else if (w) { a.status = 'running'; if (!a.task) a.task = w.task_name || ''; }
      const cd = (out.cooldown || []).find(function(c) { return c.agent === A; });
      if (cd && a.status !== 'running' && a.status !== 'paused' && !a.api) {
        a.status = 'cooldown';
        a.cooldown_min = cd.remaining_min;
      }
    });
  }
  // les tâches en cours sont dans le json (statut encore pour_ia) → on les sort de la file affichée
  const busy = new Set(out.working.map(function(w) { return w.task_id; }).filter(Boolean));
  out.tasks = out.tasks.filter(function(t) { return !busy.has(t.id); });
  out.pending = Math.max(0, out.count - busy.size);
  return out;
}

// ─── ETA file Pour IA — médiane des 100 dernières tâches du PC Marie (luna) ───
// Base de l'estimation : pc-task-history.json (collect-pc-task-history.py, cron).
// Les 100 events luna les plus récents avec dur_s valide → médiane en minutes.
// L'estimation affichée = pending × médiane (1 agent dispo, traitement séquentiel).
// I/O : lecture pc-task-history.json ; médiane pure dans lib/pour-ia.js (pourIAEstimateFromDoc).
function pourIAEstimate() {
  try {
    return pourIAEstimateFromDoc(JSON.parse(fs.readFileSync(PC_TASK_HISTORY_FILE, 'utf8')));
  } catch (e) {
    return null; // fichier absent/illisible → pas de ligne ETA, pas de crash
  }
}

// Échappement HTML côté serveur (le `esc` existant est scopé dans le handler `/`)

// ─── Brique « GTD Pour IA » : badges cible / mode et lignes agents ─────
// Le JSON porte `target` + `mode` (contrat 13/11/2026) ; si l'un manque, on le
// déduit des `tags` (agent-<clé>, mode-plan, mode-rapide) — jamais de crash.
// Une ligne par agent : pastille d'état + nom + tâche en cours + bouton pause.
// Les agents API (hermione) n'ont pas de wrapper local → pas de bouton pause.

// HTML du corps de la carte « GTD — Tâches Pour IA » (rendu serveur).
// Reutilisé par les endpoints pause / dispatch-now pour renvoyer la carte
// re-rendue au client → mise à jour instantanée, sans rechargement de page.
// Logique pure dans lib/pour-ia.js ; le wrapper ajoute l'ETA (I/O via pourIAEstimate).
function buildPourIACardBody(pourIA) {
  return buildPourIACardBodyFrom(pourIA, pourIAEstimate());
}

// API: mettre un agent GTD en pause / le reprendre (flag <agent>.paused à côté
// des .lock — pour-ia-dispatch.py exclut les agents pausés au tick suivant).
// Une tâche EN COURS n'est jamais tuée : la pause prend effet à la tâche suivante.
app.post('/api/pour-ia/pause', (req, res) => {
  const agent = String((req.body && req.body.agent) || '').toLowerCase();
  const paused = !!(req.body && req.body.paused);
  if (!POUR_IA_AGENTS.includes(agent)) {
    return res.status(400).json({ ok: false, error: 'agent inconnu (' + POUR_IA_AGENTS.join('/') + ')' });
  }
  const flag = path.join(POUR_IA_LOCK_DIR, agent + '.paused');
  try {
    if (paused) fs.writeFileSync(flag, new Date().toISOString());
    else if (fs.existsSync(flag)) fs.unlinkSync(flag);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
  res.json({ ok: true, agent, paused, card_html: buildPourIACardBody(loadPourIA()) });
});

// API: lancer IMMÉDIATEMENT un tick de dispatch GTD « Pour IA » (même commande
// que le cron Hermes 15 min du profil ron) — pas besoin d'attendre le tick.
// Le conteneur ne peut pas exécuter le script hôte (pas d'accès /home/lydstyl,
// .hermes en 0700) → SSH vers le serveur lui-même (192.168.3.102) avec la clé
// id_ed25519_marie (déjà montée dans le conteneur, sans passphrase).
app.post('/api/pour-ia/dispatch-now', (req, res) => {
  const ssh = 'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=yes -i /root/.ssh/id_ed25519_marie lydstyl@192.168.3.102';
  try {
    const out = execSync(ssh + " 'python3 /home/lydstyl/.hermes/profiles/ron/scripts/pour-ia-dispatch.py'", { timeout: 90000 }).toString().trim();
    res.json({ ok: true, output: out, card_html: buildPourIACardBody(loadPourIA()) });
  } catch (e) {
    const out = [e.stdout, e.stderr].filter(Boolean).map(String).join(' ').trim() || String(e.message);
    res.status(500).json({ ok: false, error: out.slice(0, 600) });
  }
});

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

// ─── Historique tâches par PC (stats 30 j) ─────────────────────────────────
// API: stats 30 jours par PC — modèle pc-task-history/v1 (tâche [1/4], Luna).
// Source : /host/home/lydstyl/.hermes/state/pour-ia/pc-task-history.json (mount
// rw du conteneur). Les stats 30 j sont RECALCULÉES à chaque appel depuis les
// events (fenêtre fraîche « maintenant − 30 j »), indépendamment du moment où le
// collecteur (collect-pc-task-history.py) a dernier tourné. Formules identiques
// au collecteur : travail = Σ dur_s des events dans la fenêtre, énergie =
// power_w.working × durée de travail, coût = kWh × prix.
const PC_TASK_HISTORY_FILE = '/host/home/lydstyl/.hermes/state/pour-ia/pc-task-history.json';

// Calcule les stats 30 j par PC depuis le modèle (fenêtre « maintenant − 30 j »
// recalculée à CHAQUE appel, indépendant du dernier run du collecteur).
// Utilisé par l'endpoint /api/pc-task-history ET la carte « Historique tâches par PC ».
// I/O : lecture pc-task-history.json ; stats 30 j pures dans lib/pc.js (computePcTaskHistory).
function loadPcTaskHistory() {
  return computePcTaskHistory(JSON.parse(fs.readFileSync(PC_TASK_HISTORY_FILE, 'utf8')), new Date());
}

app.get('/api/pc-task-history', (req, res) => {
  try {
    const h = loadPcTaskHistory();
    if (req.query.events === '0') {
      for (const pc of Object.values(h.pcs)) delete pc.events_30d;
    }
    res.json({ ok: true, ...h });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// HTML du corps de la carte « Historique tâches par PC (30 j) » (rendu serveur,
// tâche [4/4]). Un bloc par PC avec les 6 métriques demandées : dernière tâche
// (date + nom), nb tâches 30 j, durée travail 30 j, durée sans travail 30 j,
// coût élec 30 j (kWh + €). Grid 3×2 lisible au téléphone.

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


// "2026-10-27T13:23:00" -> "13:23" (les chiffres de la chaine, independamment du fuseau)

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

  // ETA = max(idle_since + IDLE_MIN, extend_until), arrondi au prochain tick
  // de 15 min du cron. extend_until = prolongation manuelle (bouton « +30 min »,
  // voir POST /api/pc-:name/extend) ; le watchdog la respecte avant d'éteindre.
  let baseMs = startMs + WATCHDOG_IDLE_MIN * 60000;
  if (pc.extend_until) {
    const extMs = parseParisNaive(pc.extend_until);
    if (extMs !== null && extMs > baseMs) baseMs = extMs;
  }
  const eta = new Date(baseMs);
  const m = eta.getMinutes();
  let add = (WATCHDOG_TICK_MIN - (m % WATCHDOG_TICK_MIN)) % WATCHDOG_TICK_MIN;
  if (add === 0 && eta.getSeconds() !== 0) add = WATCHDOG_TICK_MIN;
  if (add > 0) eta.setMinutes(m + add, 0, 0); else eta.setSeconds(0, 0);
  return { blocked: false, cronAt: null, shutdownAtMs: eta.getTime(), idleMin: idleMin };
}

// Worker DSH : PC dont le LLM est réservé par une session dsh en cours
// (flag dsh_reserved écrit par pc-idle-watchdog.py, même fichier d'état).
function getDshReserved(name) {
  const key = WATCHDOG_MAP[name];
  if (!key) return false;
  const st = loadWatchdogState();
  return !!(st && st[key] && st[key].dsh_reserved);
}

// Interrupteur on/off de l'extinction auto (toggle sur la carte PC du dashboard).
// Flag auto_off_disabled ecrit dans state.json par POST /api/pc-:name/auto-off ;
// le watchdog le verifie avant d'eteindre. null = PC non gere / etat indisponible
// (le front cache alors le toggle).
function getAutoOffDisabled(name) {
  const key = WATCHDOG_MAP[name];
  if (!key) return null;
  const st = loadWatchdogState();
  if (!st) return null;
  return !!(st[key] && st[key].auto_off_disabled === true);
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
    dsh_reserved: getDshReserved(name),
    auto_off_disabled: getAutoOffDisabled(name),
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

// API: prolonger le compte à rebours d'extinction d'un PC de 30 min.
// Semantique (corrige 21/11/2026) : repousser l'ETA ACTUEL de +30 min via
// extend_until, PAS reset idle_since. Un reset idle_since ne changeait rien
// quand le PC venait de passer inactif : l'ETA est arrondi au prochain tick
// 15 min du cron et cet arrondi dominait -> bouton « +30 min » sans effet
// visible (compte a rebours fige a ~44 min). Le watchdog (tick 15 min)
// respecte extend_until et la clearing a la reprise d'activite.
// Ecriture atomique (tmp+rename) pour ne pas casser l'etat que le watchdog lit.
app.post('/api/pc-:name/extend', (req, res) => {
  const name = req.params.name;
  const key = WATCHDOG_MAP[name];
  if (!key) return res.status(400).json({ ok: false, error: 'PC non gere par le watchdog' });
  // Lecture FRAICHE (pas le cache 60 s) : reecrire un etat cache ecraserait
  // le dernier tick du watchdog.
  let st;
  try { st = JSON.parse(fs.readFileSync(WATCHDOG_STATE, 'utf8')); }
  catch (e) { return res.status(500).json({ ok: false, error: 'state.json illisible' }); }
  const pc = st[key];
  if (!pc || !pc.idle_since || pc.off_since)
    return res.status(409).json({ ok: false, error: 'Pas de compte a rebours actif sur ce PC' });
  const startMs = parseParisNaive(pc.idle_since);
  if (startMs === null) return res.status(500).json({ ok: false, error: 'idle_since illisible' });
  // ETA de base = max(idle_since + 30 min, extend_until existant) — meme formule
  // que getAutoShutdown, avant arrondi au tick.
  let baseMs = startMs + WATCHDOG_IDLE_MIN * 60000;
  if (pc.extend_until) {
    const extMs = parseParisNaive(pc.extend_until);
    if (extMs !== null && extMs > baseMs) baseMs = extMs;
  }
  const newUntil = new Date(baseMs + 30 * 60000);
  // Le watchdog ecrit des heures LOCALES de Paris SANS fuseau (datetime.now()).
  // On ecrit le meme format : un Z (UTC) ferait crasher le watchdog au tick
  // suivant (fromisoformat -> aware, soustraction naive - aware -> TypeError),
  // ce qui tue l'extinction auto du PC.
  pc.extend_until = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(newUntil).replace(/,\s*/, 'T');
  st[key] = pc;
  try {
    const tmp = WATCHDOG_STATE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
    fs.renameSync(tmp, WATCHDOG_STATE);
    // Invalide le cache 60 s : sans ca, le GET suivant renvoie l'ancien etat
    // et le compte a rebours ne bouge pas -> le bouton parait mort.
    _wdState = null; _wdStateTs = 0;
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
  res.json({ ok: true, key, extend_until: pc.extend_until });
});

// Interrupteur on/off de l'extinction auto d'un PC (toggle sur la carte).
// enabled=true -> auto_off_disabled efface (le watchdog peut eteindre) ;
// enabled=false -> desactive l'extinction auto (le PC reste allume indefiniment).
// Ecrit dans state.json (tmp+rename, comme /extend). Le flag survit aux ticks du
// watchdog : il ne reecrit que ses propres cles. Le flag est volontairement
// persistant (pas de re-activation automatique au redemarrage du PC).
app.post('/api/pc-:name/auto-off', (req, res) => {
  const name = req.params.name;
  const key = WATCHDOG_MAP[name];
  if (!key) return res.status(400).json({ ok: false, error: 'PC non gere par le watchdog' });
  const enabled = !!(req.body && req.body.enabled === true);
  let st;
  try { st = JSON.parse(fs.readFileSync(WATCHDOG_STATE, 'utf8')); }
  catch (e) { return res.status(500).json({ ok: false, error: 'state.json illisible' }); }
  const pc = st[key] || {};
  pc.auto_off_disabled = !enabled;
  if (enabled) pc.auto_off_logged = null;
  st[key] = pc;
  try {
    const tmp = WATCHDOG_STATE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
    fs.renameSync(tmp, WATCHDOG_STATE);
    _wdState = null; _wdStateTs = 0;
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
  res.json({ ok: true, key, auto_off_disabled: !enabled });
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

// ─── Contrat d'occupation UNIQUE : GET /api/llm-occupancy ───────────────────
// Un seul contrat, trois consommateurs : le JS de cette page, le plugin cbar
// (plugin/llm-status.5s.sh) et le tray Windows (windows/llm-tray.ps1).
//
// Deux règles de conception, chacune payée par un bug réel :
//  1. Les sondes d'une machine partent EN PARALLÈLE (2 s max chacune). En séquence
//     (/health -> /v1/models -> /slots -> /status) une génération lente dépassait 11 s :
//     le badge n'avait jamais le temps d'apparaître avant le cycle de refresh suivant.
//  2. busy = OR(/slots[].is_processing, /status.busy). Strata annonce busy avant que le
//     slot ne soit marqué en traitement : /slots seul fait donc disparaître la tâche en
//     cours au moment exact où elle commence.
const OCC_NODES = [
  { id: 'gabriel', letter: 'G', label: 'Gabriel .224', host: LLM224_HOST, port: LLM224_PORT, engine: 'strata' },
  { id: 'marie', letter: 'M', label: 'Marie .57', host: '192.168.3.57', port: 8080, engine: 'llama' },
  { id: 'louis', letter: 'L', label: 'Louis .206', host: '192.168.3.206', port: 8080, engine: 'llama' },
  { id: 'boncoin', letter: 'S', label: 'SkillORP .249', host: '192.168.3.249', port: 8080, engine: 'llama' },
];
const OCC_CACHE_MS = 1000;      // cache court : page 3 s + plugin 5 s + tray 5 s = 1 sonde/s max
const OCC_TIMEOUT_MS = 2000;    // par appel, jamais bloquant
const OCC = { cache: null, cacheTs: 0, inflight: null, models: {}, modelsTs: {}, prompts: {} };

function occJson(host, port, urlPath) {
  return new Promise((resolve) => {
    httpGetJson(host, port, urlPath, OCC_TIMEOUT_MS, (err, data) => {
      resolve({ ok: !err, data: err ? null : data, error: err ? err.message : null });
    });
  });
}

// /slots[].n_prompt_tokens = le DERNIER prompt traité (ni moyenne ni historique), n_ctx = le
// contexte DU SLOT (llama.cpp avec -np 2 renvoie le contexte par slot, pas le total).
// occSlotsStats → lib/occ.js (extrait monolithe, [1/3] Archi 25/11)

// ≈ Compactions : un serveur LLM ne voit que des requêtes HTTP, une compaction est un
// événement du HARNAIS (réécriture de l'historique). Suivi PAR SLOT : une chute de plus de
// 40 % du prompt d'UN slot, depuis un contexte gros (> 16 k tokens), = compaction probable.
// Un slot libéré (n_prompt_tokens 0) remet le suivi à zéro : une nouvelle session sur un
// slot vide ne compte plus comme compaction (faux positif historique du badge — 12/11/2026).
function occTrackSlots(nodeId, perSlot, ts, slotsValid) {
  const agg = { compactions: 0, lastDropTs: null, changedAt: null, prev: null };
  const seenIds = new Set();
  (perSlot || []).forEach((s) => {
    const key = nodeId + ':' + s.id;
    seenIds.add(key);
    const st = OCC.prompts[key] || (OCC.prompts[key] = { seen: null, changedAt: null, prev: null, compactions: 0, lastDropTs: null });
    if (s.p > 0 && st.seen !== s.p) {
      if (typeof st.seen === 'number' && st.seen > 16384 && s.p < st.seen * 0.6) {
        st.compactions += 1;
        st.lastDropTs = ts;
      }
      st.prev = st.seen;
      st.seen = s.p;
      st.changedAt = ts;
    }
    agg.compactions += st.compactions;
    if (st.lastDropTs && (!agg.lastDropTs || st.lastDropTs > agg.lastDropTs)) agg.lastDropTs = st.lastDropTs;
    if (st.changedAt && (!agg.changedAt || st.changedAt > agg.changedAt)) agg.changedAt = st.changedAt;
    if (typeof st.prev === 'number' && (agg.prev === null || st.prev > agg.prev)) agg.prev = st.prev;
  });
  // Slot libéré (absent de la liste active) → suivi remis à zéro : la prochaine session
  // ne doit pas hériter de l'ancien prompt. Sauf si /slots a échoué (pas de reset à l'aveugle).
  if (slotsValid !== false) {
    Object.keys(OCC.prompts).forEach((key) => {
      if (key.startsWith(nodeId + ':') && !seenIds.has(key)) {
        const st = OCC.prompts[key];
        st.seen = null; st.prev = null; st.changedAt = null;
      }
    });
  }
  return agg;
}

// La carte PC (collecteur SSH/Windows) répond-elle encore ? Elle distingue « serveur arrêté »
// (machine joignable, LLM éteint) de « hors ligne » (machine muette).
function occCardFresh(name) {
  const d = pcCache[name];
  if (!d) return false;
  const ts = pcCacheTs[name] || 0;
  return pcCache[name + 'Ok'] === true && ts > 0 && (Date.now() - ts) < 180000;
}

async function occProbeNode(node) {
  const ts = Date.now();
  let slotsRes = null, statusRes = null, healthRes = null, propsRes = null;
  if (node.engine === 'strata') {
    const r = await Promise.all([
      occJson(node.host, node.port, '/slots'),
      occJson(node.host, node.port, '/status'),
      occJson(node.host, node.port, '/health'),
    ]);
    slotsRes = r[0]; statusRes = r[1]; healthRes = r[2];
  } else {
    // /props pèse ~10 Ko : relu seulement si le modèle est inconnu ou vieux de 5 min.
    const needProps = !OCC.models[node.id] || (Date.now() - (OCC.modelsTs[node.id] || 0)) > 300000;
    const r = await Promise.all([
      occJson(node.host, node.port, '/slots'),
      needProps ? occJson(node.host, node.port, '/props') : Promise.resolve(null),
    ]);
    slotsRes = r[0]; propsRes = r[1];
  }
  const slots = (slotsRes && slotsRes.ok && Array.isArray(slotsRes.data)) ? slotsRes.data : null;
  const st = (statusRes && statusRes.ok && statusRes.data && typeof statusRes.data === 'object') ? statusRes.data : null;
  const health = (healthRes && healthRes.ok && healthRes.data && typeof healthRes.data === 'object') ? healthRes.data : null;
  const props = (propsRes && propsRes.ok && propsRes.data && typeof propsRes.data === 'object') ? propsRes.data : null;

  const stats = occSlotsStats(slots);

  let model = OCC.models[node.id] || null;
  if (health && health.model) model = String(health.model);
  if (props && props.model_path) model = String(props.model_path).split('/').pop() || model;
  if (model) { OCC.models[node.id] = model; OCC.modelsTs[node.id] = Date.now(); }

  let nctx = stats.n_ctx;
  if (!nctx && health && typeof health.max_context === 'number') nctx = health.max_context;
  if (!nctx && props && props.default_generation_settings && typeof props.default_generation_settings.n_ctx === 'number') {
    nctx = props.default_generation_settings.n_ctx;
  }

  const online = !!(slots || st || health);
  let state = 'online';
  if (!online) state = occCardFresh(node.id) ? 'stopped' : 'offline';

  const promptTokens = stats.prompt_tokens !== null ? stats.prompt_tokens
    : ((st && typeof st.prompt_tokens === 'number') ? st.prompt_tokens : null);
  const track = occTrackSlots(node.id, stats.perSlot, ts, slots !== null);

  const active = stats.active;
  const busySlots = active > 0;
  const busyStatus = !!(st && st.busy === true);
  const queued = (st && typeof st.queued === 'number') ? st.queued : 0;
  const ctxPct = (promptTokens !== null && nctx) ? Math.round((promptTokens / nctx) * 1000) / 10 : null;
  const ctxAgeS = track.changedAt ? Math.round((ts - track.changedAt) / 1000) : null;

  const errors = [];
  if (slotsRes && !slotsRes.ok) errors.push('/slots: ' + slotsRes.error);
  if (statusRes && !statusRes.ok) errors.push('/status: ' + statusRes.error);
  if (healthRes && !healthRes.ok) errors.push('/health: ' + healthRes.error);

  return {
    id: node.id, letter: node.letter, label: node.label, engine: node.engine,
    state: state, model: model, port: node.port,
    slots: stats.slots || (state === 'online' ? 1 : 0),
    active: active,
    queued: queued,
    busy: (state === 'online') && (busySlots || busyStatus),
    busy_slots: busySlots,          // debug : ce que dit /slots
    busy_status: busyStatus,        // debug : ce que dit /status (Strata seul)
    phase: (st && st.phase) ? String(st.phase) : null,
    generated: (st && typeof st.generated === 'number') ? st.generated : null,
    tokens_per_s: (st && typeof st.tokens_per_s === 'number') ? st.tokens_per_s : null,
    elapsed_s: (st && typeof st.elapsed_s === 'number') ? st.elapsed_s : null,
    prompt_tokens: promptTokens,
    prompt_prev: (typeof track.prev === 'number') ? track.prev : null,
    ctx_age_s: ctxAgeS,
    n_ctx: nctx,
    ctx_pct: ctxPct,
    compactions_est: track.compactions,
    last_compaction_at: track.lastDropTs ? new Date(track.lastDropTs).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' }) : null,
    vision: !!((health && health.images === true) || (props && props.mmproj_path)),
    starting: node.engine === 'strata' ? llama224WindowOpen() : false,
    ts: ts,
    errors: errors,
  };
}

function getOccupancy() {
  const now = Date.now();
  if (OCC.cache && (now - OCC.cacheTs) < OCC_CACHE_MS) return Promise.resolve(OCC.cache);
  if (OCC.inflight) return OCC.inflight;   // une seule sonde à la fois, quel que soit le nombre de clients
  OCC.inflight = Promise.all(OCC_NODES.map(occProbeNode)).then((nodes) => {
    const payload = {
      ts: Date.now(),
      fetched_at: new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' }),
      nodes: nodes,
    };
    OCC.cache = payload;
    OCC.cacheTs = Date.now();
    OCC.inflight = null;
    return payload;
  }).catch((e) => {
    OCC.inflight = null;
    if (OCC.cache) return Object.assign({}, OCC.cache, { error: e.message });
    return { ts: Date.now(), fetched_at: null, nodes: [], error: e.message };
  });
  return OCC.inflight;
}

app.get('/api/llm-occupancy', (req, res) => {
  getOccupancy().then((payload) => {
    const now = Date.now();
    res.json({
      ts: payload.ts,
      fetched_at: payload.fetched_at,
      age_s: Math.round((now - payload.ts) / 100) / 10,
      cache_ms: OCC_CACHE_MS,
      error: payload.error || null,
      nodes: (payload.nodes || []).map((n) => Object.assign({}, n, {
        age_s: Math.round((now - (n.ts || payload.ts)) / 100) / 10,
      })),
    });
  }).catch((e) => {
    res.status(500).json({ nodes: [], error: e.message });
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

// ─── Collecteur de t/s réels → data/llm-speed-history.json ──────────────────
// Échantillon = tokens_per_s mesuré PAR LE SERVEUR LUI-MÊME (lu dans le cache
// d'occupation /api/llm-occupancy) quand un nœud est en génération. Coût zéro :
// aucune requête en plus vers les PC, aucun bench lancé. La moyenne 7 j en est
// la consolidation (endpoint /api/llm-speed-7d).
const LLM_SPEED_HISTORY_FILE = '/app/data/llm-speed-history.json';
const SPEED_SAMPLE_MS = 5 * 60 * 1000;           // 1 passage toutes les 5 min
const SPEED_KEEP_MS = 14 * 24 * 3600 * 1000;     // on garde 14 jours (fenêtre 7 j + marge)

function loadSpeedHistory() {
  try {
    const p = JSON.parse(require('fs').readFileSync(LLM_SPEED_HISTORY_FILE, 'utf8'));
    return (p && Array.isArray(p.samples)) ? p : { samples: [] };
  } catch (e) { return { samples: [] }; }
}

function sampleLlmSpeed() {
  getOccupancy().then((payload) => {
    const now = Date.now();
    const hist = loadSpeedHistory();
    (payload.nodes || []).forEach((n) => {
      if (!n || !n.id) return;
      if (typeof n.tokens_per_s === 'number' && n.tokens_per_s > 0) {
        hist.samples.push({
          ts: now,
          node: n.id,
          tps: Math.round(n.tokens_per_s * 10) / 10,
          prompt_tokens: (typeof n.prompt_tokens === 'number' && n.prompt_tokens > 0) ? n.prompt_tokens : null
        });
      }
    });
    hist.samples = hist.samples.filter((s) => (now - s.ts) <= SPEED_KEEP_MS);
    try {
      require('fs').writeFileSync(LLM_SPEED_HISTORY_FILE, JSON.stringify(hist, null, 1));
    } catch (e) { console.error('llm-speed-history write:', e.message); }
  }).catch(() => {});
}
setInterval(sampleLlmSpeed, SPEED_SAMPLE_MS);
setTimeout(sampleLlmSpeed, 30 * 1000);   // 1er passage 30 s après le démarrage

// API: moyenne t/s sur 7 jours par nœud (source : data/llm-speed-history.json,
// alimenté par sampleLlmSpeed — t/s RÉELS en génération, pas le bench statique).
app.get('/api/llm-speed-7d', (req, res) => {
  try {
    const hist = loadSpeedHistory();
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const byNode = {};
    let n = 0, sum = 0, firstTs = null, lastTs = null;
    (hist.samples || []).forEach((s) => {
      if (!s || typeof s.tps !== 'number' || s.ts < cutoff) return;
      const e = byNode[s.node] || (byNode[s.node] = { sum: 0, count: 0, last_ts: null });
      e.sum += s.tps; e.count += 1;
      if (!e.last_ts || s.ts > e.last_ts) e.last_ts = s.ts;
      n += 1; sum += s.tps;
      if (!firstTs || s.ts < firstTs) firstTs = s.ts;
      if (!lastTs || s.ts > lastTs) lastTs = s.ts;
    });
    Object.keys(byNode).forEach((k) => {
      byNode[k] = {
        avg_tps: Math.round((byNode[k].sum / byNode[k].count) * 10) / 10,
        samples: byNode[k].count,
        last_ts: new Date(byNode[k].last_ts).toISOString()
      };
    });
    res.json({
      ok: true,
      window_days: 7,
      by_node: byNode,
      overall: n > 0
        ? { avg_tps: Math.round((sum / n) * 10) / 10, samples: n, first_ts: new Date(firstTs).toISOString(), last_ts: new Date(lastTs).toISOString() }
        : null
    });
  } catch (e) {
    res.json({ ok: false, by_node: {}, overall: null, error: e.message });
  }
});

// API: tâches/heure par PC — INDICATEUR DE VITESSE « nombre de tâches par heure »
// (demande Gabriel 17/11/2026). Source de vérité : pc-task-history.json, écrit par
// collect-pc-task-history.py (cron */15 min, déjà en place pour ce dashboard).
// Méthode : 100 dernières tâches terminées (dur_s connu, fenêtre 30 j) → médiane de
// durée → tâches/h = 60 min / médiane. Le détail du calcul (n, fenêtre, quartiles,
// min/max) part dans le tooltip de survol de la jauge (côté frontend).
app.get('/api/llm-tasks-per-hour', (req, res) => {
  try {
    const h = loadPcTaskHistory();
    // Max pour l'échelle des jauges : UNIQUEMENT les 3 agents qui ont une carte PC
    // (marie=luna, louis=ron, gabriel=harry) — sinon un agent sans carte (ex. serveur
    // hermione, 1 tâche de 1,4 min → 43 tâches/h) fausse l'échelle relative.
    const CARD_AGENTS = new Set(['luna', 'harry', 'ron']);
    const byAgent = {};
    let maxTph = 0;
    Object.keys(h.pcs).forEach((agent) => {
      const evs = (h.pcs[agent].events_30d || [])
        .filter(e => e.dur_s != null)
        .sort((a, b) => new Date(b.start) - new Date(a.start));
      const last100 = evs.slice(0, 100);
      if (!last100.length) {
        byAgent[agent] = { ok: false, n: 0 };
        return;
      }
      const durs = last100.map(e => e.dur_s).sort((a, b) => a - b);
      const median = durs.length % 2
        ? durs[(durs.length - 1) / 2]
        : (durs[durs.length / 2 - 1] + durs[durs.length / 2]) / 2;
      const q = (p) => durs[Math.min(durs.length - 1, Math.floor(p * durs.length))];
      const tph = Math.round((3600 / median) * 10) / 10;
      if (CARD_AGENTS.has(agent) && tph > maxTph) maxTph = tph;
      byAgent[agent] = {
        ok: true,
        n: last100.length,
        median_s: Math.round(median),
        median_min: Math.round((median / 60) * 10) / 10,
        p25_min: Math.round((q(0.25) / 60) * 10) / 10,
        p75_min: Math.round((q(0.75) / 60) * 10) / 10,
        min_min: Math.round((durs[0] / 60) * 10) / 10,
        max_min: Math.round((durs[durs.length - 1] / 60) * 10) / 10,
        tasks_per_hour: tph,
        window: { from: last100[last100.length - 1].start, to: last100[0].start },
      };
    });
    res.json({
      ok: true,
      generated_at: h.generated_at,
      computed_at: h.computed_at,
      by_agent: byAgent,
      max_tasks_per_hour: maxTph,
    });
  } catch (e) {
    res.json({ ok: false, by_agent: {}, error: e.message });
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

// API: liens (carte cliquable)
app.get('/api/links', (req, res) => {
  res.json({ ok: true, links: loadLinks() });
});
app.post('/api/links', (req, res) => {
  try {
    const body = req.body || {};
    const label = String(body.label || '').trim();
    const url = String(body.url || '').trim();
    if (!label || !url) return res.status(400).json({ ok: false, error: 'label et url requis' });
    // Normalise l'URL (ajoute https:// si pas de scheme)
    let u = url;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const links = loadLinks();
    const id = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    links.push({ id: id, label: label, url: u });
    saveLinks(links);
    res.json({ ok: true, links: links });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.delete('/api/links/:id', (req, res) => {
  try {
    const id = req.params.id;
    const links = loadLinks().filter(function(l) { return l.id !== id; });
    saveLinks(links);
    res.json({ ok: true, links: links });
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

// getPlugEntity / getPlugPowerEntity / smoothedPower → lib/plugs.js
// (extrait monolithe, [1/3] Archi 25/11 — mapping entités HA + anti-clignotement)

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
    power = smoothedPower(powerEntityId, power, r.data.state === 'on');
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

// Fenêtres HC en heures décimales (ex. 1.5 = 01:30). Rétro-compat hc_debut/hc_fin.
// Logique pure dans lib/dates.js ; le wrapper fournit la config (I/O).
function hcWindows(cfg) { return hcWindowsFrom(cfg || loadEnergyPrices()); }


function hcWindowsLabel(cfg) { return hcWindowsLabelFrom(cfg || loadEnergyPrices()); }


// Prochaine bascule (début ou fin de fenêtre HC) après `min` minutes

// Logique pure dans lib/energy.js ; le wrapper fournit la config (I/O).
function currentEnergyPrice(cfg, date) { return currentEnergyPriceFrom(cfg || loadEnergyPrices(), date); }

// ─── Solaire : production + import réseau (HA) ────────────────
// ─── Solar Production & Grid Import ───────────────────────────
let _solaireCache = { ts: 0, data: null };


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

// ─── Solaire : historique (besoin maison = production + import EDF) ──────
// ─── Solar history (house demand = production + grid import) ─────────────
let _solaireHistCache = { ts: 0, data: null };

async function fetchSolarHistory(hours) {
  const h = Math.max(1, Math.min(72, parseInt(hours, 10) || 24));
  const end = new Date();
  const start = new Date(end.getTime() - h * 3600 * 1000);
  const entities = [
    'sensor.prise_solaire_puissance',
    'sensor.prise4_cabanon_solaire_puissance',
    'sensor.lixee_zlinky_tic_puissance_apparente'
  ];
  const responses = await Promise.all(
    entities.map(id =>
      axios.get(
        HA_BASE + '/api/history/period/' + start.toISOString()
          + '?end_time=' + end.toISOString()
          + '&minimal_changes=1&entity_id=' + id
          + '&filter_entity_id=' + id,
        { headers: HA_HEADERS, timeout: 15000 }
      ).catch(() => null)
    )
  );
  // Rééchantillonnage en buckets de 5 min (moyenne des points du bucket)
  const stepMs = 5 * 60 * 1000;
  const n = Math.round((end.getTime() - start.getTime()) / stepMs);
  const buckets = Array.from({ length: n + 1 }, (_, i) => ({
    t: start.getTime() + i * stepMs,
    sums: [0, 0, 0],
    counts: [0, 0, 0]
  }));
  responses.forEach((res, idx) => {
    if (!res || !res.data) return;
    (Array.isArray(res.data) ? res.data : []).forEach(series => {
      series.forEach(p => {
        const v = parseFloat(p.state);
        if (isNaN(v)) return;
        const t = new Date(p.last_changed).getTime();
        const bi = Math.floor((t - start.getTime()) / stepMs);
        if (bi < 0 || bi > n) return;
        buckets[bi].sums[idx] += v;
        buckets[bi].counts[idx] += 1;
      });
    });
  });
  // Forward-fill : un bucket vide reprend la valeur précédente
  const lastVal = [0, 0, 0];
  const points = buckets.map(b => {
    for (let i = 0; i < 3; i++) {
      if (b.counts[i] > 0) {
        lastVal[i] = b.sums[i] / b.counts[i];
      }
    }
    const prod = lastVal[0] + lastVal[1];
    const grid = lastVal[2];
    const need = prod + grid;
    const sat = need > 1 ? Math.round((prod / need) * 100) : 100;
    return { t: b.t, prod: Math.round(prod), grid: Math.round(grid), need: Math.round(need), sat: sat };
  });
  return { ok: true, hours: h, stepMin: 5, points: points };
}

app.get('/api/solaire-history', async (req, res) => {
  const hours = parseInt(req.query.hours, 10) || 24;
  const key = 'h' + hours;
  const now = Date.now();
  if (_solaireHistCache.data && _solaireHistCache.key === key && (now - _solaireHistCache.ts) < 10000) {
    return res.json(_solaireHistCache.data);
  }
  try {
    const data = await fetchSolarHistory(hours);
    _solaireHistCache = { ts: now, key: key, data: data };
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
  const spending7d = calcSpendingLast7d();
  const [credits, sys, ollama, live, weather, links] = await Promise.all([
    getAllCredits(), Promise.resolve(getSystem()), getOllamaUsage(), getLiveUsage(),
    getWeather(), Promise.resolve(loadLinks())
  ]);
  const mem = sys.mem;
  const disk = getDisk();

  // ─── GTD Pour IA : queue de tâches pour agents locaux ───────────────────
  const pourIA = loadPourIA();
  const pourIAEst = pourIAEstimate();

  // ─── Historique tâches par PC (30 j) : modèle lu ici (I/O), rendu dans lib/page ─
  let pcHistory = null;
  try { pcHistory = loadPcTaskHistory(); } catch (e) { /* carte → "indisponible" */ }

  // ─── Rendu : logique pure dans lib/page.js (template + helpers de rendu) ──
  const html = renderPage({
    spending, spending24h, spending7d, credits, sys, mem, disk,
    ollama, live, weather, links, pourIA, pourIAEst, pcHistory,
    visibility: loadCardVisibility(), cardOrder: loadCardOrder()
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.end(html);
});


// ─── Boot + LLM : allumer la prise → attendre le boot SSH → lancer le LLM ───
// Un seul appui, trois étapes, un état lisible par la carte. Contraintes de
// conception (chacune évite un échec silencieux) :
//  · la requête HTTP ne dure jamais plus de quelques ms : le travail est un JOB
//    en mémoire, le front lit l avancement (GET /api/pc-boot/:pc) toutes les 4 s ;
//  · on n allume JAMAIS une prise vers OFF (le PC peut héberger ce dashboard) :
//    cette fonctionnalité ne fait que turn_on ;
//  · une machine déjà debout ne fait pas perdre 5 min d attente : la sonde SSH
//    est immédiate, l attente ne dure que ce que le boot dure ;
//  · le LLM n est déclaré prêt que quand /health répond 200 côté machine
//    (pgrep prouve un process, pas un modèle chargé).
const BOOT_TARGETS = {
  gabriel: { ip: '192.168.3.224', ssh: 'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=6 gab@192.168.3.224' },
  louis:   { ip: '192.168.3.206', ssh: 'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=6 gab@192.168.3.206' },
  marie:   { ip: '192.168.3.57',  ssh: 'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=6 -i /root/.ssh/id_ed25519_marie gab@192.168.3.57' },
  boncoin: { ip: '192.168.3.249', ssh: 'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=6 gab@192.168.3.249' },
};
const BOOT_POLL_MS = 8000;      // sonde SSH pendant le boot
const BOOT_WAIT_MS = 300000;    // 5 min : BIOS + OS (le .224 peut afficher GRUB)
const LLM_WAIT_MS  = 420000;    // 7 min : chargement (Strata 66-120 s, GGUF 27B ~60 s)
const bootJobs = {};            // pc -> job en mémoire

function bootElapsedS(job) { return Math.round((Date.now() - job.startedAt) / 1000); }

function bootStep(job, text) {
  job.steps.push({ s: bootElapsedS(job), text: text });
  if (job.steps.length > 8) job.steps.shift();
}

function bootPublic(job) {
  if (!job) return { ok: true, idle: true, done: true, phase: 'idle', steps: [] };
  return {
    ok: !!job.ok, idle: false, pc: job.pc, phase: job.phase, done: job.done, error: job.error,
    elapsedS: bootElapsedS(job),
    lastStep: job.steps.length ? job.steps[job.steps.length - 1].text : '',
    steps: job.steps,
  };
}

async function haSwitchState(entityId) {
  const r = await axios.get(`${HA_BASE}/api/states/${entityId}`, { headers: HA_HEADERS, timeout: 5000 });
  return r.data.state;
}

async function haSwitchOn(entityId) {
  await axios.post(`${HA_BASE}/api/services/switch/turn_on`, { entity_id: entityId }, { headers: HA_HEADERS, timeout: 5000 });
}

function sshReachable(ssh) {
  try {
    return execSync(ssh + " 'echo UP'", { timeout: 20000 }).toString().indexOf('UP') !== -1;
  } catch (e) { return false; }
}

// /health répond 200 quand le modèle est chargé, 503 pendant le chargement
function sshLlmReady(ssh) {
  try {
    const out = execSync(ssh + " 'curl -s -m 4 -o /dev/null -w %{http_code} http://127.0.0.1:8080/health'", { timeout: 20000 }).toString().trim();
    return out.indexOf('200') !== -1;
  } catch (e) { return false; }
}

async function runBootJob(pc) {
  const job = bootJobs[pc];
  const t = BOOT_TARGETS[pc];
  try {
    // 1. Prise
    job.phase = 'plug';
    const entityId = getPlugEntity(pc);
    if (!entityId) {
      bootStep(job, 'Pas de prise HA pour ce PC');
    } else {
      let st = null;
      try { st = await haSwitchState(entityId); } catch (e) { bootStep(job, 'Etat prise illisible : ' + e.message); }
      if (st === 'on') {
        bootStep(job, 'Prise déjà ON');
      } else {
        await haSwitchOn(entityId);
        bootStep(job, 'Prise allumée — attente du courant');
        for (let i = 0; i < 8; i++) {
          await sleepMs(2000);
          try { if (await haSwitchState(entityId) === 'on') break; } catch (e) { /* on continue */ }
        }
      }
    }

    // 2. Machine debout (SSH)
    job.phase = 'boot';
    const bootDeadline = Date.now() + BOOT_WAIT_MS;
    let up = false;
    let announced = false;
    while (Date.now() < bootDeadline) {
      if (sshReachable(t.ssh)) { up = true; break; }
      if (!announced) { bootStep(job, 'SSH absent — boot en cours'); announced = true; }
      await sleepMs(BOOT_POLL_MS);
    }
    if (!up) {
      throw new Error('Machine injoignable en SSH après ' + Math.round(BOOT_WAIT_MS / 1000) + ' s (' + t.ip +
        ') — PC éteint, mauvais OS au boot, ou sshd indisponible');
    }
    bootStep(job, 'SSH OK à ' + bootElapsedS(job) + ' s');

    // 3. LLM — ne JAMAIS relancer un serveur déjà prêt : /health 200 avant le
    //    lancement prouve que le modèle est chargé. Sans ce test, un appui sur
    //    Boot alors que le LLM tourne déclarait « prêt » en 17 s (le 200 venait
    //    de l ANCIEN process, que le script allait tuer juste après).
    job.phase = 'llm';
    let already = false;
    if (pc === 'gabriel') {
      const info0 = await probeLlama224Async(true);
      already = !!(info0 && info0.health === true);
    } else {
      already = sshLlmReady(t.ssh);
    }
    if (already) {
      job.ok = true;
      job.phase = 'done';
      bootStep(job, 'LLM déjà en marche sur :8080 — rien à lancer');
      return;
    }
    const launchCmd = t.ssh + " 'nohup ~/script/start-default-llm.sh >/tmp/start-default-llm-dashboard.log 2>&1 & echo OK'";
    if (pc === 'gabriel') {
      startLlama224Window(LLM_WAIT_MS);
      spawnDetached(launchCmd);
    } else {
      execSync(launchCmd, { timeout: 20000 });
    }
    bootStep(job, 'Lancement LLM demandé');

    const llmDeadline = Date.now() + LLM_WAIT_MS;
    let ready = false;
    while (Date.now() < llmDeadline) {
      await sleepMs(8000);
      if (pc === 'gabriel') {
        const info = await probeLlama224Async(true);
        ready = !!(info && info.health === true);
      } else {
        ready = sshLlmReady(t.ssh);
      }
      if (ready) break;
    }
    if (!ready) {
      throw new Error('LLM pas prêt après ' + Math.round(LLM_WAIT_MS / 1000) + ' s — voir ' +
        '/tmp/start-default-llm-dashboard.log sur ' + pc);
    }
    job.ok = true;
    job.phase = 'done';
    bootStep(job, 'LLM prêt sur :8080 à ' + bootElapsedS(job) + ' s');
  } catch (e) {
    job.ok = false;
    job.phase = 'error';
    job.error = e.message;
    bootStep(job, 'Échec : ' + e.message);
  } finally {
    job.done = true;
  }
}

app.post('/api/pc-boot', (req, res) => {
  const pc = (req.body || {}).pc;
  if (!BOOT_TARGETS[pc]) return res.status(400).json({ ok: false, error: 'PC inconnu' });
  const running = bootJobs[pc];
  if (running && !running.done) return res.json({ ok: true, already: true, job: bootPublic(running) });
  bootJobs[pc] = { pc: pc, startedAt: Date.now(), done: false, ok: null, phase: 'plug', error: null, steps: [] };
  runBootJob(pc).catch((e) => {
    bootJobs[pc].done = true; bootJobs[pc].ok = false; bootJobs[pc].phase = 'error'; bootJobs[pc].error = e.message;
  });
  res.json({ ok: true, started: true, job: bootPublic(bootJobs[pc]) });
});

app.get('/api/pc-boot/:pc', (req, res) => {
  res.json(bootPublic(bootJobs[req.params.pc]));
});

// ─── Extinction : kill LLM → poweroff PC → vérifier l'extinction → couper la prise ───
// Image miroir du job Boot : job en mémoire + polling du front (GET /api/pc-shut/:pc),
// un rechargement de page (meta refresh 30 s) ne perd pas l'avancement.
// L'extinction est vérifiée sur DEUX critères avant de couper la prise (jamais de
// coupure brutale sur une machine qui tourne encore) :
//  · SSH ne répond plus (3 échecs consécutifs = 15 s, pour éliminer un blip réseau),
//  · la conso du capteur de puissance de la prise passe sous SHUT_IDLE_W si lisible
//    (un SSH mort peut être un réseau mort ; une conso basse est une preuve physique).
// Si l'un des critères n'est pas atteint à l'échéance → la prise reste ON, on le signale.
const SHUT_OFF_WAIT_MS = 180000;   // 3 min pour une extinction complète
const SHUT_POLL_MS = 5000;         // intervalle de sonde
const SHUT_IDLE_W = 10;            // « éteint » = conso prise < 10 W (veille USB)
const SHUT_STUCK_W = 30;           // SSH mort mais conso > 30 W = extinction en cours/bloquée
const SHUT_SSH_DOWN_NEEDED = 3;    // échecs SSH consécutifs requis sans capteur lisible
const shutJobs = {};

function shutElapsedS(job) { return Math.round((Date.now() - job.startedAt) / 1000); }

function shutStep(job, text) {
  job.steps.push({ s: shutElapsedS(job), text: text });
  if (job.steps.length > 8) job.steps.shift();
}

function shutPublic(job) {
  if (!job) return { ok: true, idle: true, done: true, phase: 'idle', steps: [] };
  return {
    ok: !!job.ok, idle: false, pc: job.pc, phase: job.phase, done: job.done, error: job.error,
    elapsedS: shutElapsedS(job),
    lastStep: job.steps.length ? job.steps[job.steps.length - 1].text : '',
    steps: job.steps,
  };
}

function haSwitchOff(entityId) {
  return axios.post(`${HA_BASE}/api/services/switch/turn_off`, { entity_id: entityId }, { headers: HA_HEADERS, timeout: 5000 });
}

async function haPlugPowerW(name) {
  const id = getPlugPowerEntity(name);
  if (!id) return null;
  try {
    const r = await axios.get(`${HA_BASE}/api/states/${id}`, { headers: HA_HEADERS, timeout: 5000 });
    if (!r.data || r.data.state === 'unknown' || r.data.state === 'unavailable') return null;
    const v = parseFloat(r.data.state);
    return isNaN(v) ? null : v;
  } catch (e) { return null; }
}

async function runShutJob(pc) {
  const job = shutJobs[pc];
  const t = BOOT_TARGETS[pc];
  try {
    // 1. Kill du LLM (si la machine est debout)
    job.phase = 'kill';
    let up = sshReachable(t.ssh);
    if (!up) {
      shutStep(job, 'SSH absent — PC déjà éteint, LLM ignoré');
    } else {
      if (pc === 'gabriel') {
        // .224 : Strata + llama.cpp, stop-strata.sh gère Strata (jamais pkill -f llama)
        execSync(t.ssh + " '~/script/stop-strata.sh >/tmp/stop-strata-dashboard.log 2>&1; pkill -x llama-server 2>/dev/null; echo OK'", { timeout: 90000 });
      } else {
        execSync(t.ssh + " 'pkill llama-server 2>/dev/null; sleep 2; pgrep llama-server >/dev/null 2>&1 && pkill -9 llama-server; echo KILLED'", { timeout: 30000 });
      }
      await sleepMs(3000);
      // Confirmation : le process est vraiment parti (un port mort ne prouve pas un modèle arrêté)
      if (pc === 'gabriel') {
        const info = await probeLlama224Async(true);
        if (info && info.health === true) throw new Error('Le port 8080 repond encore sur 192.168.3.224 — arret LLM non confirme, extinction annulee');
      } else {
        let alive = false;
        try {
          alive = execSync(t.ssh + " 'pgrep llama-server >/dev/null 2>&1 && echo ALIVE || echo DEAD'", { timeout: 20000 }).toString().indexOf('ALIVE') !== -1;
        } catch (e) { alive = false; }
        if (alive) {
          execSync(t.ssh + " 'pkill -9 llama-server 2>/dev/null; echo OK'", { timeout: 20000 });
          await sleepMs(2000);
        }
      }
      shutStep(job, 'LLM arrete');
    }

    // 2. Extinction du PC
    job.phase = 'off';
    if (up) {
      const poCmd = t.ssh + " '" + (pc === 'louis' ? 'sudo poweroff' : (pc === 'boncoin' ? 'sudo -n shutdown -h now' : 'sudo shutdown -h now')) + "'";
      try {
        execSync(poCmd, { timeout: 30000 });
      } catch (e) {
        // Attendu : la connexion SSH meurt avec la machine (exit 255 / « closed »)
        if (!/255|closed|timed? ?out/i.test(e.message)) throw e;
      }
      shutStep(job, 'Commande d extinction envoyee — attente qu elle meure');
    }

    // 3. Attente d extinction reelle (SSH + conso prise)
    const offDeadline = Date.now() + SHUT_OFF_WAIT_MS;
    let off = false;
    let sshDown = 0;
    while (Date.now() < offDeadline) {
      const stillUp = sshReachable(t.ssh);
      const w = await haPlugPowerW(pc);
      if (stillUp) {
        sshDown = 0;
      } else {
        sshDown++;
        if (w !== null) {
          if (w < SHUT_IDLE_W) { off = true; shutStep(job, 'Extinction confirmee (SSH mort, ' + Math.round(w) + ' W)'); break; }
          if (w > SHUT_STUCK_W) shutStep(job, 'SSH mort mais ' + Math.round(w) + ' W encore — extinction en cours');
        } else if (sshDown >= SHUT_SSH_DOWN_NEEDED) {
          off = true; shutStep(job, 'SSH absent ×' + sshDown + ' (capteur illisible) — considere comme eteint');
          break;
        }
      }
      await sleepMs(SHUT_POLL_MS);
    }
    if (!off) throw new Error('Machine pas confirme eteinte apres ' + Math.round(SHUT_OFF_WAIT_MS / 1000) + ' s — prise LAISSEE ON, verifier ' + pc);

    // 4. Coupure de la prise
    job.phase = 'plug';
    const entityId = getPlugEntity(pc);
    if (!entityId) {
      shutStep(job, 'Pas de prise HA pour ce PC — PC eteint');
    } else {
      let st = null;
      try { st = await haSwitchState(entityId); } catch (e) { shutStep(job, 'Etat prise illisible : ' + e.message); }
      if (st === 'off') {
        shutStep(job, 'Prise deja OFF');
      } else {
        await haSwitchOff(entityId);
        let confirmed = false;
        for (let i = 0; i < 5 && !confirmed; i++) {
          await sleepMs(2000);
          try { if (await haSwitchState(entityId) === 'off') confirmed = true; } catch (e) { /* on retente */ }
        }
        if (!confirmed) throw new Error('Prise : commande OFF envoyee mais etat non confirme — verifier HA');
        shutStep(job, 'Prise OFF — fini');
      }
    }
    job.ok = true;
    job.phase = 'done';
    shutStep(job, 'PC eteint, prise coupee');
  } catch (e) {
    job.ok = false;
    job.phase = 'error';
    job.error = e.message;
    shutStep(job, 'Échec : ' + e.message);
  } finally {
    job.done = true;
  }
}

app.post('/api/pc-shut', (req, res) => {
  const pc = (req.body || {}).pc;
  if (!BOOT_TARGETS[pc]) return res.status(400).json({ ok: false, error: 'PC inconnu' });
  const running = shutJobs[pc];
  if (running && !running.done) return res.json({ ok: true, already: true, job: shutPublic(running) });
  shutJobs[pc] = { pc: pc, startedAt: Date.now(), done: false, ok: null, phase: 'kill', error: null, steps: [] };
  runShutJob(pc).catch((e) => {
    shutJobs[pc].done = true; shutJobs[pc].ok = false; shutJobs[pc].phase = 'error'; shutJobs[pc].error = e.message;
  });
  res.json({ ok: true, started: true, job: shutPublic(shutJobs[pc]) });
});

app.get('/api/pc-shut/:pc', (req, res) => {
  res.json(shutPublic(shutJobs[req.params.pc]));
});

// ─── Arrêt soft : chemins qui marchent dans le conteneur Docker ET en local.
// Dans le conteneur, le disque hote est monte en lecture seule sur /host,
// et l'API GTD (portee par le hote, port 3001) est joignable via le gateway bridge.
const POUR_IA_DIR = fs.existsSync('/host/home/lydstyl/.hermes/state/pour-ia')
  ? '/host/home/lydstyl/.hermes/state/pour-ia'
  : '/home/lydstyl/.hermes/state/pour-ia';
const GTD_TOKEN_FILE = fs.existsSync('/host/home/lydstyl/.hermes/secrets/gtd-api-token')
  ? '/host/home/lydstyl/.hermes/secrets/gtd-api-token'
  : '/home/lydstyl/.hermes/secrets/gtd-api-token';
async function gtdFetch(urlPath, options) {
  // Une reponse HTTP (401 inclus) renvoie sans reessayer ; seul un echec reseau
  // fait basculer sur la base suivante.
  const bases = process.env.GTD_API_BASE ? [process.env.GTD_API_BASE] : ['http://172.17.0.1:3001', 'http://localhost:3001'];
  let lastErr = null;
  for (const base of bases) {
    try { return await fetch(base + urlPath, options); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('API GTD injoignable');
}

// ─── Kill LLM sur un PC — logique commune aux actions kill_llm et stop_task_soft.
// Retourne le payload { ok, state?, result?, error? } à renvoyer au client.
async function killLlmOnPc(pc) {
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
      return { ok: false, state: 'running', error: 'Le port 8080 repond encore sur 192.168.3.224 (modele ' + (last.model || 'inconnu') + ') — arret NON confirme.' };
    }
    return { ok: true, state: 'stopped', result: 'LLM arrete — 192.168.3.224:8080 ne repond plus' };
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
  return { ok: true, result: result };
}

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
      return res.json(await killLlmOnPc(pc));
    }
    
    if (action === 'stop_task_soft') {
      // Arrêt soft : 1) récap LLM du travail en cours, 2) tâche GTD de reprise
      // (status Pour IA), 3) kill du LLM. Si 1 ou 2 échouent, le LLM n'est PAS arrêté.
      const pcToAgent = { marie: 'luna', gabriel: 'harry', louis: 'ron', boncoin: 'dobby' };
      const pcToHost = { marie: '192.168.3.57', gabriel: '192.168.3.224', louis: '192.168.3.206', boncoin: '192.168.3.249' };
      const agent = pcToAgent[pc];
      const host = pcToHost[pc];
      if (!agent || !host) return res.status(400).json({ ok: false, error: 'PC inconnu' });

      // Source de vérité : le lock du dispatch Pour IA (tâche en cours sur ce PC)
      const lockPath = path.join(POUR_IA_DIR, agent + '.lock');
      if (!fs.existsSync(lockPath)) {
        return res.json({ ok: false, error: 'Aucune tâche en cours sur ' + pc + ' (pas de lock ' + agent + ') — rien à sauvegarder' });
      }
      let lock;
      try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
      catch (e) { return res.json({ ok: false, error: 'Lock illisible : ' + e.message }); }
      let prompt = '';
      try { prompt = fs.readFileSync(path.join(POUR_IA_DIR, agent + '.prompt'), 'utf8').slice(0, 12000); } catch (e) { /* prompt optionnel */ }

      // 1) Récap demandé au LLM lui-même (API OpenAI-compatible :8080).
      // Le contexte est PASSE dans le prompt : llama.cpp est stateless,
      // le LLM ne se souvient pas de la session qui le fait tourner.
      let recap = '';
      try {
        const llmRes = await fetch('http://' + host + ':8080/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: "Tu aides à interrompre proprement la tâche d'un agent LLM. Réponds en français en 3 blocs courts préfixés FAIT: / RESTE: / FICHIERS: — max 120 mots, sans préambule. Base-toi uniquement sur le prompt fourni." },
              { role: 'user', content: 'Tâche en cours : ' + (lock.task_name || 'inconnue') + '\n\nPrompt reçu par l\'agent :\n' + prompt }
            ],
            max_tokens: 500,
            temperature: 0.2
          })
        });
        if (!llmRes.ok) throw new Error('HTTP ' + llmRes.status);
        const llmJson = await llmRes.json();
        recap = (llmJson.choices && llmJson.choices[0] && llmJson.choices[0].message && llmJson.choices[0].message.content) || '';
        if (!recap.trim()) throw new Error('récap vide');
      } catch (e) {
        return res.json({ ok: false, error: 'Récap LLM impossible (' + e.message + ') — rien créé, LLM non arrêté' });
      }

      // 2) Tâche GTD de reprise (status Pour IA = remise en dispatch pour reprendre)
      let gtdToken;
      try { gtdToken = fs.readFileSync(GTD_TOKEN_FILE, 'utf8').trim(); }
      catch (e) { return res.json({ ok: false, error: 'Token GTD illisible (' + e.message + ') — LLM non arrêté' }); }
      const now = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
      const resumeNote = '<p><strong>Arrêt soft</strong> — ' + now + ' — PC ' + pc + ' (agent ' + agent + ')</p><p>Tâche d\'origine : <code>' + (lock.task_id || '?') + '</code> — « ' + (lock.task_name || '?') + ' »</p><h3>🧠 Récap (généré avant kill)</h3><pre>' + recap + '</pre><p>Pour reprendre : remettre cette tâche au status <strong>Pour IA</strong>.</p>';
      let newTask;
      try {
        const gtdRes = await gtdFetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + gtdToken },
          body: JSON.stringify({
            name: '⏸ Reprise : ' + (lock.task_name || 'tâche ' + pc),
            note: resumeNote,
            status: 'pour_ia',
            importance: 100
          })
        });
        if (!gtdRes.ok) throw new Error('HTTP ' + gtdRes.status + ' ' + (await gtdRes.text()).slice(0, 200));
        newTask = await gtdRes.json();
      } catch (e) {
        return res.json({ ok: false, error: 'Création GTD impossible (' + e.message + ') — LLM non arrêté' });
      }

      // 3) Kill du LLM (même logique que kill_llm)
      const kill = await killLlmOnPc(pc);
      if (!kill.ok) {
        return res.json({ ok: true, state: kill.state, warning: 'Tâche de reprise « ' + newTask.name + ' » (' + newTask.id + ') créée MAIS kill LLM en échec : ' + (kill.error || kill.result) });
      }
      return res.json({ ok: true, state: kill.state, result: 'Récap → GTD « ' + newTask.name + ' » (' + newTask.id + ') — LLM arrêté' });
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
