// lib/energy.js — prix énergie (HP/HC) + valeurs solaires : logique pure.
const { parisClock, hcWindows, isInHcWindow, nextBoundary, fmtHour } = require('./dates');

function currentEnergyPrice(cfg, date) {
  // `cfg` obligatoire (chargé par le wrapper I/O d'index.js).
  const c = cfg;
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

function parseSolarValue(state) {
  if (state === 'unknown' || state === 'unavailable' || state === '') return { val: 0, ok: false };
  const n = parseFloat(state);
  if (isNaN(n)) return { val: 0, ok: false };
  return { val: n, ok: true };
}

module.exports = { currentEnergyPrice, parseSolarValue };
