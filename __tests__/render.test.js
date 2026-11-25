// Tests unitaires — lib/render.js (briques de rendu pur)
import { describe, it, expect } from 'vitest';
import { escHtml, bar, cpuColor, ramColor, diskColor, creditColor, tag, wmo, WMO_MAP } from '../lib/render';

describe('escHtml', () => {
  it('échappe & < > "', () => {
    expect(escHtml('<b>&"x"</b>')).toBe('&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
  });
  it('accepte un non-objet', () => {
    expect(escHtml(42)).toBe('42');
    expect(escHtml(null)).toBe('null');
  });
});

describe('bar', () => {
  it('largeur bornée 0..100', () => {
    expect(bar(50, '#fff')).toContain('width:50%');
    expect(bar(150, '#fff')).toContain('width:100%');
    expect(bar(-5, '#fff')).toContain('width:0%');
  });
  it('fond optionnel (cache)', () => {
    expect(bar(50, '#fff', 20)).toContain('bar-cache');
    expect(bar(50, '#fff')).not.toContain('bar-cache');
  });
});

describe('couleurs seuils', () => {
  it('cpu / ram / disk', () => {
    expect(cpuColor(49)).toBe('#4ade80');
    expect(cpuColor(79)).toBe('#facc15');
    expect(cpuColor(81)).toBe('#f87171');
    expect(ramColor(49)).toBe('#4ade80');
    expect(ramColor(74)).toBe('#facc15');
    expect(ramColor(75)).toBe('#f87171');
    expect(diskColor(60)).toBe('#facc15');
    expect(diskColor(85)).toBe('#f87171');
  });
  it('creditColor', () => {
    expect(creditColor('5')).toBe('#4ade80');
    expect(creditColor('1')).toBe('#facc15');
    expect(creditColor('0.1')).toBe('#f87171');
    expect(creditColor('n/a')).toBe('#6b7280');
  });
});

describe('tag', () => {
  it('3 états', () => {
    expect(tag(true, true, 'A', 'B', 'C')).toContain('tag-green');
    expect(tag(false, true, 'A', 'B', 'C')).toContain('tag-yellow');
    expect(tag(false, false, 'A', 'B', 'C')).toContain('tag-red');
  });
});

describe('wmo', () => {
  it('codes connus', () => {
    expect(wmo(0)).toEqual(['☀️', 'Ensoleillé']);
    expect(wmo(61)).toEqual(['🌧️', 'Pluie faible']);
    expect(wmo(95)).toEqual(['⛈️', 'Orage']);
  });
  it('code inconnu → ❓', () => {
    expect(wmo(999)).toEqual(['❓', 'Inconnu']);
  });
  it('WMO_MAP couvre les codes standard', () => {
    for (const c of [0, 1, 2, 3, 45, 51, 61, 63, 65, 71, 73, 80, 95, 96, 99]) {
      expect(WMO_MAP[c]).toBeDefined();
    }
  });
});
