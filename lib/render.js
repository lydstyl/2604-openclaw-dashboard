// lib/render.js — briques de rendu pur (HTML/CSS), zéro I/O.
// Extraite du monolithe index.js (19/11/2026, refactor archi clean).

// Échappement HTML côté serveur.
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

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

// Codes météo WMO → icône + libellé (soleil / pluie en priorité)
const WMO_MAP = {
  0: ['☀️', 'Ensoleillé'], 1: ['⛅', 'Plutôt beau'], 2: ['⛅', 'Variable'], 3: ['☁️', 'Couvert'],
  45: ['🌫️', 'Brouillard'], 48: ['🌫️', 'Brouillard givrant'],
  51: ['🌦️', 'Bruine'], 53: ['🌦️', 'Bruine'], 55: ['🌦️', 'Bruine forte'],
  56: ['🌧️', 'Bruine verglaçante'], 57: ['🌧️', 'Bruine verglaçante'],
  61: ['🌧️', 'Pluie faible'], 63: ['🌧️', 'Pluie'], 65: ['🌧️', 'Pluie forte'],
  66: ['🌧️', 'Pluie verglaçante'], 67: ['🌧️', 'Pluie verglaçante'],
  71: ['🌨️', 'Neige faible'], 73: ['🌨️', 'Neige'], 75: ['🌨️', 'Neige forte'], 77: ['❄️', 'Grains de neige'],
  80: ['🌧️', 'Averses'], 81: ['🌧️', 'Averses modérées'], 82: ['⛈️', 'Averses fortes'],
  85: ['🌨️', 'Averses de neige'], 86: ['🌨️', 'Averses de neige fortes'],
  95: ['⛈️', 'Orage'], 96: ['⛈️', 'Orage avec grêle'], 99: ['⛈️', 'Orage avec grêle']
};
function wmo(code) { return WMO_MAP[code] || ['❓', 'Inconnu']; }

module.exports = { escHtml, bar, cpuColor, ramColor, diskColor, creditColor, tag, WMO_MAP, wmo };
