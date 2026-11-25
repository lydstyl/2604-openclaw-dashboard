// lib/usage.js — calculs d'usage (crédits, RAM, uptime) en logique pure.
// Les wrappers I/O (lecture credits_history.json, /proc/meminfo) restent dans index.js.

// Cœur commun des 3 calculs de dépense : somme des baisses de solde entre
// points consécutifs sur la période (les rechargements/hausses sont ignorés).
function spendingFromEntries(entries, periodMs, now) {
  try {
    const cutoff = now - periodMs;
    const recent = (entries || []).filter(e => new Date(e.timestamp).getTime() >= cutoff);
    if (recent.length < 2) return { or: 0, kimi: 0, deepseek: 0, total: 0 };

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

function calcSpending(entries, now) { return spendingFromEntries(entries, 30 * 24 * 60 * 60 * 1000, now); }
function calcSpendingLast24h(entries, now) { return spendingFromEntries(entries, 24 * 60 * 60 * 1000, now); }
function calcSpendingLast7d(entries, now) { return spendingFromEntries(entries, 7 * 24 * 60 * 60 * 1000, now); }

// Analyse d'un /proc/meminfo déjà lu (raw = texte brut, GB = kB→GB).
function parseMeminfo(raw, GB) {
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

function formatUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}j ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

module.exports = {
  spendingFromEntries, calcSpending, calcSpendingLast24h, calcSpendingLast7d,
  parseMeminfo, formatUptime,
};
