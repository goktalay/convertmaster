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

test('kalite ve boyut: en-boy oranı hesabı, hazır ayarlar, döndürülmüş telefon videosu', () => {
  const F = require('../src/formats');
  assert.deepStrictEqual(F.frameSize({ aspect: '9:16', resolution: '1080' }, 1920, 1080, true), { W: 1080, H: 1920 });
  assert.deepStrictEqual(F.frameSize({ aspect: '4:5', size: '1080' }, 4000, 3000), { W: 1080, H: 1350 });
  assert.deepStrictEqual(F.frameSize({ aspect: '16:9', resolution: 'source', rotate: '90' }, 1080, 1920, true), { W: 1920, H: 1080 });
  assert.deepStrictEqual(F.frameSize({ aspect: 'custom', width: 1001, height: 777 }, 0, 0, true), { W: 1002, H: 778 });
  assert.strictEqual(F.frameSize({ aspect: 'source' }, 100, 100), null);
  const web = F.applyPreset('image', { ...F.defaultOptions().image, aspect: '1:1', size: '400' }, 'web');
  assert.strictEqual(web.aspect, 'source');
  assert.strictEqual(web.maxWidth, 1920);
  assert.strictEqual(F.applyPreset('video', F.defaultOptions().video, 'reels').padColor, 'blur');
  const p = media.parseProbe(`  Stream #0:0[0x1](und): Video: h264 (High), yuv420p(tv, bt709), 1920x1080, 30 fps
      Side data:
        displaymatrix: rotation of -90.00 degrees`);
  assert.strictEqual(p.video.width, 1080);
  assert.strictEqual(p.video.height, 1920);
});

test('kalite ve boyut: video dikey/kare/özel boyut, resim kırp/bulanık/saydam/döndür', async () => {
  const F = require('../src/formats');
  const src = path.join(dir, 'wide.mp4');
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
  const dv = F.defaultOptions().video;
  const vcases = [
    [{ ...dv, aspect: '9:16', resolution: '360', fit: 'pad', padColor: 'blur', speed: 'veryfast' }, 'mp4', '360x640'],
    [{ ...dv, aspect: '1:1', resolution: '240', fit: 'crop' }, 'webm', '240x240'],
    [{ ...dv, aspect: 'custom', width: 301, height: 199, fit: 'stretch' }, 'avi', '302x200'],
    [{ ...dv, rotate: '90' }, 'mp4', '360x640'],
    [{ ...dv, aspect: '4:5', resolution: '240', fit: 'pad', padColor: 'white' }, 'gif', '240x300'],
  ];
  for (const [o, ext, want] of vcases) {
    const out = path.join(dir, 'f', `v-${want}.${ext}`);
    await media.convert({ src, out, type: 'video', target: ext, options: { video: o } });
    const i = await media.probe(out);
    assert.strictEqual(`${i.video.width}x${i.video.height}`, want, `${ext} ${o.aspect}`);
  }
  const img = path.join(dir, 'pic.png');
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=800x600', '-frames:v', '1', img]);
  const bmp = path.join(dir, 'pic.bmp');
  await ff(['-i', img, bmp]);
  const di = F.defaultOptions().image;
  const icases = [
    [F.applyPreset('image', di, 'igportrait'), 'jpg', img, '1080x1350'],
    [{ ...di, aspect: '9:16', size: '360', fit: 'pad', padColor: 'blur' }, 'webp', img, '360x640'],
    [{ ...di, aspect: '16:9', size: '180', fit: 'pad', padColor: 'transparent' }, 'png', img, '320x180'],
    [{ ...di, rotate: '270' }, 'png', img, '600x800'],
    [{ ...di, aspect: '1:1', size: '128', fit: 'pad', padColor: 'black' }, 'bmp', bmp, '128x128'],
  ];
  for (const [o, ext, s, want] of icases) {
    const out = path.join(dir, 'f', `i-${want}.${ext}`);
    await media.convert({ src: s, out, type: 'image', target: ext, options: { image: o } });
    const i = await media.probe(out);
    assert.strictEqual(`${i.video.width}x${i.video.height}`, want, `${ext} ${o.aspect}`);
  }
  // Saydam dolgu: köşe pikseli tamamen saydam
  const { data, info } = await require('sharp')(path.join(dir, 'f', 'i-320x180.png')).raw().toBuffer({ resolveWithObject: true });
  assert.strictEqual(info.channels, 4);
  assert.strictEqual(data[3], 0);
});
