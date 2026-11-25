// Tests unitaires — lib/pc.js (historique tâches par PC 30 j, logique pure)
import { describe, it, expect } from 'vitest';
import { computePcTaskHistory, buildPcHistoryCardBody } from '../lib/pc';

const day = 24 * 3600 * 1000;

function makeDoc() {
  const now = Date.now();
  return {
    schema: 'pc-task-history/v1',
    generated_at: new Date(now - 3600e3).toISOString(),
    window_days: 30,
    energy_price_eur_kwh: 0.25,
    pcs: {
      luna: {
        label: 'PC Marie',
        host: '192.168.3.57',
        power_w: { working: 100 },
        events: [
          { start: new Date(now - 1 * day).toISOString(), dur_s: 3600, task_id: 't1', name: 'Tâche 1' },
          { start: new Date(now - 2 * day).toISOString(), dur_s: 1800, task_id: 't1', name: 'Tâche 1' },
          { start: new Date(now - 3 * day).toISOString(), dur_s: 600, task_id: 't2', name: 'Tâche 2' },
        ],
      },
    },
  };
}

describe('computePcTaskHistory', () => {
  it('métriques 30 j : tâches uniques, runs, heures, énergie, coût', () => {
    const h = computePcTaskHistory(makeDoc(), new Date());
    const m = h.pcs.luna.metrics;
    expect(m.tasks_30d).toBe(2);          // t1 + t2 (t1 compté une seule fois)
    expect(m.runs_30d).toBe(3);
    expect(m.work_hours_30d).toBe(1.67);  // 3600+1800+600 = 6000s
    expect(m.idle_hours_30d).toBe(718.33);
    expect(m.energy_kwh_30d).toBe(0.167); // 100W × 6000s / 3600 / 1000
    expect(m.cost_eur_30d).toBe(0.042);   // 0.167 × 0.25
    expect(m.last_task_name).toBe('Tâche 1');
    expect(h.pcs.luna.events_30d.length).toBe(3);
    expect(h.window_days).toBe(30);
    expect(h.energy_price_eur_kwh).toBe(0.25);
  });

  it('events hors fenêtre exclus', () => {
    const doc = makeDoc();
    doc.pcs.luna.events.push({ start: new Date(Date.now() - 60 * day).toISOString(), dur_s: 99999, task_id: 'told', name: 'vieille' });
    const h = computePcTaskHistory(doc, new Date());
    expect(h.pcs.luna.metrics.runs_30d).toBe(3);
    expect(h.pcs.luna.metrics.tasks_30d).toBe(2);
  });

  it('fenêtre personnalisée (window_days)', () => {
    const doc = makeDoc();
    doc.window_days = 2;
    const h = computePcTaskHistory(doc, new Date());
    expect(h.window_days).toBe(2);
    expect(h.pcs.luna.metrics.runs_30d).toBe(2); // l'événement de 3 j est hors fenêtre
  });

  it('pcs absent → vide', () => {
    const h = computePcTaskHistory({}, new Date());
    expect(h.pcs).toEqual({});
  });
});

describe('buildPcHistoryCardBody', () => {
  it('null → note indisponible', () => {
    expect(buildPcHistoryCardBody(null)).toContain('indisponible');
  });

  it('carte complète', () => {
    const h = computePcTaskHistory(makeDoc(), new Date());
    const html = buildPcHistoryCardBody(h);
    expect(html).toContain('PC Marie');
    expect(html).toContain('luna');
    expect(html).toContain('100 W');
    expect(html).toContain('Tâches 30 j');
    expect(html).toContain('2');
    expect(html).toContain('Tâche 1');
    expect(html).toContain('€/kWh');
    expect(html).toContain('pcHistoryPie'); // canvas camembert
  });

  it('aucun PC → note', () => {
    const html = buildPcHistoryCardBody(computePcTaskHistory({}, new Date()));
    expect(html).toContain('Aucun PC');
  });
});
