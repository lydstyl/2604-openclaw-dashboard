// lib/page.js — rendu de la page principale (GET /) : logique pure.
// Tout le data arrive via ctx ; le template HTML (ex-2200 lignes inline dans
// le handler d'index.js) est centralisé ici pour isoler le rendu des routes.
const { cpuColor, ramColor, diskColor, creditColor, bar, tag } = require('./render');
const { buildPourIACardBody } = require('./pour-ia');
const { buildPcHistoryCardBody } = require('./pc');

function renderPage(ctx) {
  const { spending, spending24h, spending7d, credits, sys, mem, disk,
          ollama, live, weather, links, pourIA, pourIAEst, pcHistory,
          visibility, cardOrder } = ctx;

  const cc  = cpuColor(parseFloat(sys.cpuPct));
  const rc  = ramColor(parseFloat(mem.appsPct));
  const dc  = diskColor(parseFloat(disk.usedPct));
  const kc  = creditColor(credits.total);
  const ts  = new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour12: false });
  const cachePct = ((parseFloat(mem.cache) / parseFloat(mem.total)) * 100).toFixed(1);

  // ─── GTD Pour IA : queue de tâches pour agents locaux ───────────────────
  const pourIACardBodyHtml = buildPourIACardBody(pourIA, pourIAEst);

  // ─── Historique tâches par PC (30 j) : carte serveur rendue depuis le modèle ─
  const pcHistoryCardBodyHtml = buildPcHistoryCardBody(pcHistory);

  // ─── Delegation Tracker (server-rendered) ────────────────────────────
  let delegationHtml = '';

  // ─── Card visibility ─────────────────────────────────────────
  function vis(id) { return visibility[id] !== false; }
  function visHidden(id) { return !vis(id) ? 'card-hidden' : ''; }

  // --- Card order (glisser-deposer) ---
  function orderOf(id) {
    var idx = cardOrder.indexOf(id);
    return 'style="order:' + (idx === -1 ? cardOrder.length : idx) + '"';
  }

  // ─── Météo : construction des 3 lignes (aujourd'hui / demain / après-demain) ──
  const dayLabels = ['Aujourd\u2019hui', 'Demain', 'Apr\u00e8s-demain'];
  let weatherRowsHtml = '';
  if (weather && weather.ok && weather.days && weather.days.length) {
    weatherRowsHtml = weather.days.map(function(day, i) {
      const label = dayLabels[i] || day.date;
      const rain = (day.rainPct != null) ? ' · 💧' + day.rainPct + '%' : '';
      const wind = (day.windKts != null)
        ? '<div class="meteo-wind">🌬 ' + day.windKts + ' kts · raf ' + (day.gustKts != null ? day.gustKts : '—') + '</div>'
        : '';
      return '<div class="meteo-row">'
        + '<span class="meteo-day">' + label + '</span>'
        + '<div class="meteo-main">'
        +   '<div class="meteo-top">'
        +     '<span class="meteo-icon">' + day.icon + '</span>'
        +     '<span class="meteo-label">' + day.label + rain + '</span>'
        +     '<span class="meteo-temp">' + (day.tmin != null ? day.tmin : '—') + '° / ' + (day.tmax != null ? day.tmax : '—') + '°</span>'
        +   '</div>'
        +   wind
        + '</div>'
        + '</div>';
    }).join('');
  } else {
    weatherRowsHtml = '<div class="meteo-row" style="color:#666">⚠️ Météo indisponible' + (weather && weather.error ? ' (' + weather.error + ')' : '') + '</div>';
  }

  // ─── Liens : construction de la liste + formulaire d'ajout ──
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  const linksListHtml = (links && links.length ? links : []).map(function(l) {
    return '<div class="link-row">'
      + '<a class="link-anchor" href="' + esc(l.url) + '" target="_blank" rel="noopener">↗ ' + esc(l.label) + '</a>'
      + '<span class="link-url" title="' + esc(l.url) + '">' + esc(l.url.replace(/^https?:\/\//i, '')) + '</span>'
      + '<button class="link-del" data-link-id="' + esc(l.id) + '" title="Supprimer">×</button>'
      + '</div>';
  }).join('');

  return `<!DOCTYPE html>
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
  .pc-autooff{margin-top:.45rem;font-size:.72rem;font-weight:600;color:#94a3b8;display:flex;justify-content:space-between;align-items:center}
  .autooff-switch{position:relative;display:inline-block;width:1.9rem;height:1rem;flex:none}
  .autooff-switch input{opacity:0;width:0;height:0}
  .autooff-slider{position:absolute;inset:0;background:#475569;border-radius:1rem;cursor:pointer;transition:.15s}
  .autooff-slider:before{content:"";position:absolute;width:.76rem;height:.76rem;left:.12rem;top:.12rem;background:#e2e8f0;border-radius:50%;transition:.15s}
  .autooff-switch input:checked + .autooff-slider{background:#22c55e}
  .autooff-switch input:checked + .autooff-slider:before{transform:translateX(.9rem)}
  .extend-btn{margin-left:.4rem;padding:.1rem .45rem;font-size:.68rem;font-weight:600;color:#e2e8f0;background:#334155;border:1px solid #475569;border-radius:.3rem;cursor:pointer}
  .extend-btn:hover{background:#475569}
  .extend-btn:disabled{opacity:.6;cursor:wait}
  /* GTD Pour IA : lignes compactes (carte lue au téléphone) */
  .pia-task{margin-top:.45rem;gap:.35rem}
  .pia-task-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e8e8e8;font-weight:600;font-size:.82rem}
  .pia-task-meta{display:flex;align-items:center;gap:.25rem;white-space:nowrap;flex:0 0 auto}
  .pia-task-block{margin-top:.55rem;padding:.4rem .5rem;background:#141414;border-radius:6px;border-left:3px solid #2a2a2a}
  .pia-task-block .pia-task{margin-top:0}
  .pia-task-note{font-size:.68rem;color:#777;margin-top:.3rem;line-height:1.3;padding-left:.1rem}
  /* ── Carte Historique tâches par PC (30 j) ── */
  .pch-block{margin-top:.55rem;padding:.45rem .5rem;background:#141414;border-radius:6px;border-left:3px solid #2a2a2a}
  .pch-head{display:flex;justify-content:space-between;align-items:baseline;gap:.5rem}
  .pch-label{font-weight:700;color:#e8e8e8;font-size:.82rem}
  .pch-agent{font-size:.66rem;color:#777;white-space:nowrap}
  .pch-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.35rem .5rem;margin-top:.4rem}
  .pch-k{font-size:.6rem;color:#888;text-transform:uppercase;letter-spacing:.03em}
  .pch-v{font-size:.85rem;font-weight:700;color:#d4d4d4;margin-top:.05rem}
  .pch-last{font-size:.68rem;color:#777;margin-top:.4rem;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pch-pie-title{font-size:.7rem;color:#999;text-transform:uppercase;letter-spacing:.04em;margin-bottom:.35rem}
  .pch-pie-box{position:relative;height:210px;max-width:300px;margin:0 auto .6rem auto;background:#141414;border-radius:6px;padding:.4rem}
  .pch-pie-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#555;font-size:.8rem}
  .pia-badge{display:inline-block;padding:.05rem .35rem;border-radius:.25rem;font-size:.62rem;font-weight:600;line-height:1.3;border:1px solid transparent}
  .pia-target{background:#0a1a2a;color:#60a5fa;border-color:#1e3a5f}
  .pia-target-auto{background:#141414;color:#8a8a8a;border-color:#262626}
  .pia-mode-plan{background:#3b2f00;color:#facc15;border-color:#5c4a00}
  .pia-mode-rapide{background:#042f2e;color:#2dd4bf;border-color:#115e59}
  .pia-imp{color:#f472b6;font-size:.64rem}
  .pia-agent-row{margin-top:.35rem;gap:.35rem}
  .pia-agent-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b8b8b8}
  .pia-agent-task{color:#6b7280;font-size:.7rem}
  .pia-st-running{color:#60a5fa}
  .pia-st-idle{color:#4ade80}
  .pia-st-paused{color:#fbbf24}
  .pia-st-offline{color:#64748b}
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
  .pc-ctx-bar{height:3px;background:#1e293b;border-radius:2px;margin-top:0.25rem;overflow:hidden}
  .pc-ctx-fill{height:100%;border-radius:2px}
  .pc-ctx-detail{display:block;font-size:0.62rem;color:#64748b;margin-top:0.15rem}
  .pc-occ-phase{font-size:0.6rem;color:#6b7280;margin-top:0.1rem}
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
  .pc-btn-soft{background:#2a2205;color:#facc15;border-color:#713f12}
  .pc-btn-soft:hover{background:#3b3008;border-color:#ca8a04}
  .pc-btn-boot{background:#0a1a2a;color:#93c5fd;border-color:#1e3a5f}
  .pc-btn-boot:hover{background:#0f2540;border-color:#2563eb}
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
  /* --- Météo --- */
  .meteo-row{display:flex;align-items:flex-start;gap:0.6rem;padding:0.55rem 0;border-bottom:1px solid #1a1a1a}
  .meteo-row:last-child{border-bottom:none}
  .meteo-day{width:95px;flex-shrink:0;font-size:0.8rem;color:#aaa;font-weight:600;padding-top:0.15rem}
  .meteo-main{flex:1;min-width:0}
  .meteo-top{display:flex;align-items:center;gap:0.5rem}
  .meteo-icon{font-size:1.4rem;line-height:1}
  .meteo-label{flex:1;font-size:0.82rem;color:#e0e0e0}
  .meteo-temp{font-size:0.82rem;color:#60a5fa;font-weight:700;white-space:nowrap}
  .meteo-wind{font-size:0.66rem;color:#94a3b8;margin-top:0.2rem;white-space:nowrap}
  /* --- Liens --- */
  .link-row{display:flex;align-items:center;gap:0.5rem;padding:0.45rem 0;border-bottom:1px solid #1a1a1a}
  .link-row:last-child{border-bottom:none}
  .link-anchor{color:#60a5fa;font-size:0.9rem;font-weight:600;text-decoration:none;white-space:nowrap}
  .link-anchor:hover{text-decoration:underline}
  .link-url{flex:1;font-size:0.7rem;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .link-del{background:transparent;border:1px solid #2a2a2a;color:#666;border-radius:6px;width:24px;height:24px;line-height:1;cursor:pointer;font-size:0.95rem;flex-shrink:0}
  .link-del:hover{border-color:#ef4444;color:#ef4444}
  .link-input{background:#0a0a0a;border:1px solid #2a2a2a;color:#e0e0e0;border-radius:6px;padding:0.4rem 0.5rem;font-size:0.8rem}
  .link-input:focus{outline:none;border-color:#3b82f6}
  .link-add-btn{background:#1d4ed8;border:none;color:#fff;border-radius:6px;padding:0.4rem 0.7rem;font-size:0.8rem;cursor:pointer;white-space:nowrap}
  .link-add-btn:hover{background:#2563eb}
  /* --- Glisser-deposer des cartes --- */
  .grid > [data-card-id]{position:relative}
  .grid > .chart-section{grid-column:1/-1;margin-top:0}
  .grid > [data-card-id] .card-header{padding-right:1.7rem}
  .card-drag-handle{position:absolute;top:0.3rem;right:0.35rem;width:32px;height:36px;display:flex;align-items:center;justify-content:center;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;border:1px solid #262626;border-radius:8px;background:#141414;transition:background .15s,border-color .15s;z-index:5}
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
  .solaire-gauge-row{grid-column:1 / -1;text-align:center}
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
  .gauge-wrap{width:100%;max-width:235px;margin:0 auto}
  .gauge-svg{width:100%;height:auto;display:block}
  .gauge-arc{stroke-width:8;opacity:0.9;stroke-linecap:round}
  .gauge-ticks line{stroke:#9ca3af;stroke-width:2}
  .gauge-labels text{fill:#6b7280;font-size:9px;text-anchor:middle}
  .gauge-needle{transform-box:fill-box;transform-origin:50% 100%;transition:transform 0.9s cubic-bezier(0.4,0,0.2,1)}
  .gauge-needle polygon{fill:#1f2937}
  .gauge-hub{fill:#1f2937}
  .gauge-value{text-align:center;font-size:1.55rem;font-weight:700;color:#fbbf24;line-height:1.1;margin-top:-1px}
  .gauge-unit{font-size:0.7rem;font-weight:400}
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
    <label class="settings-row" data-card-id="pour-ia"><span class="s-icon">🤖</span><input type="checkbox"${vis('pour-ia')?' checked':''}><span class="s-toggle"></span><span class="s-label">GTD — Tâches Pour IA</span></label>
    <label class="settings-row" data-card-id="pc-history"><span class="s-icon">📊</span><input type="checkbox"${vis('pc-history')?' checked':''}><span class="s-toggle"></span><span class="s-label">Historique tâches par PC (30 j)</span></label>
    <label class="settings-row" data-card-id="meteo"><span class="s-icon">🌦️</span><input type="checkbox"${vis('meteo')?' checked':''}><span class="s-toggle"></span><span class="s-label">Météo (Valenciennes)</span></label>
    <label class="settings-row" data-card-id="liens"><span class="s-icon">🔗</span><input type="checkbox"${vis('liens')?' checked':''}><span class="s-toggle"></span><span class="s-label">Liens</span></label>
  </div>
</div>

<div class="grid">

  <!-- ÉNERGIE : production solaire + import réseau, avec coût/économie €/h -->
  <div class="card ${visHidden('energie')}" data-card-id="energie"${orderOf('energie')} >
    <div class="card-header"><span class="icon">⚡</span><span class="card-title">Énergie en temps réel</span></div>
    <div class="solaire-cols">
      <div class="solaire-gauge-row">
        <div class="solaire-col-label">☀️ Production solaire</div>
        <div class="gauge-wrap">
          <svg class="gauge-svg" viewBox="0 0 220 124" aria-hidden="true">
            <defs><linearGradient id="gaugeGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#22c55e"/><stop offset="0.6" stop-color="#fbbf24"/><stop offset="1" stop-color="#ef4444"/></linearGradient></defs>
            <path class="gauge-arc" d="M 22 110 A 88 88 0 0 1 198 110" fill="none" stroke="url(#gaugeGrad)"/>
            <g class="gauge-ticks"><line x1="32" y1="110" x2="22" y2="110"/><line x1="54.9" y1="54.9" x2="47.8" y2="47.8"/><line x1="110" y1="32" x2="110" y2="22"/><line x1="165.2" y1="54.9" x2="172.3" y2="47.8"/><line x1="188" y1="110" x2="198" y2="110"/></g>
            <g class="gauge-labels"><text x="46" y="114">0</text><text x="64.7" y="67.7">250</text><text x="110" y="49">500</text><text x="155.3" y="67.7">750</text><text x="174" y="114">1000</text></g>
            <g id="energie-gauge-needle" class="gauge-needle" style="transform:rotate(-90deg)"><polygon points="110,36 106,110 114,110"/></g>
            <circle class="gauge-hub" cx="110" cy="110" r="7"/>
          </svg>
          <div class="gauge-value" id="energie-prod-w">—<span class="gauge-unit">W</span></div>
        </div>
      </div>
      <div class="solaire-col">
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
    <div style="margin-top:0.9rem">
      <div class="solaire-col-label">📈 Besoin de la maison — 24 h <span style="color:#444">(production + import EDF)</span></div>
      <div style="height:170px;position:relative"><canvas id="energie-history-chart"></canvas></div>
    </div>
    <div class="solaire-grid-sub" id="energie-net" style="margin-top:0.6rem">—</div>
    <div class="solaire-grid-badge" id="energie-badge"></div>
    <div class="solaire-detail" id="energie-hc" style="margin-top:0.55rem">—</div>
    <div class="solaire-price" id="energie-price" onclick="editEnergyPrice()" title="Cliquer pour changer le prix du kWh">—</div>
    <div class="solaire-time" id="energie-time">—</div>
  </div>

  <!-- MÉTÉO : Valenciennes, 3 jours (soleil / pluie) -->
  <div class="card ${visHidden('meteo')}" data-card-id="meteo"${orderOf('meteo')} >
    <div class="card-header"><span class="icon">🌦️</span><span class="card-title">Météo — Valenciennes</span></div>
    ${weatherRowsHtml}
    <div class="note">Open-Meteo · renouvelé toutes les 15 min.</div>
  </div>

  <!-- LIENS : raccourcis cliquables, ajout/suppression -->
  <div class="card ${visHidden('liens')}" data-card-id="liens"${orderOf('liens')} id="liens-card">
    <div class="card-header"><span class="icon">🔗</span><span class="card-title">Liens</span></div>
    <div id="links-list">${linksListHtml}</div>
    <form id="link-add-form" onsubmit="return addLink(event)" style="display:flex;gap:0.4rem;margin-top:0.75rem;flex-wrap:wrap">
      <input id="link-label" class="link-input" type="text" placeholder="Nom (ex : NAS)" style="width:110px" required>
      <input id="link-url" class="link-input" type="text" placeholder="https://…" style="flex:1;min-width:120px" required>
      <button class="link-add-btn" type="submit">＋ Ajouter</button>
    </form>
  </div>

  <!-- CREDITS -->
  <!-- GTD POUR IA : file de tâches pour les agents locaux (luna/harry/ron/dobby) -->
  <div class="card ${visHidden('pour-ia')}" data-card-id="pour-ia"${orderOf('pour-ia')} >
    <div class="card-header"><span class="icon">🤖</span><span class="card-title">GTD — Tâches Pour IA</span></div>
    ${pourIACardBodyHtml}
  </div>

  <!-- HISTORIQUE TÂCHES PAR PC (30 j) : 6 métriques par PC (tâche [4/4]) -->
  <div class="card ${visHidden('pc-history')}" data-card-id="pc-history"${orderOf('pc-history')} >
    <div class="card-header"><span class="icon">📊</span><span class="card-title">Historique tâches par PC (30 j)</span></div>
    ${pcHistoryCardBodyHtml}
  </div>

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
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:0.25rem;font-size:0.8rem"><span style="color:#888">7 derniers jours</span><span style="color:#fb923c;font-weight:700">${spending7d.total.toFixed(3)} $</span></div>
    <hr class="divider">
    <div class="row" style="opacity:0.65"><span class="label">Provider</span><span class="val-muted">30 j · 7 j · 24 h</span></div>
    <div class="row"><span class="label">OpenRouter</span><span class="val" style="color:#60a5fa">${spending.or.toFixed(2)} $ · ${spending7d.or.toFixed(3)} $ · ${spending24h.or.toFixed(3)} $</span></div>
    <div class="row"><span class="label">OpenRouter (ce mois, API)</span><span class="val" style="color:#60a5fa">${live.ok ? live.usageMonthly.toFixed(2) + ' $' : '—'}</span></div>
    <div class="row"><span class="label">Kimi</span><span class="val" style="color:#a78bfa">${spending.kimi.toFixed(2)} $ · ${spending7d.kimi.toFixed(3)} $ · ${spending24h.kimi.toFixed(3)} $</span></div>
    <div class="row"><span class="label">DeepSeek</span><span class="val" style="color:#4ade80">${spending.deepseek.toFixed(2)} $ · ${spending7d.deepseek.toFixed(3)} $ · ${spending24h.deepseek.toFixed(3)} $</span></div>
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
      <button class="pc-btn pc-btn-boot" onclick="bootPc('gabriel')" title="Allumer la prise, attendre le boot, puis lancer le LLM">⚡ Boot + LLM</button>
      <button class="pc-btn" onclick="pcAction('gabriel','start_llm')">▶ Démarrer LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('gabriel','kill_llm')">⏹ Arrêter LLM</button>
      <button class="pc-btn pc-btn-soft" onclick="pcAction('gabriel','stop_task_soft')" title="Récap LLM → tâche GTD de reprise (Pour IA), puis kill du LLM. 30-60 s.">🧠 Arrêt soft</button>
      <button class="pc-btn pc-btn-danger" onclick="shutPc('gabriel')" title="Kill le LLM, éteindre le PC, vérifier l'extinction, couper la prise">⏻ Éteindre + prise</button>
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
      <button class="pc-btn pc-btn-boot" onclick="bootPc('louis')" title="Allumer la prise, attendre le boot, puis lancer le LLM">⚡ Boot + LLM</button>
      <button class="pc-btn" onclick="pcAction('louis','start_llm')">▶ Lancer LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('louis','kill_llm')">⏹ Kill LLM</button>
      <button class="pc-btn pc-btn-soft" onclick="pcAction('louis','stop_task_soft')" title="Récap LLM → tâche GTD de reprise (Pour IA), puis kill du LLM. 30-60 s.">🧠 Arrêt soft</button>
      <button class="pc-btn pc-btn-danger" onclick="shutPc('louis')" title="Kill le LLM, éteindre le PC, vérifier l'extinction, couper la prise">⏻ Éteindre + prise</button>
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
      <button class="pc-btn pc-btn-boot" onclick="bootPc('marie')" title="Allumer la prise, attendre le boot, puis lancer le LLM">⚡ Boot + LLM</button>
      <button class="pc-btn" onclick="pcAction('marie','start_llm')">▶ Lancer LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('marie','kill_llm')">⏹ Kill LLM</button>
      <button class="pc-btn pc-btn-soft" onclick="pcAction('marie','stop_task_soft')" title="Récap LLM → tâche GTD de reprise (Pour IA), puis kill du LLM. 30-60 s.">🧠 Arrêt soft</button>
      <button class="pc-btn pc-btn-danger" onclick="shutPc('marie')" title="Kill le LLM, éteindre le PC, vérifier l'extinction, couper la prise">⏻ Éteindre + prise</button>
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
      <button class="pc-btn pc-btn-boot" onclick="bootPc('boncoin')" title="Allumer la prise, attendre le boot, puis lancer le LLM">⚡ Boot + LLM</button>
      <button class="pc-btn" onclick="pcAction('boncoin','start_llm')">▶ Lancer LLM</button>
      <button class="pc-btn pc-btn-danger" onclick="pcAction('boncoin','kill_llm')">⏹ Kill LLM</button>
      <button class="pc-btn pc-btn-soft" onclick="pcAction('boncoin','stop_task_soft')" title="Récap LLM → tâche GTD de reprise (Pour IA), puis kill du LLM. 30-60 s.">🧠 Arrêt soft</button>
      <button class="pc-btn pc-btn-danger" onclick="shutPc('boncoin')" title="Kill le LLM, éteindre le PC, vérifier l'extinction, couper la prise">⏻ Éteindre + prise</button>
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
// Camembert — répartition des tâches 30 j par PC (tâche Dashboard camembert)
(function() {
  var canvas = document.getElementById('pcHistoryPie');
  if (!canvas || typeof Chart === 'undefined') return;
  fetch('/api/pc-task-history?events=0')
    .then(function(r){ return r.json(); })
    .then(function(data) {
      if (!data || !data.pcs) return;
      var agents = Object.keys(data.pcs);
      var labels = [], values = [];
      agents.forEach(function(a){
        var pc = data.pcs[a];
        labels.push(pc.label || a);
        values.push(pc.metrics && pc.metrics.tasks_30d ? pc.metrics.tasks_30d : 0);
      });
      var total = values.reduce(function(s,v){ return s + v; }, 0);
      if (total === 0) {
        canvas.parentElement.innerHTML = '<div class="pch-pie-empty">Aucune tâche sur 30 j.</div>';
        return;
      }
      var palette = ['#4ade80','#60a5fa','#a78bfa','#fbbf24','#f87171','#22d3ee','#fb923c','#e0e0e0'];
      var colors = labels.map(function(_,i){ return palette[i % palette.length]; });
      new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{
            data: values,
            backgroundColor: colors,
            borderColor: '#111',
            borderWidth: 2,
            hoverOffset: 6
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '55%',
          plugins: {
            legend: {
              position: 'bottom',
              labels: { color: '#ccc', boxWidth: 12, padding: 8, font: { size: 11 } }
            },
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
                  var v = context.parsed;
                  var pct = total ? Math.round(v / total * 100) : 0;
                  return context.label + ' : ' + v + ' tâches (' + pct + ' %)';
                }
              }
            }
          }
        }
      });
    })
    .catch(function(err) {
      console.error('Erreur camembert tâches:', err);
      canvas.parentElement.innerHTML = '<div class="pch-pie-empty">Erreur de chargement.</div>';
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
// ─── Carte Liens : ajout / suppression ───────────────────────────────
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function stripScheme(u){ var s=String(u); if(s.indexOf('https://')===0){return s.slice(8);} if(s.indexOf('http://')===0){return s.slice(7);} return s; }
function renderLinks(links){
  var el = document.getElementById('links-list');
  if(!el) return;
  el.innerHTML = (links||[]).map(function(l){
    return '<div class="link-row">'
      + '<a class="link-anchor" href="' + esc(l.url) + '" target="_blank" rel="noopener">↗ ' + esc(l.label) + '</a>'
      + '<span class="link-url" title="' + esc(l.url) + '">' + esc(stripScheme(l.url)) + '</span>'
      + '<button class="link-del" data-link-id="' + esc(l.id) + '" title="Supprimer">×</button>'
      + '</div>';
  }).join('') || '<div class="link-url" style="padding:0.4rem 0">Aucun lien.</div>';
}
function addLink(ev){
  ev.preventDefault();
  var label = document.getElementById('link-label').value.trim();
  var url   = document.getElementById('link-url').value.trim();
  if(!label || !url) return false;
  fetch('/api/links', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({label:label,url:url}) })
    .then(function(r){ return r.json(); })
    .then(function(d){ if(d.ok){ renderLinks(d.links); document.getElementById('link-label').value=''; document.getElementById('link-url').value=''; } })
    .catch(function(e){ console.error('addLink:', e); });
  return false;
}
function delLink(id){
  fetch('/api/links/' + encodeURIComponent(id), { method:'DELETE' })
    .then(function(r){ return r.json(); })
    .then(function(d){ if(d.ok){ renderLinks(d.links); } })
    .catch(function(e){ console.error('delLink:', e); });
}
// Delégation : remplace les onclick inline (les apostrophes échappées cassent dans la template literal)
document.addEventListener('click', function(e){
  var b = e.target && e.target.closest ? e.target.closest('.link-del') : null;
  if (b && b.getAttribute('data-link-id')) { delLink(b.getAttribute('data-link-id')); }
});
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
  var _llmSpeed7d = null;
  var _tasksPerHour = null;

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
    // Deux chiffres vivants en plus du bench : 7 j = moyenne des t/s RÉELS mesurés
    // (data/llm-speed-history.json, collecteur 5 min) · live = tokens_per_s courant
    // lu dans l'occupation (3 s). Le bench reste la référence max de la barre.
    var n7 = (_llmSpeed7d && _llmSpeed7d.by_node) ? _llmSpeed7d.by_node[name] : null;
    var occN = _occNodes[name];
    var liveTps = (occN && typeof occN.tokens_per_s === 'number' && occN.tokens_per_s > 0) ? occN.tokens_per_s : null;
    var liveTxt = liveTps !== null ? liveTps + ' t/s' : (occN && occN.busy ? 'en cours…' : 'libre');
    var histRow = '<div class="pc-speed-row" style="margin-top:0.2rem"><span class="pc-speed-sub">7 j ' +
      (n7 ? n7.avg_tps + ' t/s · ' + n7.samples + ' mes.' : '— (pas encore de mesures)') + '</span>' +
      '<span class="pc-speed-val" style="font-size:0.85em">live ' + liveTxt + '</span></div>';
    return '<div class="pc-speed-row"><span>⚡ Vitesse <span class="pc-speed-sub">texte libre @' + ctxTxt + ' ctx</span></span>' +
      '<span class="pc-speed-val">' + n.gen_tps + ' t/s</span></div>' +
      '<div class="pc-speed-bar"><div class="pc-speed-fill" style="width:' + pct.toFixed(1) + '%;background:' + col + '"></div></div>' +
      '<div class="pc-speed-row pc-speed-sub" style="margin-top:0.2rem"><span>' + sub + '</span>' +
      '<span>' + Math.round(pct) + '% du max</span></div>' + histRow + tasksPerHourRow(name) + reg;
  }

  // ── Jauge TÂCHES/HEURE (vitesse « nombre de tâches par heure ») ────────────
  // Source : /api/llm-tasks-per-hour → pc-task-history.json (collect-pc-task-history.py,
  // cron 15 min). 100 dernières tâches terminées → médiane → tâches/h = 60 min / médiane.
  // Survvol = détail du calcul (n, fenêtre, quartiles, min/max, fraîcheur).
  // ⚠️ Template literal : pas de backtick, pas d'antislash, pas d'apostrophe
  // dans les chaînes simples (texte du tooltip volontairement sans apostrophe).
  var _tphCardAgent = { marie: 'luna', louis: 'ron', gabriel: 'harry' };
  function tasksPerHourRow(name) {
    var agent = _tphCardAgent[name];
    if (!agent) return '';
    if (!_tasksPerHour || !_tasksPerHour.by_agent) {
      return '<div class="pc-speed-row" style="margin-top:0.2rem"><span>🐢 Tâches/h <span class="pc-speed-sub">médiane 100 dernières tâches</span></span><span class="pc-speed-sub">…</span></div>';
    }
    var t = _tasksPerHour.by_agent[agent];
    if (!t || !t.ok) {
      return '<div class="pc-speed-row" style="margin-top:0.2rem"><span>🐢 Tâches/h <span class="pc-speed-sub">médiane 100 dernières tâches</span></span><span class="pc-speed-sub">— (pas de données)</span></div>';
    }
    var max = parseFloat(_tasksPerHour.max_tasks_per_hour) || t.tasks_per_hour;
    var pct = Math.max(3, Math.min(100, (t.tasks_per_hour / max) * 100));
    var col = (pct > 99) ? '#22c55e' : (pct >= 60 ? '#38bdf8' : '#f59e0b');
    var fmtDT = function(s) {
      return new Date(s).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    };
    // Entités &#10; (jamais de backslash ici : le bloc passe par une template
    // literal serveur — le &#10; devient un saut de ligne dans le tooltip).
    var tip = 'Vitesse = 60 min / médiane par tâche&#10;'
      + 'Médiane : ' + t.median_min + ' min (' + t.n + ' tâches, max 100)&#10;'
      + 'Fenêtre : ' + fmtDT(t.window.from) + ' → ' + fmtDT(t.window.to) + '&#10;'
      + 'Quartiles : p25 ' + t.p25_min + ' min → p75 ' + t.p75_min + ' min&#10;'
      + 'Min ' + t.min_min + ' min · Max ' + t.max_min + ' min&#10;'
      + '→ ' + t.tasks_per_hour + ' tâches/h&#10;'
      + 'Données : ' + (_tasksPerHour.generated_at ? fmtDT(_tasksPerHour.generated_at) : '—') + ' (collecte cron 15 min)';
    return '<div class="pc-speed-row" style="margin-top:0.25rem"><span title="' + tip + '"><u style="text-decoration-color:#444">🐢 Tâches/h</u> <span class="pc-speed-sub">médiane ' + t.median_min + ' min</span></span>' +
      '<span class="pc-speed-val">' + t.tasks_per_hour + ' tâche/h</span></div>' +
      '<div class="pc-speed-bar" style="height:6px" title="' + tip + '"><div class="pc-speed-fill" style="width:' + pct.toFixed(1) + '%;background:' + col + '"></div></div>';
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

  function fetchLlmSpeed7d() {
    fetch('/api/llm-speed-7d').then(function(r) { return r.json(); }).then(function(d) {
      _llmSpeed7d = d;
      refreshSpeedBars();
    }).catch(function() {});
  }

  function fetchLlmTasksPerHour() {
    fetch('/api/llm-tasks-per-hour').then(function(r) { return r.json(); }).then(function(d) {
      _tasksPerHour = d;
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
    var dshWorker = data.dsh_reserved === true;
    if (!stale && llmStatus) {
      if (hasSlots) {
        var slotsLbl = slotsUsed + '/' + slotsTotal + (slotsUsed > 1 ? ' tâches' : ' tâche');
        if (slotsUsed > 0) {
          llmActivityBadge = '<span class="pc-status busy">⚡ ' + slotsLbl + ' en cours' + (dshWorker ? ' · 🤖 DSH' : '') + '</span>';
        } else if (dshWorker) {
          llmActivityBadge = '<span class="pc-status busy">🤖 Worker DSH</span>';
        } else {
          llmActivityBadge = '<span class="pc-status idle">LIBRE · ' + slotsLbl + '</span>';
        }
      } else {
        if (dshWorker) {
          llmActivityBadge = '<span class="pc-status busy">🤖 Worker DSH</span>';
        } else {
          llmActivityBadge = llmBusy ? '<span class="pc-status busy">⚡ TACHE EN COURS</span>' : '<span class="pc-status idle">LIBRE</span>';
        }
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
    if (data.auto_off_disabled === true && !stale) {
      countdownHtml = '<div class="pc-countdown blocked">⏻ Extinction auto désactivée</div>';
    } else if (asd && !stale) {
      if (asd.blocked) {
        countdownHtml = '<div class="pc-countdown blocked">⏻ Extinction suspendue (cron ' + (asd.cronAt || '—') + ')</div>';
      } else if (asd.shutdownAtMs) {
        var remaining = Math.round((asd.shutdownAtMs - Date.now()) / 60000);
        if (remaining <= 0) {
          countdownHtml = '<div class="pc-countdown soon">⏻ Extinction imminente <button class="extend-btn" onclick="extendPcShutdown(\\'' + name + '\\')">⏸ +30 min</button></div>';
        } else {
          var cdCls = remaining <= 5 ? ' soon' : (remaining <= 10 ? ' warn' : '');
          countdownHtml = '<div class="pc-countdown' + cdCls + '">⏻ Extinction dans ' + remaining + ' min <button class="extend-btn" onclick="extendPcShutdown(\\'' + name + '\\')">⏸ +30 min</button></div>';
        }
      }
    }

    // Toggle on/off de l'extinction auto (PC geres par le watchdog seulement :
    // auto_off_disabled = null => PC non gere ou etat indisponible, on cache).
    var autoOffHtml = '';
    if (data.auto_off_disabled === true || data.auto_off_disabled === false) {
      autoOffHtml = '<div class="pc-autooff"><span>⏻ Extinction auto</span>'
        + '<label class="autooff-switch" title="Désactiver pour travailler sur le PC sans qu&#39;il s&#39;éteigne"><input type="checkbox"'
        + (data.auto_off_disabled ? '' : ' checked')
        + ' onchange="setAutoOff(\\'' + name + '\\', this.checked)"><span class="autooff-slider"></span></label></div>';
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
      autoOffHtml +
      countdownHtml +
      '<hr class="divider">' +
      ((name === 'gabriel' || name === 'louis' || name === 'marie' || name === 'boncoin')
        ? '<div class="pc-llm" id="pc-' + name + '-llm">' + llmPanelHtml(name,
            (name === 'gabriel')
              ? '🧠 <strong>—</strong> <span class="pc-status idle">⏳ état…</span>'
              : '🧠 <strong>' + llmModelTxt + '</strong>' + llmCtxBadgeTxt + ' ' + llmStateHtml + llmVisionBadge + llmActivityBadge) + '</div>'
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

    // Show last action result (un message Boot + LLM en cours prime sur last_action :
    // renderPc reconstruit la carte toutes les 10 s et effacerait l avancement)
    var resultEl = document.getElementById('pc-' + name + '-result');
    if (resultEl) {
      var bootMsg = (shutMsgs && shutMsgs[name]) || (bootMsgs && bootMsgs[name]);
      resultEl.textContent = bootMsg ? bootMsg : (data.last_action || '');
      if (!bootMsg && data.last_action) {
        setTimeout(function() {
          if (resultEl) resultEl.textContent = '';
        }, 5000);
      }
    }

    if (name === 'gabriel') refreshLlm224();

    updateAlertBanner();
  }

  // ── Occupation des LLM locaux : GET /api/llm-occupancy ───────────────────
  // Ce bloc est le SEUL consommateur front de l occupation (les 3 machines), et le même
  // contrat est lu par le plugin cbar et le tray Windows.
  // Trois règles, chacune payée par un bug réel :
  //  · sonde toutes les 3 s, INDÉPENDAMMENT du refresh 10 s des cartes : avec l ancien
  //    cycle, une requête LLM de 4 s n apparaissait jamais ;
  //  · le dernier état connu (_occNodes) n est jamais effacé, et le placeholder « état… »
  //    ne revient jamais après le premier rendu ;
  //  · fetch avec AbortController + 5 s : sans timeout, un probe qui traîne figeait le badge
  //    et le verrou _occBusy bloquait tous les cycles suivants.
  // ⚠️ Ce bloc vit dans une template literal : pas de backtick, pas d antislash, pas d apostrophe.
  var _occNodes = {};
  var _occBusy = false;

  function occNum(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

  function occEsc(s) {
    return String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
  }

  function occCtxHtml(n) {
    var pct = occNum(n.ctx_pct);
    if (pct === null) { return ''; }
    var txt = (pct > 0 && pct < 1) ? '< 1 %' : Math.round(pct) + ' %';
    // prompt_tokens = le DERNIER prompt traité : au-delà de 60 s sans nouvelle requête la
    // valeur n est plus forcément celle du contexte courant -> « ~ ».
    var age = occNum(n.ctx_age_s);
    if (!n.busy && age !== null && age > 60) { txt = '~' + txt; }
    var col = pct >= 85 ? '#f87171' : (pct >= 60 ? '#facc15' : '#4ade80');
    var html = ' <span class="pc-ctx-badge">ctx ' + txt + '</span>';
    html = html + '<div class="pc-ctx-bar"><div class="pc-ctx-fill" style="width:' + Math.min(100, pct) + '%;background:' + col + '"></div></div>';
    if (occNum(n.prompt_tokens) !== null && occNum(n.n_ctx) !== null) {
      html = html + '<span class="pc-ctx-detail">' + n.prompt_tokens + ' / ' + n.n_ctx + ' tok</span>';
    }
    return html;
  }

  function occStatusHtml(n) {
    if (n.state === 'offline') { return '<span class="pc-status off">● Hors ligne</span>'; }
    if (n.state === 'stopped') { return '<span class="pc-status off">● Arrêté</span>'; }
    if (n.starting) { return '<span class="pc-status busy">● En cours de démarrage…</span>'; }
    var html = '<span class="pc-status on">● En marche :' + (n.port || 8080) + '</span>';
    if (n.vision) { html = html + ' <span class="pc-status img">🖼 vision</span>'; }
    var queued = occNum(n.queued) || 0;
    // Compteur de slots : affiche X/N taches quand le serveur a PLUSIEURS slots (Marie :
    // parallel 2). Les nœuds à 1 slot gardent le badge générique, sinon "0/1" = bruit.
    var slotsTot = occNum(n.slots);
    var slotsAct = occNum(n.active);
    var multiSlots = slotsTot !== null && slotsTot > 1 && slotsAct !== null;
    if (n.busy) {
      if (multiSlots && slotsAct > 0) {
        html = html + ' <span class="pc-status busy">⚡ ' + slotsAct + '/' + slotsTot + (slotsAct > 1 ? ' tâches' : ' tâche') + ' en cours</span>';
      } else {
        html = html + ' <span class="pc-status busy">⚡ TACHE EN COURS</span>';
      }
      if (queued > 0) { html = html + ' <span class="pc-status busy">⏳ FILE ' + queued + '</span>'; }
      var det = '';
      if (occNum(n.tokens_per_s) !== null) { det = det + n.tokens_per_s + ' t/s'; }
      if (occNum(n.generated) !== null && n.generated > 0) { det = det + (det ? ' · ' : '') + n.generated + ' tok'; }
      if (occNum(n.elapsed_s) !== null && n.elapsed_s > 0) {
        var elS = n.elapsed_s;
        var elTxt = elS < 60 ? elS + ' s' : elS < 3600 ? Math.round(elS / 60) + ' min' : Math.floor(elS / 3600) + ' h ' + Math.round((elS % 3600) / 60) + ' min';
        det = det + (det ? ' · ' : '') + '⏱ ' + elTxt;
      }
      if (det) { html = html + ' <span class="pc-status idle">' + det + '</span>'; }
      if (n.phase) { html = html + '<div class="pc-occ-phase">' + occEsc(n.phase) + '</div>'; }
    } else if (queued > 0) {
      html = html + ' <span class="pc-status busy">⏳ FILE ' + queued + '</span>';
    } else if (multiSlots) {
      html = html + ' <span class="pc-status idle">LIBRE · 0/' + slotsTot + ' tâche</span>';
    } else {
      html = html + ' <span class="pc-status idle">LIBRE</span>';
    }
    return html;
  }

  function renderOccNode(n) {
    if (!n) { return ''; }
    var modelTxt = n.model ? n.model : (n.state === 'online' ? 'modèle inconnu' : '—');
    if (modelTxt.length > 46) { modelTxt = modelTxt.slice(0, 43) + '…'; }
    var html = '🧠 <strong>' + occEsc(modelTxt) + '</strong>';
    if (n.state === 'online') { html = html + occCtxHtml(n); }
    html = html + ' ' + occStatusHtml(n);
    if (occNum(n.compactions_est) > 0) {
      html = html + ' <span class="pc-ctx-badge">≈ ' + n.compactions_est + ' compaction(s)</span>';
    }
    return html;
  }

  // Rendu d une carte PC : l occupation connue prime sur le repli fourni par renderPc.
  function llmPanelHtml(name, fallback) {
    var n = _occNodes[name];
    if (n) { return renderOccNode(n); }
    return fallback;
  }

  // Compatibilité : ancien contrat /api/llm-224 (utilisé après start_llm / kill_llm et par
  // les tests). On convertit sa forme vers celle d un nœud d occupation.
  function renderLlm224(info) {
    var el = document.getElementById('pc-gabriel-llm');
    if (!el || !info) { return; }
    var act = info.activity || {};
    var n = {
      id: 'gabriel',
      state: info.state === 'running' ? 'online' : (info.state === 'starting' ? 'online' : (info.state === 'stopped' ? 'stopped' : 'offline')),
      starting: info.state === 'starting',
      model: info.model || null,
      port: info.port || 8080,
      busy: info.busy === true,
      queued: (occNum(info.queued) !== null) ? info.queued : (occNum(act.queued) || 0),
      vision: (info.vision === true) || (info.images === true),
      tokens_per_s: occNum(act.tokens_per_s) !== null ? act.tokens_per_s : occNum(info.tokens_per_s),
      generated: occNum(act.generated) !== null ? act.generated : occNum(info.generated),
      elapsed_s: occNum(act.elapsed_s) !== null ? act.elapsed_s : occNum(info.elapsed_s),
      phase: info.phase || act.phase || null,
      ctx_pct: occNum(info.ctx_pct),
      prompt_tokens: occNum(info.prompt_tokens),
      n_ctx: occNum(info.n_ctx) !== null ? info.n_ctx : occNum(info.ctx),
      ctx_age_s: 0,
      compactions_est: occNum(info.compactions_est) || 0
    };
    el.innerHTML = renderOccNode(n);
  }

  function renderOccAll() {
    ['gabriel', 'louis', 'marie', 'boncoin'].forEach(function(id) {
      var el = document.getElementById('pc-' + id + '-llm');
      var n = _occNodes[id];
      if (el && n) { el.innerHTML = renderOccNode(n); }
    });
  }

  function pollOccupancy() {
    if (_occBusy) { return; }
    _occBusy = true;
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var opts = { cache: 'no-store' };
    if (ctl) { opts.signal = ctl.signal; }
    var tid = setTimeout(function() { if (ctl) { try { ctl.abort(); } catch (e) {} } }, 5000);
    fetch('/api/llm-occupancy', opts).then(function(r) { return r.json(); }).then(function(data) {
      clearTimeout(tid);
      _occBusy = false;
      var nodes = (data && data.nodes) ? data.nodes : [];
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i] && nodes[i].id) { _occNodes[nodes[i].id] = nodes[i]; }
      }
      renderOccAll();
      refreshSpeedBars();   // la ligne « live t/s » de la barre vitesse suit le badge
    }).catch(function() {
      clearTimeout(tid);
      _occBusy = false;   // jamais de verrou permanent : le tick suivant retente
    });
  }

  function refreshLlm224() { pollOccupancy(); }

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
    fetchLlmSpeed7d();
    fetchLlmTasksPerHour();
    fetchSolaire();
    fetchSolaireHistory();
  }

  // Prolonger le compte à rebours d'extinction d'un PC de 30 min (reset idle_since
  // dans le state.json du watchdog). Appelée par le bouton « ⏸ +30 min » des cartes.
  function extendPcShutdown(name) {
    var btn = document.querySelector('#pc-' + name + '-card .extend-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ …'; }
    fetch('/api/pc-' + name + '/extend', { method: 'POST' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.ok) {
          refreshAll();
        } else {
          if (btn) { btn.disabled = false; btn.textContent = '⏸ +30 min'; }
          alert('Extension echouee : ' + (d.error || 'inconnu'));
        }
      })
      .catch(function(e){
        if (btn) { btn.disabled = false; btn.textContent = '⏸ +30 min'; }
        alert('Extension echouee : ' + e);
      });
  }
  window.extendPcShutdown = extendPcShutdown;

  // Interrupteur on/off de l'extinction auto d'un PC (toggle sur la carte).
  // enabled=true -> le watchdog peut eteindre ; false -> extinction desactivee.
  function setAutoOff(name, enabled) {
    fetch('/api/pc-' + name + '/auto-off', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled })
    })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d.ok) alert('Bascule echouee : ' + (d.error || 'inconnu'));
        refreshAll();
      })
      .catch(function(e){ alert('Bascule echouee : ' + e); refreshAll(); });
  }
  window.setAutoOff = setAutoOff;

  // Pause/reprise d'un agent GTD « Pour IA » (flag .paused lu par pour-ia-dispatch.py).
  // Le serveur renvoie la carte re-rendue (card_html) → mise à jour instantanée,
  // sans rechargement de page.
  function setPourIACard(html) {
    var card = document.querySelector('.card[data-card-id="pour-ia"]');
    if (card && html) {
      var header = card.querySelector('.card-header');
      var headerHtml = header ? header.outerHTML : '';
      card.innerHTML = headerHtml + html;
    }
  }
  // Note de statut éphémère dans la carte (auto-supprimée après 10 s)
  function pourIACardFlash(msg, ok) {
    var card = document.querySelector('.card[data-card-id="pour-ia"]');
    if (!card) return;
    var old = document.getElementById('pouria-status-note');
    if (old) old.remove();
    var div = document.createElement('div');
    div.id = 'pouria-status-note';
    div.className = 'note';
    div.style.color = ok ? '#4ade80' : '#f87171';
    div.style.whiteSpace = 'pre-wrap';
    div.textContent = msg;
    card.appendChild(div);
    setTimeout(function(){ var el = document.getElementById('pouria-status-note'); if (el) el.remove(); }, 10000);
  }
  function togglePourIAPause(agent, paused) {
    var btn = document.querySelector('.card[data-card-id="pour-ia"] button[onclick*="togglePourIAPause(' + agent + '"]');
    if (btn) { btn.disabled = true; btn.textContent = paused ? '⏳ Pause…' : '⏳ Reprise…'; btn.style.background = '#2563eb'; btn.style.color = '#fff'; }
    fetch('/api/pour-ia/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: agent, paused: paused })
    })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.ok) {
          setPourIACard(d.card_html);
          pourIACardFlash(paused ? '⏸ ' + agent + ' en pause' : '▶ ' + agent + ' repris', true);
        }
        else {
          if (btn) { btn.disabled = false; btn.textContent = paused ? '⏸ pause' : '▶ reprendre'; btn.style.background = ''; btn.style.color = ''; }
          alert('Pause echouee : ' + (d.error || 'inconnu'));
        }
      })
      .catch(function(e){
        if (btn) { btn.disabled = false; btn.textContent = paused ? '⏸ pause' : '▶ reprendre'; btn.style.background = ''; btn.style.color = ''; }
        alert('Pause echouee : ' + e);
      });
  }
  // Lancer immédiatement un tick de dispatch (même commande que le cron 15 min)
  // — pas besoin d'attendre le prochain tick.
  function runPourIADispatch() {
    var btn = document.getElementById('pouria-dispatch-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Dispatch en cours…'; }
    fetch('/api/pour-ia/dispatch-now', { method: 'POST' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.ok) {
          setPourIACard(d.card_html);
          pourIACardFlash(d.output ? ('🚀 ' + d.output) : '🚀 Tick lancé — file vide, rien à dispatcher', true);
        } else {
          if (btn) { btn.disabled = false; btn.textContent = '🚀 Dispatch maintenant'; }
          pourIACardFlash('⚠️ Dispatch echoué : ' + d.error, false);
        }
      })
      .catch(function(e){
        if (btn) { btn.disabled = false; btn.textContent = '🚀 Dispatch maintenant'; }
        pourIACardFlash('⚠️ Dispatch echoué : ' + e, false);
      });
  }
  window.togglePourIAPause = togglePourIAPause;
  window.runPourIADispatch = runPourIADispatch;

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
    // Un message Boot + LLM n a plus de sens dès qu on lance/arrête à la main
    if (bootMsgs && action !== 'set_auto_kill') bootMsgs[pc] = '';
    if (shutMsgs && action !== 'set_auto_kill') shutMsgs[pc] = '';
    // Feedback visuel immédiat pendant la requête (start_llm peut prendre plusieurs secondes)
    if (resultEl && action === 'start_llm') resultEl.textContent = '⏳ Lancement…';
    if (resultEl && action === 'kill_llm' && pc === 'gabriel') resultEl.textContent = '⏳ Arrêt en cours…';
    if (resultEl && action === 'stop_task_soft') resultEl.textContent = '⏳ Arrêt soft : récap LLM + tâche GTD (30-60 s)…';

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
      if (pc === 'gabriel' && (action === 'start_llm' || action === 'kill_llm' || action === 'stop_task_soft')) refreshLlm224();
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

  // ─── Boot + LLM : un seul bouton (prise -> boot -> LLM) ───────────────────
  // Le job tourne cote serveur (POST /api/pc-boot) : la page ne fait que lire
  // l avancement, donc un rechargement (meta refresh 30 s) ne le perd pas.
  var bootPolling = {};
  var bootMsgs = {};   // dernier message par PC, re-affiché après chaque renderPc
  var shutMsgs = {};   // idem pour le job Extinction + prise

  window.bootPc = function(pc) {
    var el = document.getElementById('pc-' + pc + '-result');
    bootMsgs[pc] = '⏳ Allumage + chargement du LLM…';
    if (el) el.textContent = bootMsgs[pc];
    fetch('/api/pc-boot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pc: pc })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) { if (el) el.textContent = '❌ ' + (res.error || 'Erreur'); return; }
      pollBoot(pc);
    })
    .catch(function(e) {
      console.error('bootPc(' + pc + '):', e);
      if (el) el.textContent = '❌ Erreur réseau';
    });
  };

  function bootPhaseLabel(j) {
    if (j.phase === 'plug') return 'Prise…';
    if (j.phase === 'boot') return 'Boot en cours';
    if (j.phase === 'llm') return 'Chargement du LLM';
    if (j.phase === 'done') return 'LLM prêt';
    if (j.phase === 'error') return 'Échec';
    return 'Démarrage';
  }

  function pollBoot(pc) {
    if (bootPolling[pc]) return;
    bootPolling[pc] = true;
    function tick() {
      fetch('/api/pc-boot/' + pc)
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (!j || j.idle) { bootPolling[pc] = false; return; }
        var el = document.getElementById('pc-' + pc + '-result');
        var line;
        if (j.done && j.ok) line = '✅ LLM prêt en ' + j.elapsedS + ' s';
        else if (j.done) line = '❌ ' + (j.error || 'Échec');
        else line = '⏳ ' + bootPhaseLabel(j) + ' · ' + j.elapsedS + ' s' + (j.lastStep ? ' — ' + j.lastStep : '');
        if (el) el.textContent = line;
        bootMsgs[pc] = line;
        if (!j.done) { setTimeout(tick, 4000); return; }
        bootPolling[pc] = false;
        fetch('/api/pc-' + pc).then(function(r) { return r.json(); }).then(function(d) { renderPc(d, pc); }).catch(function() {});
        fetchPlugState(pc);
      })
      .catch(function(e) { console.error('pollBoot(' + pc + '):', e); bootPolling[pc] = false; });
    }
    tick();
  }

  // Au chargement : reprendre l affichage d un job encore en cours (page rechargee)
  function resumeBoots() {
    ['gabriel', 'louis', 'marie', 'boncoin'].forEach(function(pc) {
      fetch('/api/pc-boot/' + pc).then(function(r) { return r.json(); }).then(function(j) {
        if (j && !j.idle && !j.done) pollBoot(pc);
      }).catch(function() {});
    });
  }
  resumeBoots();

  // ─── Extinction + prise : un seul bouton (LLM -> poweroff -> eteint -> prise OFF) ──
  var shutPolling = {};

  window.shutPc = function(pc) {
    var el = document.getElementById('pc-' + pc + '-result');
    shutMsgs[pc] = '⏳ Arrêt du LLM + extinction du PC…';
    if (el) el.textContent = shutMsgs[pc];
    fetch('/api/pc-shut', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pc: pc })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) { if (el) el.textContent = '❌ ' + (res.error || 'Erreur'); return; }
      pollShut(pc);
    })
    .catch(function(e) {
      console.error('shutPc(' + pc + '):', e);
      if (el) el.textContent = '❌ Erreur réseau';
    });
  };

  function shutPhaseLabel(j) {
    if (j.phase === 'kill') return 'Arrêt du LLM';
    if (j.phase === 'off') return 'Extinction du PC';
    if (j.phase === 'plug') return 'Coupure de la prise';
    if (j.phase === 'done') return 'Terminé';
    if (j.phase === 'error') return 'Échec';
    return 'Extinction';
  }

  function pollShut(pc) {
    if (shutPolling[pc]) return;
    shutPolling[pc] = true;
    function tick() {
      fetch('/api/pc-shut/' + pc)
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (!j || j.idle) { shutPolling[pc] = false; return; }
        var el = document.getElementById('pc-' + pc + '-result');
        var line;
        if (j.done && j.ok) line = '✅ PC éteint — prise coupée en ' + j.elapsedS + ' s';
        else if (j.done) line = '❌ ' + (j.error || 'Échec');
        else line = '⏳ ' + shutPhaseLabel(j) + ' · ' + j.elapsedS + ' s' + (j.lastStep ? ' — ' + j.lastStep : '');
        if (el) el.textContent = line;
        shutMsgs[pc] = line;
        if (!j.done) { setTimeout(tick, 4000); return; }
        shutPolling[pc] = false;
        fetch('/api/pc-' + pc).then(function(r) { return r.json(); }).then(function(d) { renderPc(d, pc); }).catch(function() {});
        fetchPlugState(pc);
      })
      .catch(function(e) { console.error('pollShut(' + pc + '):', e); shutPolling[pc] = false; });
    }
    tick();
  }

  function resumeShuts() {
    ['gabriel', 'louis', 'marie', 'boncoin'].forEach(function(pc) {
      fetch('/api/pc-shut/' + pc).then(function(r) { return r.json(); }).then(function(j) {
        if (j && !j.idle && !j.done) pollShut(pc);
      }).catch(function() {});
    });
  }
  resumeShuts();

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

  var _energyHistChart = null;
  function renderEnergyHistory(d) {
    var canvas = document.getElementById('energie-history-chart');
    if (!canvas) return;
    if (!d || !d.ok || !d.points || !d.points.length) return;
    var labels = d.points.map(function(p) {
      return new Date(p.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
    });
    var cfg = {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Production', data: d.points.map(function(p){ return p.prod; }), backgroundColor: 'rgba(251,191,36,0.35)', borderColor: '#fbbf24', borderWidth: 1, pointRadius: 0, fill: true, stack: 'need', tension: 0.3, yAxisID: 'y' },
          { label: 'Import EDF', data: d.points.map(function(p){ return p.grid; }), backgroundColor: 'rgba(96,165,250,0.35)', borderColor: '#60a5fa', borderWidth: 1, pointRadius: 0, fill: true, stack: 'need', tension: 0.3, yAxisID: 'y' },
          { label: 'Production / besoin', data: d.points.map(function(p){ return p.sat; }), borderColor: '#22c55e', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.3, yAxisID: 'y1' }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#888', boxWidth: 12, font: { size: 10 } } },
          tooltip: { callbacks: { label: function(ctx) {
            var v = ctx.parsed.y;
            return ctx.dataset.label + ' : ' + (ctx.datasetIndex === 2 ? v + ' %' : Math.round(v) + ' W');
          } } }
        },
        scales: {
          x: { ticks: { color: '#555', maxTicksLimit: 8, font: { size: 9 } }, grid: { color: '#1a1a1a' } },
          y: { stacked: true, ticks: { color: '#555', callback: function(v){ return v >= 1000 ? (v / 1000).toLocaleString('fr-FR') + ' kW' : v + ' W'; } }, grid: { color: '#1a1a1a' } },
          y1: { position: 'right', min: 0, max: 100, ticks: { color: '#22c55e', callback: function(v){ return v + ' %'; } }, grid: { drawOnChartArea: false } }
        }
      }
    };
    if (_energyHistChart) {
      _energyHistChart.data = cfg.data;
      _energyHistChart.update('none');
    } else {
      _energyHistChart = new Chart(canvas, cfg);
    }
  }
  function fetchSolaireHistory() {
    fetch('/api/solaire-history?hours=24').then(function(r){return r.json();}).then(renderEnergyHistory).catch(function(e){console.error('solaire-history:',e);});
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
      prodW.innerHTML = '— ' + W('W');
      prodW.style.color = '#fbbf24';
      var needleBad = document.getElementById('energie-gauge-needle');
      if (needleBad) needleBad.style.transform = 'rotate(-90deg)';
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
    var gauge = document.getElementById('energie-gauge-needle');
    if (gauge) {
      var frac = Math.max(0, Math.min(1, (d.prodW || 0) / 1000));
      gauge.style.transform = 'rotate(' + (-90 + 180 * frac) + 'deg)';
      prodW.style.color = prod > 1000 ? '#ef4444' : '#fbbf24';
    }
    // Tooltip autonomie : si prod > 50 W, combien de fois la production pour couvrir la maison ?
    var autonomyTip = '';
    if (prod > 50 && gw > 0) {
      var mult = Math.ceil((gw + prod) / prod);
      autonomyTip = ' title="Autonomie : ' + mult + 'x la production actuelle (' + prod + ' W) nécessaire pour couvrir les ' + (gw + prod) + ' W de la maison"';
    } else if (prod > 50 && gw === 0) {
      autonomyTip = ' title="✅ Maison autonome — production (' + prod + ' W) supérieure à la consommation"';
    }
    if (autonomyTip) {
      var prodWParent = prodW.parentElement;
      if (prodWParent) prodWParent.setAttribute('title', autonomyTip.slice(7));
    }
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
  // Occupation des LLM : sonde dédiée toutes les 3 s, INDÉPENDANTE du refresh 10 s des
  // cartes. C est ce qui rend visible une requête de 4 s (le cycle de 10 s la manquait).
  pollOccupancy();
  setInterval(pollOccupancy, 3000);
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

<!-- Card drag &amp; drop JS (SortableJS : souris ET tactile) -->
<script src="/sortable.min.js"></script>
<script>
(function(){
  var grid = document.querySelector(".grid");
  if (!grid) { return; }

  // Seuls les enfants porteurs d un data-card-id sont deplacables
  function gridCards(){
    var out = [];
    var kids = grid.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].getAttribute && kids[i].getAttribute("data-card-id")) { out.push(kids[i]); }
    }
    return out;
  }

  function currentIds(){
    var ids = [];
    var kids = gridCards();
    for (var i = 0; i < kids.length; i++) { ids.push(kids[i].getAttribute("data-card-id")); }
    return ids;
  }

  function sendOrder(ids){
    fetch("/api/card-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: ids })
    }).then(function(r){ return r.json(); }).catch(function(){});
  }

  // Reordonne le DOM pour coller a l ordre des ids (la grille est pilotee par l ordre DOM)
  function applyOrder(ids){
    var map = {};
    var kids = gridCards();
    for (var i = 0; i < kids.length; i++) { map[kids[i].getAttribute("data-card-id")] = kids[i]; }
    for (var j = 0; j < ids.length; j++) {
      if (map[ids[j]]) { grid.appendChild(map[ids[j]]); }
    }
  }

  // Au chargement, le serveur a rendu l ordre via CSS order (progressive enhancement).
  // On le materialise dans le DOM, puis on retire CSS order : SortableJS opere sur l ordre DOM.
  var cards = gridCards();
  cards.sort(function(a, b){
    var oa = parseInt(a.style.order, 10); if (isNaN(oa)) { oa = 0; }
    var ob = parseInt(b.style.order, 10); if (isNaN(ob)) { ob = 0; }
    return oa - ob;
  });
  cards.forEach(function(c){ grid.appendChild(c); });
  cards.forEach(function(c){ c.style.order = ""; });

  // Poignee de glissement (la carte entiere n est pas draggable : clics et selection de texte preserves)
  var kids = gridCards();
  for (var i = 0; i < kids.length; i++) {
    (function(card){
      if (card.querySelector(".card-drag-handle")) { return; }
      var handle = document.createElement("span");
      handle.className = "card-drag-handle";
      handle.title = "Glisser pour deplacer cette carte";
      card.insertBefore(handle, card.firstChild);
    })(kids[i]);
  }

  new Sortable(grid, {
    handle: ".card-drag-handle",
    animation: 150,
    ghostClass: "dragging",
    onEnd: function(){
      sendOrder(currentIds());
    }
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
</html>`;
}

module.exports = { renderPage };
