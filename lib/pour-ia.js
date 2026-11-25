// lib/pour-ia.js — carte « GTD — Tâches Pour IA » : logique pure (badges,
// lignes agents, corps de carte). I/O (fichiers data/, locks) dans index.js.
const { escHtml } = require('./render');

const POUR_IA_AGENTS = ['luna', 'harry', 'ron', 'dobby', 'dsh']; // même liste que pour-ia-dispatch.py
const POUR_IA_API_AGENTS = ['hermione'];
const POUR_IA_DISP = { luna: 'Luna', harry: 'Harry', ron: 'Ron', dobby: 'Dobby', dsh: 'DSH', hermione: 'Hermione' };
const POUR_IA_STATUSES = ['running', 'idle', 'paused', 'offline'];
// Agent → PC hôte (même mapping que POUR_IA_AGENT_HOSTS d'index.js / AGENTS du
// dispatch). Un PC peut héberger PLUSIEURS agents (PC Marie = luna + dsh, LLM à
// 2 slots) → la carte les regroupe pour montrer TOUTES les tâches en cours
// (demande Gabriel 20/11/2026 : « je vois qu'une seule tâche, alors que la carte
// PC Marie en montre deux »).
const POUR_IA_AGENT_PC = { luna: 'marie', dsh: 'marie', harry: 'gabriel', ron: 'louis', dobby: 'dobby' };
const POUR_IA_PC_LABELS = { marie: 'PC Marie', gabriel: 'PC Gabriel', louis: 'PC Louis', dobby: 'PC Dobby' };

// Normalise une entrée `agents[]` du JSON (champs tous optionnels → jamais de crash)
function normalizePourIAAgent(a) {
  if (!a || typeof a !== 'object') return null;
  const key = String(a.key || a.agent || '').toLowerCase().trim();
  if (!key) return null;
  const rawStatus = String(a.status || '').toLowerCase();
  return {
    key: key,
    disp: a.disp ? String(a.disp) : (POUR_IA_DISP[key] || key.charAt(0).toUpperCase() + key.slice(1)),
    status: POUR_IA_STATUSES.indexOf(rawStatus) !== -1 ? rawStatus : 'idle',
    task: a.task ? String(a.task) : '',
    api: POUR_IA_API_AGENTS.indexOf(key) !== -1 || POUR_IA_AGENTS.indexOf(key) === -1,
    from_json: true
  };
}

// Médiane des 100 dernières durées (PC Marie) — logique pure sur le doc JSON
// pc-task-history/v1 déjà lu. null si pas assez d'events (pas de ligne ETA).
function pourIAEstimateFromDoc(doc) {
  const luna = (doc.pcs && doc.pcs.luna) || null;
  const events = ((luna && luna.events) || [])
    .filter(e => e.start && e.dur_s > 0)
    .sort((a, b) => new Date(b.start) - new Date(a.start));
  const last = events.slice(0, 100);
  if (!last.length) return null;
  const durs = last.map(e => e.dur_s).sort((a, b) => a - b);
  const mid = Math.floor(durs.length / 2);
  const medianS = durs.length % 2 ? durs[mid] : (durs[mid - 1] + durs[mid]) / 2;
  return { median_min: Math.round(medianS / 60 * 10) / 10, n: last.length };
}

function piaTargetBadge(t) {
  var target = (t && t.target != null) ? String(t.target).toLowerCase().trim() : '';
  if (!target && t && Array.isArray(t.tags)) {
    var tg = t.tags.map(function(x) { return String(x).toLowerCase(); }).filter(function(x) { return x.indexOf('agent-') === 0; })[0];
    if (tg) target = tg.slice(6);
  }
  if (!target || target === 'auto' || target === 'null') {
    return '<span class="pia-badge pia-target pia-target-auto">→ auto</span>';
  }
  var disp = POUR_IA_DISP[target] || (target.charAt(0).toUpperCase() + target.slice(1));
  var isApi = POUR_IA_API_AGENTS.indexOf(target) !== -1 || POUR_IA_AGENTS.indexOf(target) === -1;
  return '<span class="pia-badge pia-target">→ ' + escHtml(disp) + (isApi ? ' (API)' : '') + '</span>';
}
function piaModeBadge(t) {
  var mode = (t && t.mode != null) ? String(t.mode).toLowerCase().trim() : '';
  if (!mode && t && Array.isArray(t.tags)) {
    if (t.tags.indexOf('mode-plan') !== -1) mode = 'plan';
    else if (t.tags.indexOf('mode-rapide') !== -1) mode = 'rapide';
  }
  if (mode !== 'plan' && mode !== 'rapide') return ''; // mode auto → aucun badge
  return '<span class="pia-badge pia-mode pia-mode-' + mode + '">' + mode + '</span>';
}
// Une ligne par agent : pastille d'état + nom + tâche en cours + bouton pause.
// Les agents API (hermione) n'ont pas de wrapper local → pas de bouton pause.
var PIA_STATUS_RENDER = {
  running:  { dot: '⚙️', txt: 'en cours', cls: 'pia-st-running' },
  idle:     { dot: '🟢', txt: 'dispo',    cls: 'pia-st-idle' },
  paused:   { dot: '⏸',  txt: 'pause',    cls: 'pia-st-paused' },
  offline:  { dot: '⚫', txt: 'hors ligne', cls: 'pia-st-offline' },
  cooldown: { dot: '🟡', txt: 'cooldown', cls: 'pia-st-paused' }
};
function piaAgentRowHtml(a) {
  var st = PIA_STATUS_RENDER[a.status] || PIA_STATUS_RENDER.idle;
  var stTxt = st.txt + (a.status === 'cooldown' && a.cooldown_min ? ' (' + a.cooldown_min + ' min)' : '');
  var title = a.status === 'cooldown' ? ' title="Échec récent — le dispatch réessaie après le cooldown"' : '';
  var taskTxt = (a.status === 'running' && a.task) ? ' <span class="pia-agent-task" title="' + escHtml(a.task) + '">· ' + escHtml(a.task) + '</span>' : '';
  var btn;
  if (a.api) btn = '<span class="val-muted" style="font-size:0.62rem">API</span>';
  else if (a.status === 'paused') btn = '<button class="extend-btn" onclick="togglePourIAPause(\'' + a.key + '\', false)">▶ reprendre</button>';
  else btn = '<button class="extend-btn" onclick="togglePourIAPause(\'' + a.key + '\', true)">⏸ pause</button>';
  return '<div class="row pia-agent-row"><span class="label pia-agent-name"><span class="pia-dot ' + st.cls + '"' + title + '>' + st.dot + '</span> ' + escHtml(a.disp) + ' <span class="' + st.cls + '">' + stTxt + '</span>' + taskTxt + '</span><span class="val">' + btn + '</span></div>';
}

// Regroupe les lignes agents par PC hôte. PC multi-agents (ex. PC Marie : luna +
// dsh, 2 slots) → en-tête « 🖥 PC Marie — N tâche(s) en cours » + lignes des
// agents. PC mono-agent → lignes seules, affichage inchangé. `rowFn` rend une
// ligne à partir d'un objet agent (default : piaAgentRowHtml).
function piaAgentsGroupedHtml(agents, rowFn) {
  rowFn = rowFn || piaAgentRowHtml;
  var groups = {}; var order = [];
  (agents || []).forEach(function(a) {
    if (!a || !a.key) return;
    var gk = POUR_IA_AGENT_PC[a.key] || a.key;
    if (!groups[gk]) { groups[gk] = { pc: POUR_IA_AGENT_PC[a.key] || null, agents: [] }; order.push(gk); }
    groups[gk].agents.push(a);
  });
  return order.map(function(gk) {
    var g = groups[gk];
    var rows = g.agents.map(rowFn).join('');
    if (!g.pc || g.agents.length < 2) return rows; // mono-agent : pas d'en-tête
    var running = g.agents.filter(function(a) { return a.status === 'running' && a.task; }).length;
    var badge = running === 0 ? ''
      : ' — <span class="pia-st-running">' + running + ' tâche' + (running > 1 ? 's' : '') + ' en cours</span>';
    return '<div class="row pia-pc-row" style="margin-top:0.3rem"><span class="label" style="font-size:0.72rem;opacity:0.85">🖥 ' + escHtml(POUR_IA_PC_LABELS[g.pc] || g.pc) + badge + '</span></div>' + rows;
  }).join('');
}

// Reutilisé par les endpoints pause / dispatch-now pour renvoyer la carte
// re-rendue au client → mise à jour instantanée, sans rechargement de page.
// `est` = résultat de pourIAEstimateFromDoc (null si indispo) — injecté par le
// wrapper I/O d'index.js pour garder cette fonction pure.
function buildPourIACardBody(pourIA, est) {
  var PIA_MAX_ROWS = 8; // lignes (carte consultée au téléphone)
  let pourIARowsHtml = '';
  if (pourIA.tasks.length > 0) {
    const top = pourIA.tasks.slice(0, PIA_MAX_ROWS);
    pourIARowsHtml = top.map(function(t) {
      var imp = (t.importance != null && t.importance !== '') ? t.importance : '—';
      var impColor = (imp >= 200) ? '#f472b6' : (imp >= 100 ? '#fbbf24' : '#888');
      var noteBrief = '';
      if (t.note) {
        // Extrait le texte brut de la note (strip HTML), max 80 chars
        var plain = String(t.note).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        if (plain.length > 80) plain = plain.slice(0, 77) + '…';
        if (plain) noteBrief = '<div class="pia-task-note">' + escHtml(plain) + '</div>';
      }
      return '<div class="pia-task-block">'
        + '<div class="row pia-task"><span class="label pia-task-name" title="' + escHtml(t.name) + '">' + escHtml(t.name) + '</span>'
        + '<span class="val pia-task-meta">' + piaTargetBadge(t) + piaModeBadge(t) + '<span class="pia-imp" style="color:' + impColor + '">imp ' + escHtml(imp) + '</span></span></div>'
        + noteBrief
        + '</div>';
    }).join('') + (pourIA.tasks.length > PIA_MAX_ROWS ? '<div class="note">+' + (pourIA.tasks.length - PIA_MAX_ROWS) + ' autre(s)…</div>' : '');
  } else {
    pourIARowsHtml = '<div class="note">File vide — rien à traiter 🎉</div>';
  }
  // Ancien affichage des tâches en cours : inutile quand le bloc agents est là
  // (il porte déjà la tâche en cours), conservé en repli si `agents` est absent.
  const pourIAWorkingHtml = (!pourIA.agents && pourIA.working.length)
    ? pourIA.working.map(function(w) {
        var mins = w.started_at ? Math.max(0, Math.round((Date.now() - new Date(w.started_at).getTime()) / 60000)) : null;
        return '<div class="note" style="color:#60a5fa">⚙️ ' + w.agent + ' sur : ' + escHtml(w.task_name) + (mins !== null ? ' <span style="opacity:0.7">(' + mins + ' min)</span>' : '') + '</div>';
      }).join('')
    : '';
  const pourIAMajHtml = pourIA.updated_at
    ? 'maj ' + new Date(pourIA.updated_at).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' })
    : 'jamais mis à jour';
  // Ligne par agent avec interrupteur pause (flag .paused → dispatch l'exclut).
  // Groupée par PC hôte : les agents du même PC (Marie = luna + dsh) sont sous
  // l'en-tête du PC, qui compte les tâches en cours (2 slots → 2 tâches possibles).
  // Si le JSON fournit `agents`, il fait foi (statuts running/idle/paused/offline) ;
  // sinon on retombe sur l'état déduit des locks (comportement historique).
  const pourIAAgentsHtml = pourIA.agents
    ? piaAgentsGroupedHtml(pourIA.agents, piaAgentRowHtml)
    : piaAgentsGroupedHtml(POUR_IA_AGENTS.map(function(a) { return { key: a }; }), function(o) {
      var a = o.key;
      var A = a.toUpperCase();
      var isPaused = pourIA.paused.indexOf(A) !== -1;
      var isWorking = pourIA.working.some(function(w) { return w.agent === A; });
      var cd = (pourIA.cooldown || []).find(function(c) { return c.agent === A; });
      var badge = isPaused ? '<span class="pia-st-paused">⏸ pause</span>'
                : isWorking ? '<span class="pia-st-running">⚙️ en cours</span>'
                : cd ? '<span class="pia-st-paused" title="Échec récent — le dispatch le réessaie après le cooldown">🟡 cooldown (' + cd.remaining_min + ' min)</span>'
                : '<span class="pia-st-idle">🟢 dispo</span>';
      var btn = isPaused
        ? '<button class="extend-btn" onclick="togglePourIAPause(\'' + a + '\', false)">▶ reprendre</button>'
        : '<button class="extend-btn" onclick="togglePourIAPause(\'' + a + '\', true)">⏸ pause</button>';
      return '<div class="row pia-agent-row"><span class="label pia-agent-name">' + A + ' ' + badge + '</span><span class="val">' + btn + '</span></div>';
    });
  // ETA avec 1 agent dispo : pending × médiane des 100 dernières tâches PC Marie
  // (médiane recalculée à chaque rendu depuis pc-task-history.json).
  let etaHtml = '';
  if (pourIA.pending > 0) {
    if (est) {
      const totalMin = pourIA.pending * est.median_min;
      const etaH = Math.round(totalMin / 60 * 10) / 10;
      etaHtml = '<div class="row" style="margin-top:0.4rem"><span class="val-muted" style="font-size:0.72rem">⏱ ≈ ' + etaH.toLocaleString('fr-FR') + ' h avec 1 agent dispo · ' + pourIA.pending + ' × ' + est.median_min.toLocaleString('fr-FR') + ' min (médiane ' + est.n + ' dernières, PC Marie)</span></div>';
    }
  }
  return '<div class="big-value" style="color:' + (pourIA.pending > 0 ? '#f472b6' : '#4ade80') + '">' + pourIA.pending + '<span>tâche(s) en attente' + (pourIA.working.length ? ' · ' + pourIA.working.length + ' en cours' : '') + '</span></div>'
    + etaHtml
    + pourIAWorkingHtml
    + '<hr class="divider">'
    + pourIAAgentsHtml
    + '<hr class="divider">'
    + pourIARowsHtml
    + '<div class="row" style="margin-top:0.5rem"><span class="val-muted">' + pourIAMajHtml + '</span><a href="https://gtd3.duckdns.org" target="_blank" style="color:#60a5fa;font-size:0.72rem;text-decoration:none">↗ GTD</a> <button class="extend-btn" id="pouria-dispatch-btn" onclick="runPourIADispatch()" title="Lance immédiatement un tick de dispatch (même commande que le cron 15 min)">🚀 Dispatch maintenant</button></div>';
}

module.exports = {
  POUR_IA_AGENTS, POUR_IA_API_AGENTS, POUR_IA_DISP, POUR_IA_STATUSES,
  POUR_IA_AGENT_PC, POUR_IA_PC_LABELS,
  normalizePourIAAgent, pourIAEstimateFromDoc,
  piaTargetBadge, piaModeBadge, PIA_STATUS_RENDER, piaAgentRowHtml, piaAgentsGroupedHtml,
  buildPourIACardBody,
};
