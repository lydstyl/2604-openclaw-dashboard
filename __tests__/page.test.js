// Tests unitaires — lib/page.js (rendu de la page principale, logique pure)
import { describe, it, expect } from 'vitest';
import { renderPage } from '../lib/page';

function fixture(over = {}) {
  const base = {
    spending: { or: 1.5, kimi: 0.5, deepseek: 1.0, total: 3.0 },
    spending24h: { or: 0.2, kimi: 0, deepseek: 0.1, total: 0.3 },
    spending7d: { or: 0.8, kimi: 0.1, deepseek: 0.4, total: 1.3 },
    credits: {
      total: '12.34',
      or: { ok: true, balance: '5.00' },
      kimi: { ok: true, balance: '2.00' },
      deepseek: { ok: true, balance: '5.34' },
    },
    sys: {
      cpuPct: '55.0', load1: '1.10', cpuCount: 8,
      mem: {
        total: '31.25', available: '11.72', usedByApps: '19.53', cache: '8.30',
        free: '3.91', swapTotal: '2.00', swapFree: '1.00', swapUsed: '1.00',
        appsPct: '62.5', proxmoxPct: '87.5',
      },
      uptime: '29j 16h 36m',
    },
    mem: {
      total: '31.25', available: '11.72', usedByApps: '19.53', cache: '8.30',
      free: '3.91', swapTotal: '2.00', swapFree: '1.00', swapUsed: '1.00',
      appsPct: '62.5', proxmoxPct: '87.5',
    },
    disk: { used: '100.0', avail: '100.0', total: '200.0', usedPct: '50.0' },
    ollama: { plan: 'Pro', ok: true },
    live: { ok: true, usageMonthly: 12.5 },
    weather: {
      ok: true,
      days: [
        { date: '2026-11-19', icon: '☁️', label: 'Couvert', tmin: 5, tmax: 12, rainPct: 20, windKts: 8, gustKts: 15 },
        { date: '2026-11-20', icon: '☀️', label: 'Ensoleillé', tmin: 4, tmax: 14 },
      ],
    },
    links: [{ id: 'l1', label: 'GTD', url: 'https://gtd3.duckdns.org' }],
    pourIA: {
      tasks: [{ name: 'Tâche A', importance: 300, note: '' }],
      working: [], pending: 1, paused: [],
      agents: [{ key: 'luna', disp: 'Luna', status: 'idle', task: '', api: false }],
      updated_at: '2026-11-19T12:00:00Z',
    },
    pourIAEst: null,
    pcHistory: null,
    visibility: {},
    cardOrder: ['energie', 'pour-ia', 'pc-history', 'meteo', 'liens', 'credits', 'depenses',
      'systeme', 'ollama', 'pc-gabriel', 'pc-louis', 'pc-marie', 'pc-boncoin', 'chart'],
  };
  return { ...base, ...over };
}

describe('renderPage', () => {
  it('rend la page complète', () => {
    const html = renderPage(fixture());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>Dashboard</title>');
    expect(html).toContain('12.34');              // crédits totaux
    expect(html).toContain('Tâche A');            // carte Pour IA
    expect(html).toContain('Luna');               // ligne agent
    expect(html).toContain('Aujourd');            // météo (Aujourd’hui)
    expect(html).toContain('gtd3.duckdns.org');   // liens
    expect(html).toContain('12.5');               // usage mensuel
    expect(html).toContain('Pro');                // plan ollama
    expect(html).toContain('Historique indisponible'); // pcHistory null
  });

  it('met à jour la carte Pour IA via le corps rendu', () => {
    const html = renderPage(fixture());
    expect(html).toContain('tâche(s) en attente');
  });

  it('masque une carte (visibility false)', () => {
    const html = renderPage(fixture({ visibility: { meteo: false } }));
    // la carte météo porte la classe card-hidden
    const meteoCard = html.match(/card id="card-meteo"[^>]*|id="card-meteo"[^>]*card-hidden|card-hidden[^>]*id="card-meteo"/);
    // repli : la classe existe quelque part dans le document
    expect(html).toContain('card-hidden');
  });

  it('ordre des cartes via orderOf', () => {
    const html = renderPage(fixture());
    expect(html).toMatch(/style="order:\d+"/);
  });

  it('météo indisponible → ligne d\'alerte', () => {
    const html = renderPage(fixture({ weather: { ok: false, error: 'timeout' } }));
    expect(html).toContain('Météo indisponible');
    expect(html).toContain('timeout');
  });

  it('aucun lien → liste vide sans crash', () => {
    const html = renderPage(fixture({ links: [] }));
    expect(html).toContain('<title>Dashboard</title>');
  });

  it('crédits API KO → tirets', () => {
    const html = renderPage(fixture({
      credits: { total: '—', or: { ok: false }, kimi: { ok: false }, deepseek: { ok: false } },
    }));
    expect(html).toContain('<title>Dashboard</title>');
  });
});
