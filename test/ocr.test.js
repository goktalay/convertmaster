'use strict';

// Resimden metin (OCR): gerçek Tesseract ile okuma; resim projesinde OCR açıkken çalışır, kapalıyken hiç çalışmaz

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { createOcr, exportOcr } = require('../src/ocr');
const { ProjectRunner } = require('../src/jobs');

// Dil verileri ağdan değil, geliştirme bağımlılığı @tesseract.js-data paketinden
process.env.CVM_OCR_LANG_BASE = path.join(__dirname, '..', 'node_modules', '@tesseract.js-data');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvm-ocr-'));
const noNet = () => { throw new Error('ağ yok'); };

async function textImage(file, lines) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${60 + lines.length * 80}"><rect width="100%" height="100%" fill="#fff"/>${lines
    .map((l, i) => `<text x="30" y="${80 + i * 80}" font-family="DejaVu Sans, Arial, sans-serif" font-size="44">${l}</text>`).join('')}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

test('Türkçe metin satır satır okunur', async () => {
  const img = path.join(dir, 'a.png');
  await textImage(img, ['Merhaba Dünya, nasılsınız?', 'Öğrenci Çiçek ışığı gördü.']);
  const ocr = createOcr({ userDataDir: path.join(dir, 'ud'), download: noNet });
  let last = 0;
  const r = await ocr.recognize(img, { langs: ['tur', 'eng'], workDir: path.join(dir, 'w'), onProgress: (p) => (last = p) });
  await ocr.close();
  assert.strictEqual(r.lines.length, 2);
  assert.match(r.lines[0].text, /Merhaba Dünya/);
  assert.match(r.lines[1].text, /Öğrenci Çiçek/);
  assert.ok(r.lines[0].conf > 70 && r.lines[0].bbox.x1 > r.lines[0].bbox.x0);
  assert.strictEqual(r.width, 1000);
  assert.ok(last > 0.9);
  assert.strictEqual(ocr.status().langs.tur.installed, true);
  assert.match(exportOcr(r, 'csv'), /^﻿line;confidence;text\r\n1;\d+;"Merhaba/);
  assert.strictEqual(fs.readdirSync(path.join(dir, 'w')).length, 0, 'geçici PNG silinir');
});

test('indirilmemiş dil ve ağ yoksa anlamlı hata', async () => {
  const ocr = createOcr({ userDataDir: path.join(dir, 'ud2'), download: noNet });
  process.env.CVM_OCR_LANG_BASE = 'https://example.invalid';
  await assert.rejects(ocr.recognize(path.join(dir, 'a.png'), { langs: ['deu'], workDir: path.join(dir, 'w2') }));
  process.env.CVM_OCR_LANG_BASE = path.join(__dirname, '..', 'node_modules', '@tesseract.js-data');
});

async function runProject(ocrEnabled) {
  const src = path.join(dir, `src-${ocrEnabled}`);
  fs.mkdirSync(src, { recursive: true });
  await textImage(path.join(src, 'afis.png'), ['Kampanya 2026', 'Yüzde elli indirim']);
  await sharp({ create: { width: 300, height: 200, channels: 3, background: '#3b82f6' } }).png().toFile(path.join(src, 'bos.png'));
  const project = { id: `p${ocrEnabled}`, type: 'image', sourceExts: ['png'], targetExt: 'webp', sourceMode: 'folder', includeSubfolders: true, concurrency: 2,
    ocr: { enabled: ocrEnabled, languages: ['tur'] }, speech: { enabled: true }, options: { image: { quality: 80 } } };
  const events = [];
  const user = path.join(dir, `user-${ocrEnabled}`);
  const ocr = createOcr({ userDataDir: user, download: noNet });
  const r = new ProjectRunner(project.id, {
    userDataDir: user, getProject: () => project, getLocal: () => ({ sourcePath: src, unchecked: [] }), getSettings: () => ({ speechConcurrency: 1 }),
    speech: null, ocr, errText: (e) => e.message, send: (ch) => events.push(ch),
  });
  await r.scan();
  const done = new Promise((res) => { const iv = setInterval(() => { if (events.includes('job:finished')) { clearInterval(iv); res(); } }, 50); });
  r.start();
  await done;
  const snap = r.snapshot();
  const tr = await r.transcript('afis.png');
  r.close();
  await ocr.close();
  return { snap, tr, user };
}

test('resim projesi: OCR açık → metin okunur, metinsiz resim "metin yok"', async () => {
  const { snap, tr, user } = await runProject(true);
  const by = Object.fromEntries(snap.files.map((f) => [f.rel, f]));
  assert.strictEqual(by['afis.png'].status, 'done');
  assert.strictEqual(by['afis.png'].speech.status, 'done');
  assert.strictEqual(by['afis.png'].speech.count, 2);
  assert.strictEqual(by['bos.png'].speech.status, 'none');
  assert.strictEqual(tr.kind, 'ocr');
  assert.match(tr.text, /Kampanya 2026/);
  assert.ok(fs.existsSync(path.join(user, 'work', 'ptrue', 'ocr')));
});

test('resim projesi: OCR kapalı → yalnız dönüştürülür, metin adımı hiç çalışmaz', async () => {
  const { snap, user } = await runProject(false);
  for (const f of snap.files) {
    assert.strictEqual(f.status, 'done');
    assert.strictEqual(f.speech, null);
  }
  assert.ok(!fs.existsSync(path.join(user, 'ocr')), 'dil verisi bile indirilmez');
});
