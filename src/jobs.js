'use strict';

// Proje çalıştırıcı: kaynak dosyaları tarar, seçili dosyaları sıraya alır, projenin "aynı anda kaç dosya"
// ayarına göre dönüştürür, isteğe bağlı olarak konuşmayı metne çevirir ve durumu diske yazar.
//
// Diskte (hepsi %APPDATA%\Convert Master altında, cihaza özgü):
//   converted/<projeId>/<göreli klasör>/<ad>.<hedef>   dönüştürülmüş dosyalar (kullanıcı silebilir)
//   work/<projeId>/state.json                         dosya durumları
//   work/<projeId>/speech/<özet>.json                 metin (konuşma) sonuçları
//   work/<projeId>/tmp/                               geçici WAV'lar

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const media = require('./media');
const { extOf } = require('./formats');

const UPDATE_MS = 150;

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

async function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else { try { total += (await fs.promises.stat(p)).size; } catch { /* silinmiş */ } }
  }
  return total;
}

// Klasörü (alt klasörler isteğe bağlı) tarar; yalnız istenen uzantılar
async function scanFolder(root, exts, recursive) {
  const files = [];
  const want = new Set(exts);
  async function walk(dir, rel) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (recursive) await walk(abs, r); continue; }
      if (!e.isFile() || !want.has(extOf(e.name))) continue;
      try {
        const st = await fs.promises.stat(abs);
        files.push({ rel: r, size: st.size, mtime: Math.round(st.mtimeMs) });
      } catch { /* erişilemiyor */ }
    }
  }
  await walk(root, '');
  files.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true, sensitivity: 'base' }));
  return files;
}

class ProjectRunner {
  // deps: { userDataDir, getProject(), getLocal(), speech, getSettings(), send(channel, data), errText(err) }
  constructor(projectId, deps) {
    this.id = projectId;
    this.deps = deps;
    this.workDir = path.join(deps.userDataDir, 'work', projectId);
    this.outDir = path.join(deps.userDataDir, 'converted', projectId);
    this.stateFile = path.join(this.workDir, 'state.json');
    this.state = { items: {} };
    try { this.state = { items: {}, ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) }; } catch { /* ilk açılış */ }
    this.files = [];          // son taramadaki dosyalar [{ rel, size, mtime }]
    this.root = '';
    this.queue = [];          // dönüştürülecek rel'ler
    this.speechQueue = [];    // metne çevrilecek rel'ler
    this.active = new Map();  // rel -> AbortController (dönüştürme)
    this.speechActive = new Map();
    this.running = false;
    this.pending = new Map(); // gönderilmeyi bekleyen öğe güncellemeleri
    this.flushTimer = null;
    this.saveTimer = null;
    this.closed = false;
  }

  project() { return this.deps.getProject(this.id); }
  local() { return this.deps.getLocal(this.id); }

  item(rel) {
    if (!this.state.items[rel]) this.state.items[rel] = { status: 'pending', progress: 0 };
    return this.state.items[rel];
  }

  // --- Kalıcılık ve olaylar ----------------------------------------------------
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 800);
  }
  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      fs.mkdirSync(this.workDir, { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state), 'utf8');
    } catch { /* disk dolu vb.; bir sonraki kayıtta tekrar denenir */ }
  }

  touch(rel) {
    this.pending.set(rel, { rel, ...this.item(rel) });
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), UPDATE_MS);
  }
  flush() {
    this.flushTimer = null;
    if (!this.pending.size) return;
    const items = [...this.pending.values()];
    this.pending.clear();
    this.deps.send('job:items', items);
  }
  emitState() {
    this.deps.send('job:state', this.summary());
  }

  summary() {
    const sel = this.selected();
    const c = { total: sel.length, done: 0, error: 0, active: this.active.size, queued: this.queue.length, speechActive: this.speechActive.size,
      speechQueued: this.speechQueue.length };
    for (const f of sel) {
      const it = this.state.items[f.rel];
      if (it && it.status === 'done') c.done++;
      if (it && it.status === 'error') c.error++;
    }
    return { running: this.running, counts: c };
  }

  // --- Tarama --------------------------------------------------------------------
  async scan() {
    const p = this.project();
    const loc = this.local();
    if (!p || !loc.sourcePath) { this.files = []; this.root = ''; return this.snapshot(); }
    let files = [];
    if (p.sourceMode === 'file') {
      this.root = path.dirname(loc.sourcePath);
      try {
        const st = await fs.promises.stat(loc.sourcePath);
        files = [{ rel: path.basename(loc.sourcePath), size: st.size, mtime: Math.round(st.mtimeMs) }];
      } catch { files = []; }
    } else {
      this.root = loc.sourcePath;
      files = await scanFolder(loc.sourcePath, p.sourceExts || [], p.includeSubfolders !== false);
    }
    // Değişen kaynak dosyalarının sonucu geçersiz
    for (const f of files) {
      const it = this.state.items[f.rel];
      if (it && it.srcSize !== undefined && (it.srcSize !== f.size || it.srcMtime !== f.mtime) && !this.active.has(f.rel)) {
        Object.assign(it, { status: 'pending', progress: 0, error: '', outSize: 0 });
        delete it.speech;
      }
    }
    this.files = files;
    this.computeOutputs();
    this.save();
    return this.snapshot();
  }

  snapshot() {
    const loc = this.local();
    const unchecked = new Set(loc.unchecked || []);
    return {
      root: this.root,
      sourcePath: loc.sourcePath || '',
      missing: !!loc.sourcePath && !this.files.length && this.project()?.sourceMode === 'file',
      files: this.files.map((f) => ({ ...f, checked: !unchecked.has(f.rel), ...this.publicItem(f.rel) })),
      outDir: this.outDir,
      ...this.summary(),
    };
  }

  publicItem(rel) {
    const it = this.state.items[rel] || { status: 'pending', progress: 0 };
    return { status: it.status, progress: it.progress || 0, error: it.error || '', outSize: it.outSize || 0, duration: it.duration || 0, speech: it.speech || null };
  }

  selected() {
    const unchecked = new Set(this.local().unchecked || []);
    return this.files.filter((f) => !unchecked.has(f.rel));
  }

  // Aynı klasörde yalnız uzantısı farklı kaynaklar (a.mkv, a.avi) aynı çıktıya düşmesin: a_mkv.mp4, a_avi.mp4
  computeOutputs() {
    const p = this.project();
    const groups = new Map();
    for (const f of this.files) {
      const base = f.rel.slice(0, f.rel.length - path.extname(f.rel).length);
      const key = base.toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    this.outMap = new Map();
    for (const list of groups.values()) {
      for (const f of list) {
        const base = f.rel.slice(0, f.rel.length - path.extname(f.rel).length);
        const name = list.length > 1 ? `${base}_${extOf(f.rel)}` : base;
        this.outMap.set(f.rel, `${name}.${p.targetExt}`);
      }
    }
  }

  srcPath(rel) { return path.join(this.root, ...rel.split('/')); }
  outPath(rel) {
    if (!this.outMap) this.computeOutputs();
    return path.join(this.outDir, ...(this.outMap.get(rel) || rel).split('/'));
  }
  speechFile(rel) { return path.join(this.workDir, 'speech', `${sha(rel)}.json`); }

  // --- Çalıştırma ------------------------------------------------------------------
  speechWanted() {
    const p = this.project();
    return !!(p && p.speech && p.speech.enabled && (p.type === 'video' || p.type === 'audio'));
  }

  start({ rels, force = false } = {}) {
    if (!this.root) return;
    const list = rels ? this.files.filter((f) => rels.includes(f.rel)) : this.selected();
    for (const f of list) {
      const it = this.item(f.rel);
      if (this.active.has(f.rel) || this.queue.includes(f.rel)) continue;
      if (it.status === 'done' && !force) {
        // Dönüştürülmüş ama metni çıkarılmamış dosya: yalnız konuşma
        if (this.speechWanted() && (!it.speech || it.speech.status === 'error' || it.speech.status === 'canceled')) this.queueSpeech(f.rel);
        continue;
      }
      Object.assign(it, { status: 'queued', progress: 0, error: '' });
      this.queue.push(f.rel);
      this.touch(f.rel);
    }
    this.running = this.queue.length > 0 || this.active.size > 0 || this.speechQueue.length > 0 || this.speechActive.size > 0;
    this.emitState();
    this.pump();
  }

  stop() {
    for (const rel of this.queue) Object.assign(this.item(rel), { status: 'pending', progress: 0 }) && this.touch(rel);
    for (const rel of this.speechQueue) { const it = this.item(rel); if (it.speech) it.speech = { status: 'canceled', progress: 0 }; this.touch(rel); }
    this.queue = [];
    this.speechQueue = [];
    for (const c of this.active.values()) c.abort();
    for (const c of this.speechActive.values()) c.abort();
    this.running = false;
    this.save();
    this.emitState();
  }

  // Seçimden çıkarılan dosyalar kuyruktan da çıkar
  onSelectionChanged() {
    const unchecked = new Set(this.local().unchecked || []);
    this.queue = this.queue.filter((rel) => {
      if (!unchecked.has(rel)) return true;
      Object.assign(this.item(rel), { status: 'pending', progress: 0 });
      this.touch(rel);
      return false;
    });
    this.speechQueue = this.speechQueue.filter((rel) => !unchecked.has(rel));
    this.save();
    this.emitState();
  }

  concurrency() {
    const p = this.project();
    return Math.max(1, Math.min(32, Number(p && p.concurrency) || 2));
  }

  pump() {
    if (this.closed) return;
    while (this.active.size < this.concurrency() && this.queue.length) this.runItem(this.queue.shift());
    const sc = Math.max(1, Number(this.deps.getSettings().speechConcurrency) || 1);
    while (this.speechActive.size < sc && this.speechQueue.length) this.runSpeech(this.speechQueue.shift());
    const busy = this.queue.length || this.active.size || this.speechQueue.length || this.speechActive.size;
    if (this.running && !busy) {
      this.running = false;
      this.saveNow();
      this.deps.send('job:finished', this.summary());
    }
    this.emitState();
  }

  async runItem(rel) {
    const p = this.project();
    const f = this.files.find((x) => x.rel === rel);
    if (!p || !f) return this.pump();
    const it = this.item(rel);
    const ctl = new AbortController();
    this.active.set(rel, ctl);
    Object.assign(it, { status: 'converting', progress: 0, error: '', startedAt: Date.now() });
    this.touch(rel);
    try {
      const r = await media.convert({
        src: this.srcPath(rel), out: this.outPath(rel), type: p.type, target: p.targetExt, options: p.options, signal: ctl.signal,
        onProgress: (x) => { it.progress = x; this.touch(rel); },
      });
      Object.assign(it, { status: 'done', progress: 1, outSize: r.size, srcSize: f.size, srcMtime: f.mtime, finishedAt: Date.now(), out: this.outMap.get(rel) });
      it.took = it.finishedAt - it.startedAt;
      if (this.speechWanted() && (!it.speech || !['done', 'none'].includes(it.speech.status))) this.queueSpeech(rel);
    } catch (e) {
      if (e.code === 'canceled') Object.assign(it, { status: 'pending', progress: 0 });
      else Object.assign(it, { status: 'error', progress: 0, error: this.deps.errText(e) });
    } finally {
      this.active.delete(rel);
      this.touch(rel);
      this.save();
      this.pump();
    }
  }

  queueSpeech(rel) {
    if (this.speechQueue.includes(rel) || this.speechActive.has(rel)) return;
    const it = this.item(rel);
    it.speech = { status: 'queued', progress: 0 };
    this.speechQueue.push(rel);
    this.running = true;
    this.touch(rel);
  }

  // Tek dosyayı (dönüştürmeden) metne çevir
  transcribeOnly(rels) {
    if (!this.root || !(this.project().type === 'video' || this.project().type === 'audio')) return;
    for (const rel of rels) this.queueSpeech(rel);
    this.emitState();
    this.pump();
  }

  async runSpeech(rel) {
    const p = this.project();
    const it = this.item(rel);
    const ctl = new AbortController();
    this.speechActive.set(rel, ctl);
    it.speech = { status: 'running', progress: 0 };
    this.touch(rel);
    const tmpDir = path.join(this.workDir, 'tmp');
    const wav = path.join(tmpDir, `s${sha(rel)}.wav`);
    const sp = p.speech || {};
    const model = sp.model || this.deps.getSettings().speechModel || 'base';
    try {
      // Motor ve model yoksa indirilir (ilerleme pencereye ayrıca bildirilir)
      await this.deps.speech.ensureEngine({ signal: ctl.signal, onProgress: (x) => this.deps.send('speech:download', { what: 'engine', progress: x }) });
      await this.deps.speech.ensureModel(model, { signal: ctl.signal, onProgress: (x, got, total) => this.deps.send('speech:download', { what: 'model', model, progress: x, got, total }) });
      this.deps.send('speech:download', null);
      const info = await media.probe(this.srcPath(rel));
      if (!info.audio) { it.speech = { status: 'none', progress: 0 }; return; }
      await media.extractSpeechWav(this.srcPath(rel), wav, {
        duration: info.duration, signal: ctl.signal, onProgress: (x) => { it.speech.progress = x * 0.1; this.touch(rel); },
      });
      const res = await this.deps.speech.transcribe({
        wav, model, language: sp.language || 'auto', perWindow: !!sp.perWindow, duration: info.duration, signal: ctl.signal,
        onProgress: (x) => { it.speech.progress = 0.1 + x * 0.9; this.touch(rel); },
      });
      await fs.promises.mkdir(path.dirname(this.speechFile(rel)), { recursive: true });
      await fs.promises.writeFile(this.speechFile(rel), JSON.stringify({ rel, model, language: res.language, createdAt: Date.now(), segments: res.segments }), 'utf8');
      it.speech = { status: 'done', progress: 1, language: res.language, count: res.segments.length };
      if (!it.duration) it.duration = info.duration;
    } catch (e) {
      this.deps.send('speech:download', null);
      it.speech = e.code === 'canceled' ? { status: 'canceled', progress: 0 } : { status: 'error', progress: 0, error: this.deps.errText(e) };
    } finally {
      fs.promises.rm(wav, { force: true }).catch(() => {});
      this.speechActive.delete(rel);
      this.touch(rel);
      this.save();
      this.pump();
    }
  }

  async transcript(rel) {
    try { return JSON.parse(await fs.promises.readFile(this.speechFile(rel), 'utf8')); } catch { return null; }
  }

  // --- Temizlik -------------------------------------------------------------------------
  async deleteOutputs({ rels, transcripts = false } = {}) {
    if (!rels) this.stop();
    const list = rels || Object.keys(this.state.items);
    for (const rel of list) {
      if (this.active.has(rel)) continue;
      const it = this.state.items[rel];
      if (!it) continue;
      await fs.promises.rm(this.outPath(rel), { force: true }).catch(() => {});
      Object.assign(it, { status: 'pending', progress: 0, outSize: 0, error: '' });
      if (transcripts) { delete it.speech; await fs.promises.rm(this.speechFile(rel), { force: true }).catch(() => {}); }
      this.touch(rel);
    }
    if (!rels) {
      await fs.promises.rm(this.outDir, { recursive: true, force: true }).catch(() => {});
      if (transcripts) await fs.promises.rm(path.join(this.workDir, 'speech'), { recursive: true, force: true }).catch(() => {});
    }
    this.save();
    this.emitState();
  }

  isBusy() { return this.active.size > 0 || this.speechActive.size > 0 || this.queue.length > 0 || this.speechQueue.length > 0; }

  close() {
    this.stop();
    this.closed = true;
    this.flush();
    this.saveNow();
  }
}

module.exports = { ProjectRunner, scanFolder, dirSize };
