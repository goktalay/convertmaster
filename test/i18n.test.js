'use strict';

// Sözlük eşliği: her dilde aynı anahtarlar ve aynı yer tutucular; kodda kullanılan anahtarlar mevcut

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const I18N = require('../src/i18n');
const FORMATS = require('../src/formats');

const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('Mastertool dil sırası', () => {
  assert.deepStrictEqual(Object.keys(I18N.LANGUAGES), ['tr', 'en', 'fr', 'de', 'es', 'ar', 'zh', 'ru']);
  assert.strictEqual(I18N.LANGUAGES.ar.dir, 'rtl');
});

test('her dilde aynı anahtarlar ve yer tutucular', () => {
  const en = I18N.STRINGS.en;
  for (const lang of Object.keys(I18N.LANGUAGES)) {
    const d = I18N.STRINGS[lang];
    assert.deepStrictEqual(Object.keys(d).sort(), Object.keys(en).sort(), `${lang} anahtarları`);
    for (const k of Object.keys(en)) assert.strictEqual(ph(d[k]), ph(en[k]), `${lang} ${k}`);
  }
});

test('kodda kullanılan anahtarlar sözlükte var', () => {
  const dir = path.join(__dirname, '..', 'src');
  const files = [path.join(dir, 'main.js'), ...fs.readdirSync(path.join(dir, 'renderer')).filter((f) => /\.(js|html)$/.test(f)).map((f) => path.join(dir, 'renderer', f))];
  const keys = new Set();
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
    for (const m of s.matchAll(/data-t="([a-zA-Z0-9_.]+)"/g)) keys.add(m[1]);
  }
  for (const q of FORMATS.QUALITY) keys.add(`out.q.${q}`);
  for (const m of Object.keys(FORMATS.SPEECH_MODELS)) keys.add(`speech.model.${m}`);
  for (const ty of Object.keys(FORMATS.TYPES)) ['', 'Hint', 'All'].forEach((x) => keys.add(`type.${ty}${x}`));
  const missing = [...keys].filter((k) => !(k in I18N.STRINGS.en));
  assert.deepStrictEqual(missing, []);
});

test('sistem dili çözümü', () => {
  assert.strictEqual(I18N.resolveLanguage('tr-TR'), 'tr');
  assert.strictEqual(I18N.resolveLanguage('pt-BR'), 'en');
  assert.strictEqual(I18N.createT('xx')('common.save'), 'Save');
});
