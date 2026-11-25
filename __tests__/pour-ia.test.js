// Tests unitaires — lib/pour-ia.js (carte GTD Pour IA, logique pure)
import { describe, it, expect } from 'vitest';
import {
  POUR_IA_AGENTS, POUR_IA_API_AGENTS,
  normalizePourIAAgent, pourIAEstimateFromDoc,
  piaTargetBadge, piaModeBadge, piaAgentRowHtml, piaAgentsGroupedHtml, buildPourIACardBody,
} from '../lib/pour-ia';

describe('constantes', () => {
  it('agents locaux + API', () => {
    expect(POUR_IA_AGENTS).toEqual(['luna', 'harry', 'ron', 'dobby', 'dsh']);
    expect(POUR_IA_API_AGENTS).toEqual(['hermione']);
  });
});

describe('normalizePourIAAgent', () => {
  it('entrée complète', () => {
    const a = normalizePourIAAgent({ key: 'luna', status: 'running', task: 'Tâche A' });
    expect(a).toEqual({ key: 'luna', disp: 'Luna', status: 'running', task: 'Tâche A', api: false, from_json: true });
  });
  it('statut inconnu → idle, champs manquants → défauts', () => {
    const a = normalizePourIAAgent({ agent: 'ron' });
    expect(a.status).toBe('idle');
    expect(a.task).toBe('');
    expect(a.disp).toBe('Ron');
  });
  it('agent API (hermione) → api: true', () => {
    expect(normalizePourIAAgent({ key: 'hermione' }).api).toBe(true);
  });
  it('sans key → null', () => {
    expect(normalizePourIAAgent({})).toBeNull();
    expect(normalizePourIAAgent(null)).toBeNull();
  });
});

describe('piaTargetBadge', () => {
  it('target explicite', () => {
    expect(piaTargetBadge({ target: 'luna' })).toContain('→ Luna');
    expect(piaTargetBadge({ target: 'LUNA' })).toContain('→ Luna'); // normalisé
  });
  it('auto / absent → → auto', () => {
    expect(piaTargetBadge({ target: 'auto' })).toContain('→ auto');
    expect(piaTargetBadge({})).toContain('→ auto');
  });
  it('déduit depuis les tags agent-*', () => {
    expect(piaTargetBadge({ tags: ['agent-ron'] })).toContain('→ Ron');
    expect(piaTargetBadge({ tags: ['agent-r', 'agent-ron'] })).toContain('→ R'); // 1er tag agent-*
  });
  it('agent inconnu → suffixe (API)', () => {
    expect(piaTargetBadge({ target: 'zorro' })).toContain('Zorro (API)');
  });
});

describe('piaModeBadge', () => {
  it('plan / rapide', () => {
    expect(piaModeBadge({ mode: 'plan' })).toContain('pia-mode-plan');
    expect(piaModeBadge({ mode: 'rapide' })).toContain('pia-mode-rapide');
  });
  it('déduit des tags', () => {
    expect(piaModeBadge({ tags: ['mode-rapide'] })).toContain('rapide');
  });
  it('mode auto → vide', () => {
    expect(piaModeBadge({ mode: 'auto' })).toBe('');
    expect(piaModeBadge({})).toBe('');
  });
});

describe('piaAgentRowHtml', () => {
  it('agent running avec tâche', () => {
    const h = piaAgentRowHtml({ key: 'luna', disp: 'Luna', status: 'running', task: 'Tâche <X>' });
    expect(h).toContain('pia-st-running');
    expect(h).toContain('Tâche &lt;X&gt;'); // échappée
    expect(h).toContain('⏸ pause');
  });
  it('agent API → pas de bouton pause', () => {
    const h = piaAgentRowHtml({ key: 'hermione', disp: 'Hermione', status: 'idle', api: true });
    expect(h).toContain('API');
    expect(h).not.toContain('⏸ pause');
  });
});

describe('piaAgentsGroupedHtml (regroupement par PC)', () => {
  it('PC Marie (luna + dsh) → en-tête PC + 2 tâches en cours', () => {
    const agents = [
      { key: 'luna', disp: 'Luna', status: 'running', task: 'Tâche A' },
      { key: 'harry', disp: 'Harry', status: 'idle', task: '' },
      { key: 'dsh', disp: 'DSH', status: 'running', task: 'Tâche B' },
      { key: 'hermione', disp: 'Hermione', status: 'idle', task: '', api: true },
    ];
    const h = piaAgentsGroupedHtml(agents);
    expect(h).toContain('PC Marie');
    expect(h).toContain('2 tâches en cours');
    expect(h).toContain('Tâche A');
    expect(h).toContain('Tâche B');
    // PC mono-agent (harry) et agent API → pas d'en-tête PC
    expect(h).not.toContain('PC Gabriel');
    expect(h).not.toContain('PC Hermione');
    // Les deux lignes agents de Marie restent présentes
    expect(h).toContain('Luna');
    expect(h).toContain('DSH');
  });
  it('1 seule tâche en cours sur le PC → « 1 tâche en cours »', () => {
    const h = piaAgentsGroupedHtml([
      { key: 'luna', disp: 'Luna', status: 'running', task: 'Tâche A' },
      { key: 'dsh', disp: 'DSH', status: 'idle', task: '' },
    ]);
    expect(h).toContain('PC Marie');
    expect(h).toContain('1 tâche en cours');
  });
  it('0 tâche en cours sur le PC → pas de badge de comptage', () => {
    const h = piaAgentsGroupedHtml([
      { key: 'luna', disp: 'Luna', status: 'idle', task: '' },
      { key: 'dsh', disp: 'DSH', status: 'paused', task: '' },
    ]);
    expect(h).toContain('PC Marie');
    expect(h).not.toContain('tâche en cours');
  });
});

describe('pourIAEstimateFromDoc', () => {
  const day = 24 * 3600 * 1000;
  const now = Date.now();
  it('médiane des 100 dernières durées', () => {
    const doc = { pcs: { luna: { events: [
      { start: new Date(now - 1 * day).toISOString(), dur_s: 600 },
      { start: new Date(now - 2 * day).toISOString(), dur_s: 1200 },
      { start: new Date(now - 3 * day).toISOString(), dur_s: 1800 },
    ] } } };
    expect(pourIAEstimateFromDoc(doc)).toEqual({ median_min: 20, n: 3 }); // médiane 1200s
  });
  it('pas de luna / pas d\'events → null', () => {
    expect(pourIAEstimateFromDoc({ pcs: {} })).toBeNull();
    expect(pourIAEstimateFromDoc({ pcs: { luna: { events: [] } } })).toBeNull();
    expect(pourIAEstimateFromDoc({})).toBeNull();
  });
  it('events sans durée ignorés', () => {
    const doc = { pcs: { luna: { events: [{ start: new Date(now - day).toISOString(), dur_s: 0 }] } } };
    expect(pourIAEstimateFromDoc(doc)).toBeNull();
  });
});

describe('buildPourIACardBody', () => {
  const pourIA = {
    tasks: [{ name: 'Tâche A', importance: 300, note: '<p>note <b>gras</b></p>' }],
    working: [],
    pending: 1,
    paused: [],
    agents: [{ key: 'luna', disp: 'Luna', status: 'running', task: 'Tâche A', api: false }],
    updated_at: '2026-11-19T12:00:00Z',
  };
  it('carte complète avec agents du JSON', () => {
    const h = buildPourIACardBody(pourIA, null);
    expect(h).toContain('1');
    expect(h).toContain('tâche(s) en attente');
    expect(h).toContain('Tâche A');
    expect(h).toContain('Luna');
    expect(h).toContain('pia-st-running');
    expect(h).toContain('imp 300');
    expect(h).not.toContain('≈'); // pas d'ETA sans est
  });
  it('ETA avec estimate', () => {
    const h = buildPourIACardBody({ ...pourIA, pending: 2 }, { median_min: 10, n: 5 });
    expect(h).toContain('≈ 0,3 h'); // 2 × 10 min (locale fr)
  });
  it('file vide', () => {
    const h = buildPourIACardBody({ tasks: [], working: [], pending: 0, paused: [], agents: [], updated_at: null }, null);
    expect(h).toContain('File vide');
    expect(h).toContain('jamais mis à jour');
  });
  it('fallback agents déduits des locks (pas de `agents`)', () => {
    const h = buildPourIACardBody({ tasks: [], working: [], pending: 0, paused: ['LUNA'], cooldown: [] }, null);
    for (const a of ['LUNA', 'HARRY', 'RON', 'DOBBY', 'DSH']) {
      expect(h).toContain(a);
    }
    expect(h).toContain('⏸ pause'); // LUNA pausé → badge pause
  });
  it('carte complète : PC Marie regroupe luna + dsh (2 tâches en cours)', () => {
    const h = buildPourIACardBody({
      ...pourIA,
      agents: [
        { key: 'luna', disp: 'Luna', status: 'running', task: 'Tâche A', api: false },
        { key: 'harry', disp: 'Harry', status: 'idle', task: '', api: false },
        { key: 'ron', disp: 'Ron', status: 'idle', task: '', api: false },
        { key: 'dobby', disp: 'Dobby', status: 'idle', task: '', api: false },
        { key: 'dsh', disp: 'DSH', status: 'running', task: 'Tâche B', api: false },
      ],
    }, null);
    expect(h).toContain('PC Marie');
    expect(h).toContain('2 tâches en cours');
    expect(h).toContain('Tâche A');
    expect(h).toContain('Tâche B');
  });
});
