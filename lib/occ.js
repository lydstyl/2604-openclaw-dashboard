// Occupation LLM (cartes « Pour IA ») — stats par slot.
// Logique pure (PAS d'I/O) : la sonde HTTP vers les serveurs LLM reste dans index.js.
// Extrait du monolithe index.js — tâche GTD [1/3] Archi (25/11/2026).

// Agrège les slots d'un serveur LLM : nb de slots, slots actifs (is_processing),
// le plus gros n_prompt_tokens (proxy du contexte) et le n_ctx associé.
// `slots` = tableau brut renvoyé par /v1/... (peut contenir des entrées nulles/malformées).
function occSlotsStats(slots) {
  const out = { slots: 0, active: 0, prompt_tokens: null, n_ctx: null, perSlot: [] };
  if (!Array.isArray(slots) || slots.length === 0) return out;
  out.slots = slots.length;
  let best = null;
  slots.forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    if (s.is_processing === true) out.active += 1;
    const p = (typeof s.n_prompt_tokens === 'number' && s.n_prompt_tokens > 0) ? s.n_prompt_tokens : null;
    if (p !== null) out.perSlot.push({ id: (typeof s.id === 'number') ? s.id : i, p: p });
    if (p !== null && (best === null || p > best.p)) {
      best = { p: p, n: (typeof s.n_ctx === 'number' && s.n_ctx > 0) ? s.n_ctx : null };
    }
  });
  if (best) {
    out.prompt_tokens = best.p;
    out.n_ctx = best.n;
  }
  return out;
}

module.exports = { occSlotsStats };
