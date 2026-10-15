'use strict';

// Konuşma modülü (whisper-cli taklidiyle): WAV dilimleme, tek geçiş ve 30 sn pencereli dil algılama, dışa aktarım

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const media = require('../src/media');
const { createSpeech, exportTranscript } = require('../src/speech');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvm-speech-'));
process.env.CVM_WHISPER_CLI = path.join(__dirname, 'fake-whisper.js');
const speech = createSpeech({ userDataDir: dir, fetch: () => { throw new Error('ağ yok'); } });
fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
fs.writeFileSync(path.join(dir, 'models', 'ggml-base.bin'), 'x');

test('tek geçiş: segmentler ve dil', async () => {
  const wav = path.join(dir, 'work', 's1.wav');
  await media.extractSpeechWav(await sine(10), wav);
  let last = 0;
  const r = await speech.transcribe({ wav, model: 'base', duration: 10, onProgress: (p) => (last = p) });
  assert.strictEqual(r.language, 'tr');
  assert.strictEqual(r.segments.length, 3);
  assert.deepStrictEqual(r.segments[1], { start: 4, end: 8, lang: 'tr', text: 'Cümle 2 (4 sn).' });
  assert.strictEqual(last, 1);
});

test('pencereli: 70 sn → 3 pencere, zamanlar mutlak', async () => {
  const wav = path.join(dir, 'work', 's2.wav');
  await media.extractSpeechWav(await sine(70), wav);
  const r = await speech.transcribe({ wav, model: 'base', duration: 70, perWindow: true });
  const starts = r.segments.map((s) => s.start);
  assert.ok(starts.includes(30) && starts.includes(60), starts.join(','));
  assert.ok(Math.max(...r.segments.map((s) => s.end)) <= 70.1);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'work')).filter((n) => /^w\d+\.wav$/.test(n)), []);
});

test('model yoksa ve ağ yoksa anlamlı hata', async () => {
  await assert.rejects(speech.transcribe({ wav: path.join(dir, 'work', 's1.wav'), model: 'small', duration: 10 }));
  assert.strictEqual(speech.status().models.base.installed, true);
  assert.strictEqual(speech.status().models.small.installed, false);
});

test('dışa aktarım biçimleri', () => {
  const segs = [{ start: 1.5, end: 3.25, lang: 'tr', text: 'Merhaba "dünya"' }, { start: 3661, end: 3662, lang: 'en', text: 'Hi' }];
  assert.match(exportTranscript(segs, 'srt'), /^1\n00:00:01,500 --> 00:00:03,250\nMerhaba "dünya"\n/);
  assert.match(exportTranscript(segs, 'vtt'), /^WEBVTT\n\n00:00:01\.500 --> 00:00:03\.250/);
  assert.match(exportTranscript(segs, 'csv'), /1\.50;tr;"Merhaba ""dünya"""/);
  assert.match(exportTranscript(segs, 'txt'), /\[01:01:01\] \(en\) Hi/);
  assert.deepStrictEqual(JSON.parse(exportTranscript(segs, 'json')), segs);
});

async function sine(sec) {
  const f = path.join(dir, `sine${sec}.wav`);
  if (!fs.existsSync(f)) await media.runFfmpeg(['-f', 'lavfi', '-i', `sine=duration=${sec}`, f]);
  return f;
}
