// Tests unitaires — lib/plugs.js (mapping entités HA + anti-clignotement).
// Logique pure : `now` injectable pour tester le TTL sans fake timers.
import { describe, it, expect, beforeEach } from 'vitest';
import { getPlugEntity, getPlugPowerEntity, smoothedPower, SMOOTH_TTL_MS, _resetPlugPowerCache } from '../lib/plugs.js';

const T0 = 1_700_000_000_000;

describe('getPlugEntity / getPlugPowerEntity', () => {
  it('mapping switch connu', () => {
    expect(getPlugEntity('gabriel')).toBe('switch.prise_1_sous_tableau_commutateur');
    expect(getPlugEntity('marie')).toBe('switch.prise3');
    expect(getPlugEntity('boncoin')).toBe('switch.cuisine_prisepcboncoin');
  });

  it('mapping puissance connu', () => {
    expect(getPlugPowerEntity('marie')).toBe('sensor.prise3_puissance');
    expect(getPlugPowerEntity('louis')).toBe('sensor.bouilloire_puissance');
  });

  it('PC inconnu → null', () => {
    expect(getPlugEntity('inconnu')).toBeNull();
    expect(getPlugPowerEntity('inconnu')).toBeNull();
  });
});

describe('smoothedPower (anti-clignotement)', () => {
  beforeEach(() => _resetPlugPowerCache());

  it('puissance > 0 → renvoyée + cache peuplé', () => {
    expect(smoothedPower('e1', 250, true, T0)).toBe(250);
    // Le cache est peuplé : une lecture 0 immédiate renvoie le cache.
    expect(smoothedPower('e1', 0, true, T0 + 1000)).toBe(250);
  });

  it('puissance null → null (pas de cache)', () => {
    expect(smoothedPower('e2', null, true, T0)).toBeNull();
  });

  it('puissance 0 + switch OFF → 0 (pas de lissage)', () => {
    smoothedPower('e3', 100, true, T0);
    expect(smoothedPower('e3', 0, false, T0 + 1000)).toBe(0);
  });

  it('puissance 0 + switch ON + cache récent → valeur cache', () => {
    smoothedPower('e4', 300, true, T0);
    expect(smoothedPower('e4', 0, true, T0 + SMOOTH_TTL_MS - 1000)).toBe(300);
  });

  it('puissance 0 + switch ON + cache expiré → 0', () => {
    smoothedPower('e5', 300, true, T0);
    expect(smoothedPower('e5', 0, true, T0 + SMOOTH_TTL_MS + 1000)).toBe(0);
  });

  it('entités indépendantes (cache par entité)', () => {
    smoothedPower('a', 111, true, T0);
    smoothedPower('b', 222, true, T0);
    expect(smoothedPower('a', 0, true, T0 + 1000)).toBe(111);
    expect(smoothedPower('b', 0, true, T0 + 1000)).toBe(222);
  });
});
