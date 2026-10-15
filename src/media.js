'use strict';

// Dönüştürme motoru: video ve ses ffmpeg ile, resimler sharp (libvips) ile; sharp'ın okuyamadığı ya da
// yazamadığı biçimler (BMP, ICO, TGA) için ffmpeg devreye girer. Önizleme yardımcıları (kare, dalga
// biçimi, oynatılabilir kopya) ve konuşma tanıma için 16 kHz WAV çıkarma da buradadır.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { extOf } = require('./formats');

let sharp = null;
function getSharp() {
  if (!sharp) {
    sharp = require('sharp');
    sharp.cache(false); // kaynak dosyalar kilitli kalmasın (Windows)
  }
  return sharp;
}

// Paketlenmiş uygulamada ikili app.asar.unpacked altındadır
function ffmpegPath() {
  if (process.env.CVM_FFMPEG) return process.env.CVM_FFMPEG;
  return require('ffmpeg-static').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
}

class ConvertError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.code = code;
    this.detail = detail || '';
  }
}

// ffmpeg'i çalıştırır; -progress çıktısından ilerleme (0..1) bildirir. signal ile iptal edilir.
function runFfmpeg(args, { duration = 0, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new ConvertError('canceled'));
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args], { windowsHide: true });
    let err = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && duration > 0 && onProgress) onProgress(Math.min(0.999, Number(m[1]) / 1e6 / duration));
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 64000) err = err.slice(-32000);
    });
    const onAbort = () => child.kill('SIGKILL'); // SIGTERM'de ffmpeg kodlayıcıyı boşaltmaya çalışır (yavaş)
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => reject(new ConvertError('ffmpeg_missing', e.message)));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(new ConvertError('canceled'));
      if (code === 0) return resolve(err);
      reject(new ConvertError('ffmpeg_failed', lastError(err), err.split(/\r?\n/).slice(-20).join('\n')));
    });
  });
}

// ffmpeg hata çıktısından kullanıcıya gösterilecek anlamlı son satır
function lastError(stderr) {
  const noise = /Conversion failed|Nothing was written|Task finished|Terminating thread|Error sending frames|^frame=|^size=/;
  const lines = String(stderr).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !noise.test(l));
  const bad = lines.filter((l) => /error|invalid|not supported|unsupported|does not support|requires|could not|unable|no such|failed|denied|incorrect/i.test(l));
  return (bad.pop() || lines.pop() || 'ffmpeg').replace(/^\[[^\]]+\]\s*/, '').slice(0, 300);
}

// --- Bilgi (probe) ------------------------------------------------------------
// ffprobe yerine "ffmpeg -i" çıktısı ayrıştırılır (tek ikili yeter).
function parseProbe(stderr) {
  const info = { duration: 0, bitrate: 0, video: null, audio: null };
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (d) info.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const b = /bitrate:\s*(\d+)\s*kb\/s/.exec(stderr);
  if (b) info.bitrate = Number(b[1]);
  for (const line of stderr.split(/\r?\n/)) {
    const m = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*(Video|Audio):\s*([^\s,]+)(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'Video' && !info.video) {
      if (/attached pic/.test(line)) { info.cover = true; continue; }
      const wh = /,\s*(\d{2,5})x(\d{2,5})/.exec(m[3]);
      const fps = /([\d.]+)\s*fps/.exec(m[3]);
      info.video = { codec: m[2], width: wh ? Number(wh[1]) : 0, height: wh ? Number(wh[2]) : 0, fps: fps ? Number(fps[1]) : 0 };
    }
    if (m[1] === 'Audio' && !info.audio) {
      const hz = /(\d+)\s*Hz/.exec(m[3]);
      const ch = /Hz,\s*([^,]+)/.exec(m[3]);
      info.audio = { codec: m[2], sampleRate: hz ? Number(hz[1]) : 0, channels: ch ? ch[1].trim() : '' };
    }
  }
  return info;
}

function probe(file) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { if (err.length < 200000) err += d.toString(); });
    child.on('error', () => resolve({ duration: 0, video: null, audio: null, unreadable: true }));
    // "ffmpeg -i" çıkış dosyası olmadığı için her zaman 1 döner; çökme (sinyal) ya da hiç akış yoksa okunamadı
    child.on('close', (code, signal) => {
      const info = parseProbe(err);
      if (signal || (!info.video && !info.audio && !/Input #0/.test(err))) info.unreadable = true;
      resolve(info);
    });
  });
}

async function mediaInfo(file) {
  const st = await fs.promises.stat(file);
  const ext = extOf(file);
  const info = await probe(file);
  if (!info.video && !info.audio) {
    // Resimler: sharp ile boyut
    try {
      const m = await getSharp()(file, { animated: false }).metadata();
      info.video = { codec: m.format, width: m.width, height: m.height };
    } catch { /* ffmpeg de sharp da okuyamadı */ }
  }
  return { ...info, size: st.size, ext };
}

// --- Kodlayıcılar ---------------------------------------------------------------
let encoderList = null;
async function encoders() {
  if (encoderList) return encoderList;
  const out = await new Promise((resolve) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-encoders'], { windowsHide: true });
    let s = '';
    child.stdout.on('data', (d) => (s += d));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(s));
  });
  encoderList = new Set([...out.matchAll(/^\s*[VAS][\w.]{5}\s+(\S+)/gm)].map((m) => m[1]));
  return encoderList;
}
const pick = (set, ...names) => names.find((n) => set.has(n)) || names[names.length - 1];

// --- Video / ses argümanları ------------------------------------------------------
const CRF = {
  x264: { high: 18, medium: 23, low: 28 },
  x265: { high: 22, medium: 28, low: 32 },
  vp9: { high: 24, medium: 32, low: 40 },
  q: { high: 2, medium: 4, low: 7 },        // mpeg4 / mpeg2 / wmv2 -q:v (küçük = iyi)
  theora: { high: 9, medium: 7, low: 5 },
  gifFps: { high: 15, medium: 12, low: 10 },
};

// Çözünürlük: kısa kenar en çok H olacak şekilde küçült (büyütme yok), çift boyut
function scaleFilter(res) {
  if (!res || res === 'source') return null;
  const H = Number(res);
  return `scale='if(gt(iw,ih),-2,min(iw,${H}))':'if(gt(iw,ih),min(ih,${H}),-2)'`;
}

function audioArgs(target, o) {
  const br = `${Number(o.bitrate || o.audioBitrate || 192)}k`;
  switch (target) {
    case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', br];
    case 'aac': return ['-c:a', 'aac', '-b:a', br, '-f', 'adts'];
    case 'm4a': return ['-c:a', 'aac', '-b:a', br];
    case 'wav': return ['-c:a', 'pcm_s16le'];
    case 'aiff': return ['-c:a', 'pcm_s16be'];
    case 'flac': return ['-c:a', 'flac'];
    case 'ogg': return ['-c:a', 'libvorbis', '-b:a', br];
    case 'opus': return ['-c:a', 'libopus', '-b:a', br];
    case 'wma': return ['-c:a', 'wmav2', '-b:a', br];
    case 'ac3': return ['-c:a', 'ac3', '-b:a', br];
    default: return ['-c:a', 'aac', '-b:a', br];
  }
}

function audioShape(o) {
  const out = [];
  if (o.sampleRate && o.sampleRate !== 'source') out.push('-ar', String(o.sampleRate));
  if (o.channels === 'mono') out.push('-ac', '1');
  if (o.channels === 'stereo') out.push('-ac', '2');
  return out;
}

// Opus yalnız 48/24/16/12/8 kHz kabul eder; uyumsuz örnekleme hızı 48 kHz'e çekilir
function fixOpusRate(args, target) {
  if (target !== 'opus') return args;
  const i = args.indexOf('-ar');
  if (i >= 0 && !['48000', '24000', '16000', '12000', '8000'].includes(args[i + 1])) args[i + 1] = '48000';
  return args;
}

async function videoArgs(target, o, info) {
  const enc = await encoders();
  const q = o.quality || 'medium';
  const vf = [];
  const sf = scaleFilter(o.resolution);
  const fps = o.fps && o.fps !== 'source' ? ['-r', String(o.fps)] : [];
  const ab = { audioBitrate: o.audioBitrate };
  const noA = o.noAudio || !info.audio;

  // Videodan yalnız ses
  if (['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'].includes(target)) {
    if (!info.audio) throw new ConvertError('no_audio');
    return fixOpusRate(['-map', '0:a:0', '-vn', ...audioArgs(target, { bitrate: o.audioBitrate })], target);
  }
  if (target === 'gif') {
    const w = o.resolution && o.resolution !== 'source' ? Number(o.resolution) : 480;
    const f = o.fps && o.fps !== 'source' ? Math.min(30, Number(o.fps)) : CRF.gifFps[q];
    return ['-filter_complex',
      `[0:v:0]fps=${f},scale='min(iw,${w})':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a[g]`,
      '-map', '[g]', '-an', '-loop', '0'];
  }

  const maps = ['-map', '0:v:0', ...(noA ? ['-an'] : ['-map', '0:a:0'])];
  const speed = ['ultrafast', 'veryfast', 'fast', 'medium', 'slow'].includes(o.speed) ? o.speed : 'medium';
  let v;
  let a;
  switch (target) {
    case 'webm': {
      v = ['-c:v', pick(enc, 'libvpx-vp9'), '-b:v', '0', '-crf', String(CRF.vp9[q]), '-row-mt', '1', '-deadline', 'good',
        '-cpu-used', speed === 'slow' ? '1' : speed === 'medium' ? '2' : '4', '-pix_fmt', 'yuv420p'];
      a = ['-c:a', 'libopus', '-b:a', `${o.audioBitrate || 160}k`];
      break;
    }
    case 'avi':
      v = ['-c:v', pick(enc, 'libxvid', 'mpeg4'), '-q:v', String(CRF.q[q]), '-vtag', 'XVID', '-pix_fmt', 'yuv420p'];
      a = ['-c:a', 'libmp3lame', '-b:a', `${o.audioBitrate || 192}k`];
      break;
    case 'wmv':
      v = ['-c:v', 'wmv2', '-q:v', String(CRF.q[q])];
      a = ['-c:a', 'wmav2', '-b:a', `${o.audioBitrate || 192}k`];
      break;
    case 'mpg':
      v = ['-c:v', 'mpeg2video', '-q:v', String(CRF.q[q]), '-pix_fmt', 'yuv420p'];
      a = ['-c:a', 'mp2', '-b:a', `${Math.max(128, Number(o.audioBitrate) || 192)}k`];
      break;
    case 'ogv':
      v = ['-c:v', 'libtheora', '-q:v', String(CRF.theora[q])];
      a = ['-c:a', 'libvorbis', '-b:a', `${o.audioBitrate || 160}k`];
      break;
    default: {
      // mp4, m4v, mov, mkv, flv, 3gp: H.264 (veya mp4/mkv/mov'da H.265) + AAC
      const hevc = o.codec === 'h265' && ['mp4', 'm4v', 'mov', 'mkv'].includes(target) && enc.has('libx265');
      v = hevc
        ? ['-c:v', 'libx265', '-crf', String(CRF.x265[q]), '-preset', speed, '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p']
        : ['-c:v', pick(enc, 'libx264'), '-crf', String(CRF.x264[q]), '-preset', speed, '-pix_fmt', 'yuv420p'];
      if (target === '3gp') v.push('-profile:v', 'baseline');
      a = audioArgs('m4a', ab);
      if (target === 'flv') a.push('-ar', '44100');
    }
  }
  // yuv420p ve çoğu kodlayıcı çift boyut ister
  vf.push(sf || "scale='trunc(iw/2)*2':'trunc(ih/2)*2'");
  const extra = ['mp4', 'm4v', 'mov'].includes(target) ? ['-movflags', '+faststart'] : [];
  return [...maps, ...v, '-vf', vf.join(','), ...fps, ...(noA ? [] : a), '-map_metadata', '0', ...extra];
}

function audioOnlyArgs(target, o) {
  return fixOpusRate(['-map', '0:a:0', '-vn', ...audioArgs(target, o), ...audioShape(o), '-map_metadata', '0'], target);
}

// --- Resimler -----------------------------------------------------------------------
const SHARP_READ = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'tif', 'tiff', 'svg', 'heic', 'heif']);
const SHARP_WRITE = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'tif', 'tiff']);
const FF_READ = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'bmp', 'ico', 'tga']);
const FF_WRITE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'bmp', 'ico', 'tga']);

async function sharpConvert(src, out, target, o) {
  const S = getSharp();
  const srcExt = extOf(src);
  const animated = ['gif', 'webp'].includes(srcExt) && ['gif', 'webp'].includes(target);
  let img = S(src, { animated, density: srcExt === 'svg' ? 300 : undefined, limitInputPixels: false }).rotate();
  if (o.maxWidth || o.maxHeight) {
    img = img.resize({ width: o.maxWidth || null, height: o.maxHeight || null, fit: 'inside', withoutEnlargement: true });
  }
  if (o.keepMeta) img = img.withMetadata();
  const q = Math.max(1, Math.min(100, Number(o.quality) || 85));
  switch (target) {
    case 'jpg': case 'jpeg': img = img.flatten({ background: '#ffffff' }).jpeg({ quality: q, mozjpeg: true }); break;
    case 'png': img = img.png({ compressionLevel: 9, palette: q < 80 }); break;
    case 'webp': img = img.webp({ quality: q }); break;
    case 'avif': img = img.avif({ quality: Math.max(1, q - 20) }); break;
    case 'gif': img = img.gif(); break;
    case 'tif': case 'tiff': img = img.tiff({ quality: q, compression: 'jpeg' }); break;
    default: img = img.png();
  }
  await img.toFile(out);
}

function ffImageArgs(target, o) {
  const vf = [];
  if (o.maxWidth || o.maxHeight) {
    const w = o.maxWidth || 100000;
    const hgt = o.maxHeight || 100000;
    vf.push(`scale='min(iw,${w})':'min(ih,${hgt})':force_original_aspect_ratio=decrease`);
  }
  if (target === 'ico') vf.push("scale='min(256,iw)':'min(256,ih)':force_original_aspect_ratio=decrease");
  const q = Math.max(1, Math.min(100, Number(o.quality) || 85));
  const args = ['-frames:v', '1'];
  if (vf.length) args.push('-vf', vf.join(','));
  if (target === 'jpg' || target === 'jpeg') args.push('-q:v', String(Math.round(2 + (100 - q) / 100 * 29)));
  if (target === 'webp') args.push('-quality', String(q));
  if (target === 'ico') args.push('-c:v', 'png', '-pix_fmt', 'rgba');
  if (target === 'tga') args.push('-c:v', 'targa');
  return args;
}

async function imageConvert(src, out, target, o, signal) {
  const se = extOf(src);
  if (SHARP_READ.has(se) && SHARP_WRITE.has(target)) return sharpConvert(src, out, target, o);
  if (FF_READ.has(se) && FF_WRITE.has(target)) return runFfmpeg(['-i', src, ...ffImageArgs(target, o), out], { signal });
  const mid = `${out}.stage.png`;
  try {
    if (FF_READ.has(se) && SHARP_WRITE.has(target)) {
      await runFfmpeg(['-i', src, '-frames:v', '1', mid], { signal });
      await sharpConvert(mid, out, target, o);
    } else if (SHARP_READ.has(se) && FF_WRITE.has(target)) {
      await sharpConvert(src, mid, 'png', { ...o, quality: 100 });
      await runFfmpeg(['-i', mid, ...ffImageArgs(target, { ...o, maxWidth: 0, maxHeight: 0 }), out], { signal });
    } else {
      throw new ConvertError('unsupported');
    }
  } finally {
    fs.promises.rm(mid, { force: true }).catch(() => {});
  }
}

// --- Dönüştür ---------------------------------------------------------------------------
// project: { type, targetExt, options }. Çıktı önce geçici adla yazılır, başarıyla bitince yerine taşınır.
async function convert({ src, out, type, target, options, onProgress, signal }) {
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  const tmp = path.join(path.dirname(out), `.~${path.basename(out, path.extname(out))}.cvmtmp.${target}`);
  const o = options || {};
  try {
    if (type === 'image') {
      await imageConvert(src, tmp, target, o.image || {}, signal);
    } else {
      const info = await probe(src);
      if (info.unreadable) throw new ConvertError('unreadable');
      if (type === 'video' && !info.video) throw new ConvertError('no_video');
      if (type === 'audio' && !info.audio) throw new ConvertError('no_audio');
      const args = type === 'video' ? await videoArgs(target, o.video || {}, info) : audioOnlyArgs(target, o.audio || {});
      await runFfmpeg(['-i', src, ...args, tmp], { duration: info.duration, onProgress, signal });
    }
    if (signal && signal.aborted) throw new ConvertError('canceled');
    await fs.promises.rm(out, { force: true });
    await fs.promises.rename(tmp, out);
    const st = await fs.promises.stat(out);
    return { size: st.size };
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

// --- Önizleme yardımcıları --------------------------------------------------------------
// Videodan tek kare (JPEG)
async function poster(src, out, duration) {
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  const at = duration > 4 ? Math.min(duration * 0.1, 30) : 0;
  await runFfmpeg(['-ss', String(at), '-i', src, '-frames:v', '1', '-vf', "scale='min(960,iw)':-2", '-q:v', '4', out]);
}

// Ses dalga biçimi (PNG, şeffaf zemin)
async function waveform(src, out, color = '22d3ee') {
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  await runFfmpeg(['-i', src, '-filter_complex', `[0:a:0]aformat=channel_layouts=mono,showwavespic=s=1200x180:colors=0x${color}:scale=sqrt`, '-frames:v', '1', out]);
}

// Chromium'un açamadığı dosyalar için oynatılabilir kopya: video → 480p H.264 MP4, ses → MP3, resim → PNG
async function previewCopy(src, out, kind, { duration = 0, onProgress, signal } = {}) {
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  const tmp = out + '.part' + path.extname(out);
  let args;
  if (kind === 'video') {
    args = ['-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-vf', "scale='if(gt(iw,ih),-2,min(iw,480))':'if(gt(iw,ih),min(ih,480),-2)'", '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
      '-ac', '2', '-movflags', '+faststart', tmp];
  } else if (kind === 'audio') {
    args = ['-i', src, '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '160k', tmp];
  } else {
    if (SHARP_READ.has(extOf(src))) {
      await getSharp()(src, { density: 150 }).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).png().toFile(tmp);
      await fs.promises.rename(tmp, out);
      return out;
    }
    args = ['-i', src, '-frames:v', '1', tmp];
  }
  try {
    await runFfmpeg(args, { duration, onProgress, signal });
    await fs.promises.rename(tmp, out);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return out;
}

// Konuşma tanıma girişi: 16 kHz, mono, 16 bit WAV
async function extractSpeechWav(src, out, { duration = 0, onProgress, signal } = {}) {
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  await runFfmpeg(['-i', src, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], { duration, onProgress, signal });
}

module.exports = {
  ffmpegPath, probe, parseProbe, mediaInfo, convert, poster, waveform, previewCopy, extractSpeechWav, runFfmpeg, ConvertError,
  // testler için
  _videoArgs: videoArgs, _audioOnlyArgs: audioOnlyArgs, _scaleFilter: scaleFilter,
};
