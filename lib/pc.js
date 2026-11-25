// lib/pc.js — historique tâches par PC (30 j) : calcul des stats et rendu
// de la carte en logique pure. La lecture du JSON reste dans index.js.
const { escHtml } = require('./render');

// Calcule les stats 30 j par PC depuis le modèle (fenêtre « maintenant − 30 j »
// recalculée à CHAQUE appel, indépendant du dernier run du collecteur).
function computePcTaskHistory(doc, now) {
  const windowDays = doc.window_days || 30;
  const cutoff = new Date(now.getTime() - windowDays * 24 * 3600 * 1000);
  const price = doc.energy_price_eur_kwh != null ? doc.energy_price_eur_kwh : 0.25;

  const outPcs = {};
  for (const [agent, pc] of Object.entries(doc.pcs || {})) {
    const events = pc.events || [];
    const inWin = events.filter(e => e.start && new Date(e.start) >= cutoff);
    let last = null;
    for (const e of events) {
      if (e.start && (!last || new Date(e.start) > new Date(last.start))) last = e;
    }
    const workS = inWin.reduce((s, e) => s + (e.dur_s || 0), 0);
    const workH = workS / 3600;
    const kwh = ((pc.power_w && pc.power_w.working) || 0) * workS / 3600 / 1000;
    outPcs[agent] = {
      label: pc.label,
      host: pc.host,
      power_w: pc.power_w,
      metrics: {
        last_task_at: last ? last.start : null,
        last_task_name: last ? (last.name || null) : null,
        tasks_30d: new Set(inWin.map(e => e.task_id)).size,
        runs_30d: inWin.length,
        work_hours_30d: Math.round(workH * 100) / 100,
        idle_hours_30d: Math.round((windowDays * 24 - workH) * 100) / 100,
        energy_kwh_30d: Math.round(kwh * 1000) / 1000,
        cost_eur_30d: Math.round(kwh * price * 1000) / 1000,
      },
      events_30d: inWin,
    };
  }
  return {
    schema: doc.schema,
    generated_at: doc.generated_at,   // dernier run du collecteur (fraîcheur des données)
    computed_at: now.toISOString(),   // calcul de la fenêtre 30 j
    window_days: windowDays,
    energy_price_eur_kwh: price,
    pcs: outPcs,
  };
}

// `h` = modèle computePcTaskHistory() (null si fichier absent → note indispo).
function buildPcHistoryCardBody(h) {
  try {
  if (!h) return '<div class="note">⚠️ Historique indisponible.</div>';
    const agents = Object.keys(h.pcs);
    if (!agents.length) return '<div class="note">⚠️ Aucun PC dans le modèle (pc-task-history.json).</div>';
    const fmtDT = s => s
      ? new Date(s).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '—';
    const fmtH = v => (v == null ? '—' : (Math.round(v * 10) / 10).toLocaleString('fr-FR') + ' h');
    const blocks = agents.map(function(a) {
      const pc = h.pcs[a];
      const m = pc.metrics;
      const watts = pc.power_w && pc.power_w.working ? pc.power_w.working + ' W' : '—';
      const calib = pc.power_w && pc.power_w.calibrated === false ? ' (est.)' : '';
      const lastName = m.last_task_name ? '« ' + escHtml(m.last_task_name) + ' »' : '—';
      const cell = (k, v, color) => '<div><div class="pch-k">' + k + '</div><div class="pch-v"' + (color ? ' style="color:' + color + '"' : '') + '>' + v + '</div></div>';
      return '<div class="pch-block">'
        + '<div class="pch-head"><span class="pch-label">🖥 ' + escHtml(pc.label || a) + '</span>'
        + '<span class="pch-agent">' + escHtml(a) + ' · ⚡ ' + escHtml(watts) + escHtml(calib) + '</span></div>'
        + '<div class="pch-grid">'
        +   cell('Tâches 30 j', m.tasks_30d + (m.runs_30d > m.tasks_30d ? ' <span style="font-size:.62rem;font-weight:400;color:#777">(' + m.runs_30d + ' runs)</span>' : ''))
        +   cell('Travail 30 j', fmtH(m.work_hours_30d))
        +   cell('Sans travail', fmtH(m.idle_hours_30d))
        +   cell('Énergie 30 j', m.energy_kwh_30d.toLocaleString('fr-FR') + ' kWh')
        +   cell('Coût élec.', m.cost_eur_30d.toLocaleString('fr-FR') + ' €', '#fbbf24')
        +   cell('Dernière tâche', fmtDT(m.last_task_at))
        + '</div>'
        + '<div class="pch-last" title="' + escHtml(lastName) + '">→ ' + lastName + '</div>'
        + '</div>';
    }).join('');
    const genTs = h.generated_at
      ? new Date(h.generated_at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '—';
    const pieHtml = '<div class="pch-pie-title">🥧 Répartition des tâches par PC (30 j)</div>'
      + '<div class="pch-pie-box"><canvas id="pcHistoryPie"></canvas></div>';
    return pieHtml + blocks
      + '<div class="row" style="margin-top:0.55rem"><span class="val-muted">Données du ' + genTs + ' · ' + h.energy_price_eur_kwh.toLocaleString('fr-FR') + ' €/kWh · watts estimés (calibrables dans collect-pc-task-history.py)</span></div>';
  } catch (e) {
    return '<div class="note">⚠️ Historique indisponible : ' + escHtml(String(e.message || e)).slice(0, 120) + '</div>';
  }
}

module.exports = { computePcTaskHistory, buildPcHistoryCardBody };
