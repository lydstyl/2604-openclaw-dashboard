// lib/dates.js — dates de Paris, fenêtres HC : logique pure (zéro I/O).

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
  // `cfg` obligatoire (chargé par le wrapper I/O d'index.js).
  const c = cfg;
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

module.exports = {
  parisOffsetMs, parseParisNaive, hhmmNaive, parisClock, parisHour,
  hcWindows, fmtHour, hcWindowsLabel, isInHcWindow, nextBoundary,
};
