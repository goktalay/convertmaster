'use strict';

// Konuşmadan metne: whisper.cpp (whisper-cli) yerel ve çevrimdışı çalışır.
// - İkili: kurulumla gelir (resources/whisper, CI'da scripts/fetch-whisper.js indirir). Yoksa ilk kullanımda indirilir.
// - Model: ilk kullanımda Hugging Face'ten (ggerganov/whisper.cpp) userData/models altına indirilir.
// - Giriş: ffmpeg'in çıkardığı 16 kHz mono WAV. "Her 30 sn'de dil algıla" seçeneğinde WAV pencerelere bölünür,
//   her pencerede dil ayrıca algılanır (çok dilli kayıtlar için).
// Windows'ta whisper-cli ASCII dışı yolları açamayabildiği için çalışma klasörü göreli adlarla kullanılır.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { SPEECH_MODELS } = require('./formats');

const WHISPER_VERSION = process.env.CVM_WHISPER_VERSION || 'v1.7.6';
const WHISPER_ZIP_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`;
const MODEL_URL = (file) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;
const WINDOW_SEC = 30;
const EXE = process.platform === 'win32' ? '.exe' : '';

class SpeechError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function createSpeech({ userDataDir, resourcesDir, devDir, fetch: fetchImpl = globalThis.fetch }) {
  const enginesDir = path.join(userDataDir, 'engines', 'whisper');
  const modelsDir = path.join(userDataDir, 'models');

  // whisper-cli (eski sürümlerde main) dosyasını klasörde özyinelemeli arar
  function findIn(dir, depth = 0) {
    if (!dir || depth > 3) return null;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const name of [`whisper-cli${EXE}`, `main${EXE}`]) if (entries.some((e) => e.isFile() && e.name === name)) return path.join(dir, name);
    for (const e of entries) if (e.isDirectory()) { const f = findIn(path.join(dir, e.name), depth + 1); if (f) return f; }
    return null;
  }

  function binPath() {
    if (process.env.CVM_WHISPER_CLI) return process.env.CVM_WHISPER_CLI;
    return findIn(resourcesDir && path.join(resourcesDir, 'whisper')) || findIn(devDir) || findIn(enginesDir);
  }

  const modelFile = (name) => path.join(modelsDir, (SPEECH_MODELS[name] || SPEECH_MODELS.base).file);
  const hasModel = (name) => fs.existsSync(modelFile(name));

  function status() {
    const models = {};
    for (const k of Object.keys(SPEECH_MODELS)) {
      let size = 0;
      try { size = fs.statSync(modelFile(k)).size; } catch { /* yok */ }
      models[k] = { installed: size > 0, size };
    }
    return { engine: !!binPath(), canDownloadEngine: process.platform === 'win32', models, modelsDir };
  }

  // URL'yi dosyaya indirir (yarım kalan .part dosyasından devam eder), ilerleme 0..1
  async function download(url, dest, { onProgress, signal } = {}) {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const part = dest + '.part';
    let have = 0;
    try { have = fs.statSync(part).size; } catch { /* yeni */ }
    const res = await fetchImpl(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal, redirect: 'follow' });
    if (res.status === 416) { have = 0; await fs.promises.rm(part, { force: true }); return download(url, dest, { onProgress, signal }); }
    if (!res.ok) throw new SpeechError('download_failed', `HTTP ${res.status}`);
    if (res.status !== 206) have = 0; // sunucu devam etmeyi desteklemiyor: baştan
    const len = Number(res.headers.get('content-length')) || 0;
    const total = len ? have + len : 0;
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    let got = have;
    let lastTick = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        const now = Date.now();
        if (onProgress && total && now - lastTick > 200) { lastTick = now; onProgress(got / total, got, total); }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (total && got !== total) throw new SpeechError('download_failed', 'incomplete');
    await fs.promises.rename(part, dest);
    if (onProgress) onProgress(1, got, total || got);
  }

  async function ensureEngine({ onProgress, signal } = {}) {
    if (binPath()) return binPath();
    if (process.platform !== 'win32') throw new SpeechError('engine_missing');
    const zip = path.join(enginesDir, 'whisper-bin-x64.zip');
    await download(WHISPER_ZIP_URL, zip, { onProgress, signal });
    const extract = require('extract-zip');
    await extract(zip, { dir: enginesDir });
    await fs.promises.rm(zip, { force: true });
    const bin = binPath();
    if (!bin) throw new SpeechError('engine_missing');
    return bin;
  }

  async function ensureModel(name, { onProgress, signal } = {}) {
    const file = modelFile(name);
    if (fs.existsSync(file)) return file;
    await download(MODEL_URL((SPEECH_MODELS[name] || SPEECH_MODELS.base).file), file, { onProgress, signal });
    return file;
  }

  async function deleteModel(name) {
    await fs.promises.rm(modelFile(name), { force: true });
    await fs.promises.rm(modelFile(name) + '.part', { force: true });
  }

  // Tek whisper-cli çalıştırması; JSON çıktısını döner
  function runWhisper({ bin, model, wav, language, cwd, onProgress, signal }) {
    return new Promise((resolve, reject) => {
      const threads = String(Math.max(1, Math.min(8, os.cpus().length - 1)));
      const base = path.basename(wav, '.wav');
      const args = ['-m', path.relative(cwd, model), '-f', path.basename(wav), '-l', language || 'auto', '-t', threads, '-oj', '-of', base, '-pp'];
      // .js: test için whisper-cli taklidi (Windows .js dosyasını doğrudan çalıştıramaz)
      const child = bin.endsWith('.js') ? spawn(process.execPath, [bin, ...args], { cwd, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
        : spawn(bin, args, { cwd, windowsHide: true });
      let err = '';
      const onData = (d) => {
        const s = d.toString();
        err += s;
        if (err.length > 64000) err = err.slice(-32000);
        const all = [...s.matchAll(/progress\s*=\s*(\d+)%/g)];
        if (all.length && onProgress) onProgress(Number(all[all.length - 1][1]) / 100);
      };
      child.stderr.on('data', onData);
      child.stdout.on('data', onData);
      const onAbort = () => child.kill('SIGKILL'); // iptal: hemen sonlandır
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => reject(new SpeechError('engine_missing', e.message)));
      child.on('close', async (code) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (signal && signal.aborted) return reject(new SpeechError('canceled'));
        const jsonFile = path.join(cwd, base + '.json');
        try {
          if (code !== 0) throw new Error();
          const json = JSON.parse(await fs.promises.readFile(jsonFile, 'utf8'));
          const det = /auto-detected language:\s*([a-z]{2,3})/.exec(err);
          resolve({ json, detected: det ? det[1] : null });
        } catch {
          const lines = err.split(/\r?\n/).filter((l) => /error|failed|unknown|invalid/i.test(l));
          reject(new SpeechError('whisper_failed', (lines.pop() || `exit ${code}`).trim().slice(0, 300)));
        } finally {
          fs.promises.rm(jsonFile, { force: true }).catch(() => {});
        }
      });
    });
  }

  // whisper JSON → [{ start, end, lang, text }] (saniye)
  function segmentsOf(json, offsetSec, lang) {
    const out = [];
    for (const s of json.transcription || []) {
      const text = String(s.text || '').trim();
      if (!text || /^\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]$/i.test(text) || /^\((?:music|silence)\)$/i.test(text)) continue;
      const from = s.offsets ? s.offsets.from / 1000 : 0;
      const to = s.offsets ? s.offsets.to / 1000 : from;
      out.push({ start: +(offsetSec + from).toFixed(2), end: +(offsetSec + to).toFixed(2), lang, text });
    }
    return out;
  }

  // 16 kHz mono s16 WAV'dan [startSec, startSec+lenSec) aralığını yeni WAV olarak yazar
  async function sliceWav(src, dest, startSec, lenSec) {
    const fd = await fs.promises.open(src, 'r');
    try {
      const { size } = await fd.stat();
      const head = Buffer.alloc(4096);
      await fd.read(head, 0, head.length, 0);
      // "data" bloğunu bul
      let pos = 12;
      let dataStart = 44;
      while (pos + 8 <= head.length) {
        const id = head.toString('ascii', pos, pos + 4);
        const len = head.readUInt32LE(pos + 4);
        if (id === 'data') { dataStart = pos + 8; break; }
        pos += 8 + len + (len % 2);
      }
      const BPS = 32000;
      const from = dataStart + Math.floor(startSec * BPS / 2) * 2;
      const len = Math.max(0, Math.min(size - from, Math.floor(lenSec * BPS / 2) * 2));
      const body = Buffer.alloc(len);
      await fd.read(body, 0, len, from);
      const hdr = Buffer.alloc(44);
      hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + len, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12);
      hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(16000, 24);
      hdr.writeUInt32LE(BPS, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(len, 40);
      await fs.promises.writeFile(dest, Buffer.concat([hdr, body]));
      return len / BPS;
    } finally {
      await fd.close();
    }
  }

  // wav: 16 kHz mono WAV (iş klasöründe, ASCII adlı). Dönen: { language, segments }
  async function transcribe({ wav, model, language = 'auto', perWindow = false, duration = 0, onProgress, signal }) {
    const bin = await ensureEngine({ signal });
    const modelPath = await ensureModel(model, { signal });
    const cwd = path.dirname(wav);
    if (!perWindow || language !== 'auto' || duration <= WINDOW_SEC * 1.5) {
      const { json, detected } = await runWhisper({ bin, model: modelPath, wav, language, cwd, onProgress, signal });
      const lang = (json.result && json.result.language) || detected || (language !== 'auto' ? language : '');
      return { language: lang, segments: segmentsOf(json, 0, lang) };
    }
    const n = Math.ceil(duration / WINDOW_SEC);
    const segments = [];
    const langs = {};
    for (let i = 0; i < n; i++) {
      const chunk = path.join(cwd, `w${i}.wav`);
      try {
        const len = await sliceWav(wav, chunk, i * WINDOW_SEC, WINDOW_SEC);
        if (len < 0.5) continue;
        const { json, detected } = await runWhisper({
          bin, model: modelPath, wav: chunk, language: 'auto', cwd, signal,
          onProgress: (p) => onProgress && onProgress((i + p) / n),
        });
        const lang = (json.result && json.result.language) || detected || '';
        const seg = segmentsOf(json, i * WINDOW_SEC, lang);
        if (seg.length) langs[lang] = (langs[lang] || 0) + seg.length;
        segments.push(...seg);
      } finally {
        await fs.promises.rm(chunk, { force: true }).catch(() => {});
      }
    }
    const main = Object.entries(langs).sort((a, b) => b[1] - a[1])[0];
    return { language: main ? main[0] : '', segments };
  }

  return { status, binPath, hasModel, ensureEngine, ensureModel, deleteModel, transcribe, modelFile, _sliceWav: sliceWav, _segmentsOf: segmentsOf };
}

// Altyazı / metin dışa aktarımı
function fmtTime(sec, sep) {
  const ms = Math.round(sec * 1000);
  const hh = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const mm = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}${sep}${String(ms % 1000).padStart(3, '0')}`;
}

function exportTranscript(segments, format) {
  switch (format) {
    case 'srt':
      return segments.map((s, i) => `${i + 1}\n${fmtTime(s.start, ',')} --> ${fmtTime(s.end, ',')}\n${s.text}\n`).join('\n');
    case 'vtt':
      return 'WEBVTT\n\n' + segments.map((s) => `${fmtTime(s.start, '.')} --> ${fmtTime(s.end, '.')}\n${s.text}\n`).join('\n');
    case 'csv':
      return '﻿second;language;text\r\n' + segments.map((s) => `${s.start.toFixed(2)};${s.lang};"${s.text.replace(/"/g, '""')}"`).join('\r\n') + '\r\n';
    case 'json':
      return JSON.stringify(segments, null, 2);
    default:
      return segments.map((s) => `[${fmtTime(s.start, '.').slice(0, 8)}] (${s.lang}) ${s.text}`).join('\r\n') + '\r\n';
  }
}

module.exports = { createSpeech, exportTranscript, SpeechError, WHISPER_ZIP_URL, WHISPER_VERSION };
