// Tests unitaires — lib/occ.js (stats occupation LLM par slot).
// Logique pure : agrège le tableau de slots renvoyé par le serveur LLM.
import { describe, it, expect } from 'vitest';
import { occSlotsStats } from '../lib/occ.js';

describe('occSlotsStats', () => {
  it('tableau vide → zéro', () => {
    const s = occSlotsStats([]);
    expect(s.slots).toBe(0);
    expect(s.active).toBe(0);
    expect(s.prompt_tokens).toBeNull();
    expect(s.n_ctx).toBeNull();
    expect(s.perSlot).toEqual([]);
  });

  it('null / non-tableau → zéro (pas d’exception)', () => {
    expect(occSlotsStats(null).slots).toBe(0);
    expect(occSlotsStats(undefined).slots).toBe(0);
  });

  it('compte slots + actifs', () => {
    const slots = [
      { id: 0, is_processing: true, n_prompt_tokens: 1000, n_ctx: 131072 },
      { id: 1, is_processing: false, n_prompt_tokens: 5000, n_ctx: 131072 },
    ];
    const s = occSlotsStats(slots);
    expect(s.slots).toBe(2);
    expect(s.active).toBe(1);
  });

  it('prompt_tokens = max des slots + n_ctx associé', () => {
    const slots = [
      { id: 0, n_prompt_tokens: 1000, n_ctx: 32768 },
      { id: 1, n_prompt_tokens: 8000, n_ctx: 131072 },
      { id: 2, n_prompt_tokens: 4000, n_ctx: 65536 },
    ];
    const s = occSlotsStats(slots);
    expect(s.prompt_tokens).toBe(8000);
    expect(s.n_ctx).toBe(131072);
    expect(s.perSlot).toHaveLength(3);
  });

  it('entrées nulles / malformées ignorées', () => {
    const slots = [null, 'x', 42, { id: 5, n_prompt_tokens: 1234, n_ctx: 1000 }];
    const s = occSlotsStats(slots);
    expect(s.slots).toBe(4); // length du tableau
    expect(s.active).toBe(0);
    expect(s.prompt_tokens).toBe(1234);
  });

  it('slot sans n_prompt_tokens valide → pas de perSlot', () => {
    const s = occSlotsStats([{ id: 0, n_prompt_tokens: 0 }, { id: 1, n_prompt_tokens: null }]);
    expect(s.prompt_tokens).toBeNull();
    expect(s.perSlot).toEqual([]);
  });
});
