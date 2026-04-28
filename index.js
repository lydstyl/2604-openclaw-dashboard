require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const axios   = require('axios');
const os      = require('os');
const fs      = require('fs');
const { execSync } = require('child_process');
const path    = require('path');

const app  = express();
const PORT = 3015;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';
const OLLAMA_KEY = process.env.OLLAMA_KEY || '';
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

// ─── OpenRouter Credits ────────────────────────────────────────────────────
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
    const r = await axios.get('https://api.moonshot.cn/v1/users/me/balance', {
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
    const output = execSync('df -B1 /', { encoding: 'utf8' });
    const lines = output.trim().split('\n');
    if (lines.length < 2) throw new Error('df output unexpected');
    const parts = lines[1].split(/\s+/);
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

// Main dashboard
app.get('/', async (req, res) => {
  const [credits, sys, ollama] = await Promise.all([getAllCredits(), Promise.resolve(getSystem()), getOllamaUsage()]);
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

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>OpenClaw — Dashboard</title>
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
</style>
</head>
<body>
<header>
  <div>
    <h1>OpenClaw Dashboard</h1>
    <div class="subtitle">192.168.3.102 &nbsp;·&nbsp; uptime ${sys.uptime}</div>
  </div>
  <div class="refresh-info">Auto-refresh 30s &nbsp;·&nbsp; ${ts}</div>
</header>

<div class="grid">

  <!-- CREDITS -->
  <div class="card">
    <div class="card-header"><span class="icon">💳</span><span class="card-title">Crédits — Tous providers</span></div>
    <div class="big-value" style="color:${kc}">${credits.total}<span>$</span></div>
    <hr class="divider">
    <div class="row"><span class="label">OpenRouter</span><span class="val" style="color:${credits.or && credits.or.ok ? '#60a5fa' : '#888'}">${credits.or && credits.or.ok ? credits.or.balance + ' $' : '—'}</span></div>
    <div class="row"><span class="label">Kimi</span><span class="val" style="color:${credits.kimi && credits.kimi.ok ? '#a78bfa' : '#888'}">${credits.kimi && credits.kimi.ok ? credits.kimi.balance + ' $' : '—'}</span></div>
    <div class="row"><span class="label">DeepSeek</span><span class="val" style="color:${credits.deepseek && credits.deepseek.ok ? '#4ade80' : '#888'}">${credits.deepseek && credits.deepseek.ok ? credits.deepseek.balance + ' $' : '—'}</span></div>
  </div>

  <!-- CPU -->
  <div class="card">
    <div class="card-header"><span class="icon">🖥️</span><span class="card-title">CPU</span></div>
    <div class="big-value" style="color:${cc}">${sys.cpuPct}<span>%</span></div>
    ${bar(sys.cpuPct, cc)}
    <hr class="divider">
    <div class="row"><span class="label">Load avg (1m)</span><span class="val">${sys.load1}</span></div>
    <div class="row"><span class="label">Cœurs logiques</span><span class="val">${sys.cpuCount}</span></div>
    ${tag(parseFloat(sys.cpuPct) < 50, parseFloat(sys.cpuPct) < 80, '✓ Normal', '⚠ Élevé', '✕ Critique')}
  </div>

  <!-- RAM -->
  <div class="card">
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
  <div class="card">
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
  <div class="card">
    <div class="card-header"><span class="icon">🦙</span><span class="card-title">Ollama Cloud</span></div>
    <div class="big-value" style="color:#a78bfa">${ollama.plan}<span> plan</span></div>
    <hr class="divider">
    <a href="https://ollama.com/settings" target="_blank" style="color:#60a5fa;font-size:0.8rem">↗ Voir l'usage sur ollama.com</a>
    ${!ollama.ok ? `<p class="error-note">Erreur API : ${ollama.error}</p>` : ''}
  </div>

</div>

<!-- Chart Section -->
<div class="chart-section">
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

<footer><a href="http://192.168.3.102:8081">→ Tableau de bord des sites</a></footer>


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
</body>
</html>`);
});

// ─── Start ─────────────────────────────────────────────────────────────────
startCreditsCollector();
app.listen(PORT, '127.0.0.1', () => console.log(`openclaw-dash sur le port ${PORT}`));
