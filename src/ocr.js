'use strict';

// Resimden metin (OCR): tesseract.js (Tesseract 5, WebAssembly) bu bilgisayarda, çevrimdışı çalışır.
// Dil verileri (LSTM "best_int", her dil ~2–15 MB) ilk kullanımda indirilip userData/ocr altına açılır.
// Sonuç: { languages, text, width, height, lines: [{ text, conf, bbox: { x0, y0, x1, y1 } }] }

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const media = require('./media');
const { OCR_LANGS } = require('./formats');

const LANG_URL = (lang) => `${process.env.CVM_OCR_LANG_BASE || 'https://cdn.jsdelivr.net/npm/@tesseract.js-data'}/${lang}/4.0.0_best_int/${lang}.traineddata.gz`;
const IDLE_MS = 60 * 1000;

class OcrError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// Paketlenmiş uygulamada tesseract.js'in çalışan (worker) betiği app.asar.unpacked altındadır
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function createOcr({ userDataDir, download }) {
  const dir = path.join(userDataDir, 'ocr');
  const file = (lang) => path.join(dir, `${lang}.traineddata`);
  const installed = (lang) => fs.existsSync(file(lang));

  function status() {
    const langs = {};
    for (const l of OCR_LANGS) {
      let size = 0;
      try { size = fs.statSync(file(l)).size; } catch { /* yok */ }
      langs[l] = { installed: size > 0, size };
    }
    return { langs, dir };
  }

  // Dil verisini indirir (.gz) ve açar. Yerel klasör de verilebilir (testler: CVM_OCR_LANG_BASE=node_modules/@tesseract.js-data)
  async function ensureLanguage(lang, { onProgress, signal } = {}) {
    if (!OCR_LANGS.includes(lang)) throw new OcrError('bad_lang', lang);
    if (installed(lang)) return;
    await fs.promises.mkdir(dir, { recursive: true });
    const gz = `${file(lang)}.gz`;
    const url = LANG_URL(lang);
    if (/^https?:/i.test(url)) await download(url, gz, { onProgress, signal });
    else await fs.promises.copyFile(url, gz);
    const data = zlib.gunzipSync(await fs.promises.readFile(gz));
    await fs.promises.writeFile(`${file(lang)}.part`, data);
    await fs.promises.rename(`${file(lang)}.part`, file(lang));
    await fs.promises.rm(gz, { force: true });
  }

  async function ensureLanguages(langs, opts = {}) {
    for (let i = 0; i < langs.length; i++) {
      await ensureLanguage(langs[i], { ...opts, onProgress: opts.onProgress && ((p, got, total) => opts.onProgress((i + p) / langs.length, got, total, langs[i])) });
    }
  }

  async function deleteLanguage(lang) {
    if (!OCR_LANGS.includes(lang)) return;
    await fs.promises.rm(file(lang), { force: true });
    await fs.promises.rm(`${file(lang)}.gz`, { force: true });
    await fs.promises.rm(`${file(lang)}.gz.part`, { force: true });
  }

  // Aynı dil kümesi için çalışan (worker) yeniden kullanılır; boşta kalınca kapatılır
  let current = null; // { key, worker, timer, onProgress }
  async function workerFor(langs) {
    const key = langs.join('+');
    if (current && current.key === key) { clearTimeout(current.timer); return current; }
    if (current) { clearTimeout(current.timer); current.worker.terminate().catch(() => {}); current = null; }
    const T = require('tesseract.js');
    const entry = { key, onProgress: null };
    const workerPath = unpacked(path.join(path.dirname(require.resolve('tesseract.js')), 'worker-script', 'node', 'index.js'));
    entry.worker = await T.createWorker(langs, 1 /* LSTM */, {
      workerPath, langPath: dir, cachePath: dir, cacheMethod: 'readOnly', gzip: false,
      logger: (m) => { if (m.status === 'recognizing text' && entry.onProgress) entry.onProgress(m.progress); },
      errorHandler: () => {},
    });
    current = entry;
    return entry;
  }

  function release() {
    if (!current) return;
    clearTimeout(current.timer);
    const c = current;
    current.timer = setTimeout(() => { if (current === c) { current = null; c.worker.terminate().catch(() => {}); } }, IDLE_MS);
  }

  // OCR'den önce her biçim PNG'ye çevrilir (SVG, AVIF, ICO, TGA… Tesseract'ın doğrudan okuyamadıkları dahil)
  async function recognize(src, { langs = ['eng'], workDir, onProgress, signal } = {}) {
    const list = [...new Set(langs.filter((l) => OCR_LANGS.includes(l)))];
    if (!list.length) list.push('eng');
    await ensureLanguages(list, { signal });
    if (signal && signal.aborted) throw new OcrError('canceled');
    await fs.promises.mkdir(workDir, { recursive: true });
    const png = path.join(workDir, `ocr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    try {
      const size = await media.toPng(src, png);
      if (signal && signal.aborted) throw new OcrError('canceled');
      const w = await workerFor(list);
      w.onProgress = onProgress || null;
      let onAbort = null;
      const aborted = new Promise((_, reject) => {
        if (!signal) return;
        onAbort = () => {
          // Tesseract işini yarıda kesmenin yolu çalışanı kapatmaktır
          if (current === w) current = null;
          w.worker.terminate().catch(() => {});
          reject(new OcrError('canceled'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const { data } = await Promise.race([w.worker.recognize(png, {}, { text: true, blocks: true }), aborted]);
        const lines = [];
        for (const b of data.blocks || []) {
          for (const p of b.paragraphs || []) {
            for (const l of p.lines || []) {
              const text = String(l.text || '').trim();
              if (text) lines.push({ text, conf: Math.round(l.confidence || 0), bbox: l.bbox });
            }
          }
        }
        return { languages: list, text: String(data.text || '').trim(), width: size.width, height: size.height, lines };
      } finally {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        w.onProgress = null;
        if (current === w) release();
      }
    } finally {
      await fs.promises.rm(png, { force: true }).catch(() => {});
    }
  }

  async function close() {
    if (current) { clearTimeout(current.timer); await current.worker.terminate().catch(() => {}); current = null; }
  }

  return { status, ensureLanguage, ensureLanguages, deleteLanguage, recognize, installed, close };
}

function exportOcr(result, format) {
  const lines = (result && result.lines) || [];
  if (format === 'json') return JSON.stringify(result, null, 2);
  if (format === 'csv') return '﻿line;confidence;text\r\n' + lines.map((l, i) => `${i + 1};${l.conf};"${l.text.replace(/"/g, '""')}"`).join('\r\n') + '\r\n';
  return lines.map((l) => l.text).join('\r\n') + '\r\n';
}

module.exports = { createOcr, exportOcr, OcrError };
