// Tests unitaires — lib/usage.js (calculs d'usage, logique pure)
import { describe, it, expect } from 'vitest';
import {
  spendingFromEntries, calcSpending, calcSpendingLast24h, calcSpendingLast7d,
  parseMeminfo, formatUptime,
} from '../lib/usage';

const GB = 1048576;
const NOW = Date.parse('2026-11-19T12:00:00Z');

describe('spendingFromEntries', () => {
  const h = 3600 * 1000;
  it('somme les baisses de solde, ignore les rechargements', () => {
    const entries = [
      { timestamp: new Date(NOW - 3 * h).toISOString(), balances: { or: 10, kimi: 5, deepseek: 2 } },
      { timestamp: new Date(NOW - 2 * h).toISOString(), balances: { or: 7, kimi: 5, deepseek: 2 } },
      { timestamp: new Date(NOW - 1 * h).toISOString(), balances: { or: 9, kimi: 3, deepseek: 2 } },
    ];
    const r = spendingFromEntries(entries, 24 * h, NOW);
    expect(r.or).toBeCloseTo(3);     // 10→7
    expect(r.kimi).toBeCloseTo(2);   // 5→3
    expect(r.deepseek).toBeCloseTo(0);
    expect(r.total).toBeCloseTo(5);
  });

  it('moins de 2 points → zéro', () => {
    const r = spendingFromEntries([
      { timestamp: new Date(NOW - h).toISOString(), balances: { or: 10 } },
    ], 24 * h, NOW);
    expect(r).toEqual({ or: 0, kimi: 0, deepseek: 0, total: 0 });
  });

  it('entries hors période ignorées', () => {
    const r = spendingFromEntries([
      { timestamp: new Date(NOW - 72 * h).toISOString(), balances: { or: 10 } },
      { timestamp: new Date(NOW - 48 * h).toISOString(), balances: { or: 0 } },
    ], 24 * h, NOW);
    expect(r.total).toBe(0);
  });

  it('ancien format `balance` (OpenRouter) pris en compte', () => {
    const r = spendingFromEntries([
      { timestamp: new Date(NOW - 2 * h).toISOString(), balance: 8 },
      { timestamp: new Date(NOW - 1 * h).toISOString(), balance: 5 },
    ], 24 * h, NOW);
    expect(r.or).toBeCloseTo(3);
  });
});

describe('wrappers de période', () => {
  const h = 3600 * 1000;
  const entries = [
    { timestamp: new Date(NOW - 2 * h).toISOString(), balances: { or: 10 } },
    { timestamp: new Date(NOW - 1 * h).toISOString(), balances: { or: 6 } },
  ];
  it('24h inclut les points récents', () => {
    expect(calcSpendingLast24h(entries, NOW).or).toBeCloseTo(4);
  });
  it('30j et 7j aussi', () => {
    expect(calcSpending(entries, NOW).or).toBeCloseTo(4);
    expect(calcSpendingLast7d(entries, NOW).or).toBeCloseTo(4);
  });
});

describe('parseMeminfo', () => {
  const RAW = [
    'MemTotal:       32768000 kB',
    'MemFree:         4096000 kB',
    'MemAvailable:   12288000 kB',
    'Buffers:          512000 kB',
    'Cached:          8192000 kB',
    'SwapTotal:       2097152 kB',
    'SwapFree:        1048576 kB',
  ].join('\n');

  it('parsing + conversions kB→GB', () => {
    const m = parseMeminfo(RAW, GB);
    expect(m.total).toBe('31.25');
    expect(m.available).toBe('11.72');
    expect(m.usedByApps).toBe('19.53');   // total − available
    expect(m.cache).toBe('8.30');         // buffers + cached
    expect(m.swapUsed).toBe('1.00');
    expect(m.appsPct).toBe('62.5');
    expect(m.proxmoxPct).toBe('87.5');    // (total − free) / total
  });

  it('champ manquant → 0, pas de crash', () => {
    const m = parseMeminfo('MemTotal: 1048576 kB\n', GB);
    expect(m.free).toBe('0.00');
    expect(m.appsPct).toBe('100.0');
  });
});

describe('formatUptime', () => {
  it('jours / heures / minutes', () => {
    expect(formatUptime(29 * 86400 + 16 * 3600 + 36 * 60)).toBe('29j 16h 36m');
    expect(formatUptime(5 * 3600 + 10 * 60)).toBe('5h 10m');
    expect(formatUptime(90 * 60)).toBe('1h 30m');
  });
});
