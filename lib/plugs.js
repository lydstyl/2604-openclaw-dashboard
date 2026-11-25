// Prises smart (Home Assistant) — mapping entités + anti-clignotement puissance.
// Logique pure (PAS d'I/O) : les appels HTTP vers HA restent dans index.js.
// Extrait du monolithe index.js — tâche GTD [1/3] Archi (25/11/2026).

// Mapping nom de PC → entité Home Assistant.
const PLUG_SWITCH = {
  gabriel: 'switch.prise_1_sous_tableau_commutateur',
  louis: 'switch.bouilloire_commutateur',
  marie: 'switch.prise3',
  boncoin: 'switch.cuisine_prisepcboncoin',
};
const PLUG_POWER = {
  gabriel: 'sensor.prise_1_sous_tableau_puissance',
  louis: 'sensor.bouilloire_puissance',
  marie: 'sensor.prise3_puissance',
  boncoin: 'sensor.cuisine_prisepcboncoin_puissance',
};

function getPlugEntity(name) { return PLUG_SWITCH[name] || null; }
function getPlugPowerEntity(name) { return PLUG_POWER[name] || null; }

// Anti-clignotement : les prises Zigbee (TS011F) rapportent périodiquement 0 W
// entre deux mesures (~10 s toutes les 4-5 min, mesuré 17-18/11/2026 sur
// prise_1_sous_tableau avec le PC à 200-300 W). On mémorise la dernière
// puissance non nulle par entité ; une lecture 0 avec switch ON et un cache
// récent (< 90 s) renvoie le cache au lieu de faire clignoter « 0 W » sur la carte.
const plugPowerCache = new Map(); // entityId -> { w, ts }
const SMOOTH_TTL_MS = 90000;

// `now` injectable (défaut Date.now()) pour pouvoir tester le TTL sans fake timers.
function smoothedPower(entityId, power, switchOn, now = Date.now()) {
  if (power !== null && power > 0) {
    plugPowerCache.set(entityId, { w: power, ts: now });
    return power;
  }
  const c = plugPowerCache.get(entityId);
  if (switchOn && power === 0 && c && (now - c.ts) < SMOOTH_TTL_MS) return c.w;
  return power;
}

// Tests : réinitialiser le cache interne.
function _resetPlugPowerCache() { plugPowerCache.clear(); }

module.exports = { getPlugEntity, getPlugPowerEntity, smoothedPower, SMOOTH_TTL_MS, _resetPlugPowerCache };
