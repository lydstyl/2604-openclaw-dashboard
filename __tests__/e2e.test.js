// Test e2e smoke — boot complet de l'app (node index.js) sur un port de test,
// vérifie que la page et les endpoints répondent. Ne touche pas l'état prod :
// le dernier point credits_history datant de < 4 h, aucun point n'est écrit.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3093;
const BASE = `http://127.0.0.1:${PORT}`;

let proc = null;

async function waitForServer(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE}/api/credits-history`);
      if (r.status === 200) return;
    } catch (e) { /* pas encore up */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('serveur de test pas up après 30 s');
}

beforeAll(async () => {
  proc = spawn('node', ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  await waitForServer();
});

afterAll(() => {
  if (proc) proc.kill('SIGTERM');
});

describe('e2e smoke', () => {
  it('GET / → 200 + page Dashboard', async () => {
    const r = await fetch(`${BASE}/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<title>Dashboard</title>');
    expect(html).toContain('<!DOCTYPE html>');
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.headers.get('cache-control')).toContain('no-store');
  });

  it('GET /dashboard → même page (alias rewrite)', async () => {
    const r = await fetch(`${BASE}/dashboard`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<title>Dashboard</title>');
  });

  it('GET /api/credits-history → 200 + tableau', async () => {
    const r = await fetch(`${BASE}/api/credits-history`);
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /sortable.min.js → 200 (asset local)', async () => {
    const r = await fetch(`${BASE}/sortable.min.js`);
    expect(r.status).toBe(200);
  });

  it('GET inconnu → 404', async () => {
    const r = await fetch(`${BASE}/api/this-does-not-exist`);
    expect(r.status).toBe(404);
  });
});

// Routes API locales (lues via __dirname/data, sans I/O réseau) — e2e hôte.
// Les routes /app/... et /host/... (llm-speed, pc-task-history, watchdog) sont
// conteneur-only (mounts) → testées via l'instance dev, pas ici.
describe('e2e — routes API locales', () => {
  it('GET /api/card-visibility → 200 + objet', async () => {
    const r = await fetch(`${BASE}/api/card-visibility`);
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(typeof data).toBe('object');
    expect(Array.isArray(data)).toBe(false);
  });

  it('GET /api/card-order → 200 + { ok, order: [] }', async () => {
    const r = await fetch(`${BASE}/api/card-order`);
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.order)).toBe(true);
  });

  it('GET /api/links → 200 + { ok, links: [] }', async () => {
    const r = await fetch(`${BASE}/api/links`);
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.links)).toBe(true);
  });

  it('GET /api/energy-prices → 200 + { ok: true }', async () => {
    const r = await fetch(`${BASE}/api/energy-prices`);
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(data.ok).toBe(true);
  });

  it('GET /api/top-processes → 200 + JSON', async () => {
    const r = await fetch(`${BASE}/api/top-processes`);
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(data).toBeTruthy();
  });
});
