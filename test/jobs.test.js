'use strict';

// Proje çalıştırıcı: tarama, çakışan çıktı adları, eşzamanlılık sınırı, seçim, durdurma, değişen kaynak, silme

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const media = require('../src/media');
const { ProjectRunner } = require('../src/jobs');
const { createSpeech } = require('../src/speech');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvm-jobs-'));
const src = path.join(dir, 'kaynak');
const user = path.join(dir, 'user');
process.env.CVM_WHISPER_CLI = path.join(__dirname, 'fake-whisper.js');

test('klasör projesi uçtan uca', async () => {
  fs.mkdirSync(path.join(src, 'alt', 'derin'), { recursive: true });
  for (const [f, d] of [['a.wav', 3], ['a.flac', 2], ['alt/b.wav', 5], ['alt/derin/c.mp3', 2]]) {
    await media.runFfmpeg(['-f', 'lavfi', '-i', `sine=duration=${d}`, path.join(src, f)]);
  }
  fs.writeFileSync(path.join(src, 'not.txt'), 'x');
  fs.mkdirSync(path.join(user, 'models'), { recursive: true });
  fs.writeFileSync(path.join(user, 'models', 'ggml-base.bin'), 'x');

  const project = { id: 'p', type: 'audio', sourceExts: ['wav', 'flac', 'mp3'], targetExt: 'mp3', sourceMode: 'folder', includeSubfolders: true,
    concurrency: 2, speech: { enabled: true, model: 'base', language: 'auto' }, options: { audio: { bitrate: '128' } } };
  const local = { sourcePath: src, unchecked: [] };
  const events = [];
  let maxActive = 0;
  const r = new ProjectRunner('p', {
    userDataDir: user, getProject: () => project, getLocal: () => local, getSettings: () => ({ speechConcurrency: 1 }),
    speech: createSpeech({ userDataDir: user }), errText: (e) => e.message,
    send: (ch, d) => { events.push(ch); if (ch === 'job:state') maxActive = Math.max(maxActive, d.counts.active); },
  });
  const snap = await r.scan();
  assert.deepStrictEqual(snap.files.map((f) => f.rel), ['a.flac', 'a.wav', 'alt/b.wav', 'alt/derin/c.mp3']);
  // a.wav ve a.flac aynı klasörde: çıktıları ayrışır
  assert.ok(r.outPath('a.wav').endsWith(path.join('p', 'a_wav.mp3')));
  assert.ok(r.outPath('alt/derin/c.mp3').endsWith(path.join('p', 'alt', 'derin', 'c.mp3')));

  local.unchecked = ['alt/derin/c.mp3'];
  r.onSelectionChanged();
  const done = new Promise((res) => { const iv = setInterval(() => { if (events.includes('job:finished')) { clearInterval(iv); res(); } }, 50); });
  r.start();
  await done;
  assert.ok(maxActive <= 2 && maxActive >= 1, `eşzamanlı ${maxActive}`);
  const st = r.snapshot();
  const by = Object.fromEntries(st.files.map((f) => [f.rel, f]));
  assert.strictEqual(by['a.wav'].status, 'done');
  assert.strictEqual(by['alt/b.wav'].status, 'done');
  assert.strictEqual(by['alt/derin/c.mp3'].status, 'pending', 'seçilmeyen dosya dönüştürülmez');
  assert.strictEqual(by['alt/b.wav'].speech.status, 'done');
  assert.strictEqual(by['alt/b.wav'].speech.count, 2);
  assert.ok(fs.existsSync(r.outPath('alt/b.wav')));
  const tr = await r.transcript('alt/b.wav');
  assert.strictEqual(tr.segments[0].lang, 'tr');

  // Kaynak değişince sonuç geçersiz olur
  await new Promise((res) => setTimeout(res, 20));
  await media.runFfmpeg(['-f', 'lavfi', '-i', 'sine=duration=1', path.join(src, 'a.wav')]);
  const s2 = await r.scan();
  assert.strictEqual(s2.files.find((f) => f.rel === 'a.wav').status, 'pending');

  // Durum diske yazılır ve yeni çalıştırıcı okur
  r.saveNow();
  const r2 = new ProjectRunner('p', { userDataDir: user, getProject: () => project, getLocal: () => local, getSettings: () => ({}), speech: null, errText: String, send: () => {} });
  await r2.scan();
  assert.strictEqual(r2.snapshot().files.find((f) => f.rel === 'alt/b.wav').status, 'done');

  // Çevrilmiş dosyaları sil
  await r.deleteOutputs({});
  assert.ok(!fs.existsSync(r.outDir));
  assert.strictEqual(r.snapshot().files.find((f) => f.rel === 'alt/b.wav').status, 'pending');
  assert.strictEqual(r.snapshot().files.find((f) => f.rel === 'alt/b.wav').speech.status, 'done', 'metinler istenmedikçe kalır');
  r.close();
});

test('durdur: süren işler iptal edilir ve bekliyor durumuna döner', async () => {
  const big = path.join(dir, 'uzun');
  fs.mkdirSync(big, { recursive: true });
  await media.runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=20', '-c:v', 'libx264', '-preset', 'ultrafast', path.join(big, 'v.mp4')]);
  const project = { id: 'q', type: 'video', sourceExts: ['mp4'], targetExt: 'webm', sourceMode: 'file', concurrency: 1, options: { video: { quality: 'high', speed: 'slow' } } };
  const local = { sourcePath: path.join(big, 'v.mp4') };
  const r = new ProjectRunner('q', { userDataDir: user, getProject: () => project, getLocal: () => local, getSettings: () => ({}), speech: null, errText: String, send: () => {} });
  await r.scan();
  r.start();
  await new Promise((res) => setTimeout(res, 800));
  assert.strictEqual(r.snapshot().files[0].status, 'converting');
  r.stop();
  await new Promise((res) => setTimeout(res, 500));
  assert.strictEqual(r.snapshot().files[0].status, 'pending');
  assert.ok(!fs.readdirSync(r.outDir).some((n) => n.includes('cvmtmp')), 'yarım dosya kalmaz');
  r.close();
});
