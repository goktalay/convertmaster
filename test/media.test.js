'use strict';

// Dönüştürme motoru: ffmpeg çıktısı ayrıştırma, argümanlar ve gerçek küçük dönüşümler

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const media = require('../src/media');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvm-media-'));
const ff = (args) => media.runFfmpeg(args);

test('probe ayrıştırma', () => {
  const s = `Input #0, matroska,webm, from 'a.mkv':
  Duration: 00:01:02.50, start: 0.000000, bitrate: 1234 kb/s
  Stream #0:0(eng): Video: h264 (High), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 29.97 fps, 29.97 tbr
  Stream #0:1(tur): Audio: aac (LC), 48000 Hz, stereo, fltp (default)`;
  const p = media.parseProbe(s);
  assert.strictEqual(p.duration, 62.5);
  assert.deepStrictEqual(p.video, { codec: 'h264', width: 1920, height: 1080, fps: 29.97 });
  assert.strictEqual(p.audio.sampleRate, 48000);
  assert.strictEqual(p.audio.channels, 'stereo');
});

test('video → mp4 (480p) ilerleme bildirir, mp3 çıkarır, gif üretir', async () => {
  const src = path.join(dir, 'v.mkv');
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', src]);
  let last = 0;
  const out = path.join(dir, 'o', 'v.mp4');
  const r = await media.convert({ src, out, type: 'video', target: 'mp4', options: { video: { resolution: '480', quality: 'low', speed: 'veryfast' } }, onProgress: (p) => (last = p) });
  assert.ok(r.size > 0 && last > 0.5);
  const info = await media.probe(out);
  assert.strictEqual(info.video.height, 480);
  assert.strictEqual(info.audio.codec, 'aac');
  await media.convert({ src, out: path.join(dir, 'o', 'v.mp3'), type: 'video', target: 'mp3', options: { video: {} } });
  assert.strictEqual((await media.probe(path.join(dir, 'o', 'v.mp3'))).audio.codec, 'mp3');
  await media.convert({ src, out: path.join(dir, 'o', 'v.gif'), type: 'video', target: 'gif', options: { video: { resolution: '360' } } });
  assert.ok(fs.statSync(path.join(dir, 'o', 'v.gif')).size > 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'o')).filter((n) => n.includes('cvmtmp')), []);
});

test('resim: png → webp/avif/ico/bmp, bmp → jpg (sharp ve ffmpeg yolları)', async () => {
  const png = path.join(dir, 'i.png');
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=800x600', '-frames:v', '1', png]);
  const bmp = path.join(dir, 'i.bmp');
  await ff(['-i', png, bmp]);
  for (const [src, target] of [[png, 'webp'], [png, 'avif'], [png, 'ico'], [png, 'bmp'], [bmp, 'jpg'], [bmp, 'avif']]) {
    const out = path.join(dir, 'img', `${path.basename(src)}.${target}`);
    await media.convert({ src, out, type: 'image', target, options: { image: { quality: 80, maxWidth: 400 } } });
    const m = await media.mediaInfo(out);
    assert.ok(m.size > 0, target);
    assert.ok(m.video.width <= 400, `${target} genişlik ${m.video.width}`);
  }
});

test('ses: wav → opus 44.1 kHz isteğini 48 kHz yapar; iptal', async () => {
  const wav = path.join(dir, 'a.wav');
  await ff(['-f', 'lavfi', '-i', 'sine=duration=20', wav]);
  const out = path.join(dir, 'a.opus');
  await media.convert({ src: wav, out, type: 'audio', target: 'opus', options: { audio: { sampleRate: '44100', bitrate: '96' } } });
  assert.strictEqual((await media.probe(out)).audio.sampleRate, 48000);
  const ctl = new AbortController();
  const p = media.convert({ src: wav, out: path.join(dir, 'b.flac'), type: 'audio', target: 'flac', options: {}, signal: ctl.signal });
  ctl.abort();
  await assert.rejects(p, (e) => e.code === 'canceled');
});

test('hatalı tür: sesten video istenirse no_video', async () => {
  await assert.rejects(media.convert({ src: path.join(dir, 'a.wav'), out: path.join(dir, 'x.mp4'), type: 'video', target: 'mp4', options: {} }), (e) => e.code === 'no_video');
});
