// Tests unitaires — lib/dates.js + lib/energy.js (dates de Paris, fenêtres HC, prix)
import { describe, it, expect } from 'vitest';
import {
  parisOffsetMs, parseParisNaive, hhmmNaive, parisClock, parisHour,
  hcWindows, fmtHour, hcWindowsLabel, isInHcWindow, nextBoundary,
} from '../lib/dates';
import { currentEnergyPrice, parseSolarValue } from '../lib/energy';

describe('parseParisNaive', () => {
  it('chaîne naive Europe/Paris (hiver, UTC+1)', () => {
    // 12:00 Paris le 19/11/2026 = 11:00 UTC
    expect(parseParisNaive('2026-11-19T12:00:00')).toBe(Date.UTC(2026, 10, 19, 11, 0, 0));
  });
  it('chaîne naive en été (UTC+2)', () => {
    // 12:00 Paris le 15/07/2026 = 10:00 UTC
    expect(parseParisNaive('2026-07-15T12:00:00')).toBe(Date.UTC(2026, 6, 15, 10, 0, 0));
  });
  it('horodate avec fuseau → lecture directe', () => {
    expect(parseParisNaive('2026-11-19T12:00:00Z')).toBe(Date.parse('2026-11-19T12:00:00Z'));
  });
  it('format invalide → null', () => {
    expect(parseParisNaive('pas une date')).toBeNull();
    expect(parseParisNaive('')).toBeNull();
    expect(parseParisNaive(null)).toBeNull();
  });
});

describe('hhmmNaive', () => {
  it('extrait HH:MM de la chaîne', () => {
    expect(hhmmNaive('2026-10-27T13:23:00')).toBe('13:23');
    expect(hhmmNaive('2026-10-27 08:05:00')).toBe('08:05');
    expect(hhmmNaive('zzz')).toBe('—');
  });
});

describe('parisClock / parisHour', () => {
  it('minuterie de Paris', () => {
    // 2026-11-19T01:00:00Z = 02:00 Paris
    expect(parisClock(new Date('2026-11-19T01:00:00Z'))).toBe(120);
    expect(parisHour(new Date('2026-11-19T01:30:00Z'))).toBe(2);
  });
});

describe('hcWindows', () => {
  it('hc_windows valides filtrées', () => {
    expect(hcWindows({ hc_windows: [[1.5, 3], [9, 12], 'bad', [5]] })).toEqual([[1.5, 3], [9, 12]]);
  });
  it('rétro-compat hc_debut/hc_fin', () => {
    expect(hcWindows({ hc_debut: 2, hc_fin: 4 })).toEqual([[2, 4]]);
  });
  it('vide → []', () => {
    expect(hcWindows({})).toEqual([]);
  });
});

describe('fmtHour', () => {
  it('heures décimales → HH:MM', () => {
    expect(fmtHour(1.5)).toBe('01:30');
    expect(fmtHour(3)).toBe('03:00');
    expect(fmtHour(22.5)).toBe('22:30');
  });
});

describe('hcWindowsLabel', () => {
  it('joint les fenêtres', () => {
    expect(hcWindowsLabel({ hc_windows: [[1.5, 3]] })).toBe('01:30–03:00');
    expect(hcWindowsLabel({ hc_windows: [[1.5, 3], [9, 12]] })).toBe('01:30–03:00 & 09:00–12:00');
    expect(hcWindowsLabel({})).toBe('');
  });
});

describe('isInHcWindow', () => {
  it('fenêtre normale', () => {
    const w = [0.5, 3]; // 00:30–03:00
    expect(isInHcWindow(60, w)).toBe(true);   // 01:00
    expect(isInHcWindow(100, w)).toBe(true);  // 01:40
  });
  it('borne inférieure incluse', () => {
    expect(isInHcWindow(30, [0.5, 3])).toBe(true);
    expect(isInHcWindow(180, [0.5, 3])).toBe(false); // borne sup exclue
  });
  it('fenêtre qui passe minuit (22h→2h)', () => {
    const w = [22, 2];
    expect(isInHcWindow(1350, w)).toBe(true);  // 22:30
    expect(isInHcWindow(60, w)).toBe(true);    // 01:00
    expect(isInHcWindow(720, w)).toBe(false);  // 12:00
  });
  it('début == fin → toujours faux', () => {
    expect(isInHcWindow(60, [1, 1])).toBe(false);
  });
});

describe('nextBoundary', () => {
  const list = [[0.5, 3]];
  it('en HC → prochaine fin', () => {
    const b = nextBoundary(60, list, true);   // 01:00, en HC
    expect(b.minutes).toBe(120);              // → 03:00
    expect(b.at).toBe(180);
  });
  it('hors HC → prochain début (wrap 24h)', () => {
    const b = nextBoundary(200, list, false); // 03:20 → 00:30 du lendemain
    expect(b.minutes).toBe(1270);
    expect(b.at).toBe(30);
  });
  it('aucune fenêtre → null', () => {
    expect(nextBoundary(60, [], true)).toBeNull();
  });
});

describe('currentEnergyPrice', () => {
  const CFG = { mode: 'hphc', prix_hc: 0.12, prix_hp: 0.25, hc_windows: [[0.5, 3]] };
  it('en fenêtre HC (02:00 Paris)', () => {
    const r = currentEnergyPrice(CFG, new Date('2026-11-19T01:00:00Z'));
    expect(r.hc).toBe(true);
    expect(r.price).toBe(0.12);
    expect(r.label).toBe('Heures creuses');
    expect(r.nextAt).toBe('03:00');
    expect(r.nextInMin).toBe(60);
  });
  it('hors HC (13:00 Paris)', () => {
    const r = currentEnergyPrice(CFG, new Date('2026-11-19T12:00:00Z'));
    expect(r.hc).toBe(false);
    expect(r.price).toBe(0.25);
    expect(r.label).toBe('Heures pleines');
    expect(r.nextAt).toBe('00:30'); // début HC du lendemain
  });
  it('mode base', () => {
    const r = currentEnergyPrice({ mode: 'base', prix_base: 0.2 }, new Date('2026-11-19T12:00:00Z'));
    expect(r).toEqual({ price: 0.2, label: 'Base', slot: 'prix_base', hc: false, nextAt: null, nextInMin: null });
  });
});

describe('parseSolarValue', () => {
  it('valeurs valides', () => {
    expect(parseSolarValue('432.5')).toEqual({ val: 432.5, ok: true });
    expect(parseSolarValue('0')).toEqual({ val: 0, ok: true });
  });
  it('états HA invalides', () => {
    expect(parseSolarValue('unknown')).toEqual({ val: 0, ok: false });
    expect(parseSolarValue('unavailable')).toEqual({ val: 0, ok: false });
    expect(parseSolarValue('')).toEqual({ val: 0, ok: false });
    expect(parseSolarValue('abc')).toEqual({ val: 0, ok: false });
  });
});
