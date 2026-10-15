'use strict';

const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog, nativeTheme, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');
const I18N = require('./i18n');
const FORMATS = require('./formats');
const media = require('./media');
const { createAccount, apiBase } = require('./account');
const { ProjectRunner, dirSize } = require('./jobs');
const { createSpeech, exportTranscript } = require('./speech');

// Arayüz dili: ayarlarda seçilen ya da sistem dili (desteklenmiyorsa İngilizce)
let t = I18N.createT('en');
const currentLang = () => (store && store.settings.language) || I18N.resolveLanguage(app.getLocale());
function applyLanguage() { t = I18N.createT(currentLang()); }

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const userDir = (...p) => path.join(app.getPath('userData'), ...p);

// Önizleme ve yerel dosyalar için özel şema (Range destekli; video ileri/geri sarılabilir)
protocol.registerSchemesAsPrivileged([{ scheme: 'cvm', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);

// ---------------------------------------------------------------------------
// Hata metinleri
// ---------------------------------------------------------------------------
function errText(err) {
  const code = err && err.code;
  const map = {
    canceled: 'err.canceled', no_video: 'err.noVideo', no_audio: 'err.noAudio', unsupported: 'err.unsupported',
    ffmpeg_missing: 'err.ffmpegMissing', engine_missing: 'err.engineMissing', download_failed: 'err.download',
    ENOENT: 'err.notFound', EACCES: 'err.access', EPERM: 'err.access', EBUSY: 'err.busy', ENOSPC: 'err.noSpace',
  };
  if (map[code]) return t(map[code], { msg: err.message || '' });
  if (code === 'ffmpeg_failed') return t('err.ffmpeg', { msg: err.message });
  if (code === 'whisper_failed') return t('err.whisper', { msg: err.message });
  return String((err && err.message) || err || 'error');
}

// ---------------------------------------------------------------------------
// Kalıcı depo (userData/store.json)
// ---------------------------------------------------------------------------
const storePath = () => userDir('store.json');

const defaultStore = () => ({
  folders: [],   // { id, name, parentId }
  projects: [],  // proje tanımları (senkronlanır), bkz. project:save
  local: {},     // cihaza özgü: projeId -> { sourcePath, unchecked: [rel] }
  syncMeta: {},  // senkron: öğe id -> { kind, hash, updated_at, rev, device, deleted }
  settings: {
    appTheme: 'dark',        // 'dark' | 'light' | 'system'
    language: null,          // null = sistem dili
    defaultConcurrency: 2,   // yeni projelerde aynı anda çevrilecek dosya sayısı
    speechModel: 'base',     // yeni projelerde konuşma modeli
    speechConcurrency: 1,    // aynı anda metne çevrilecek dosya (whisper işlemciyi yoğun kullanır)
    // görünüm (cihaza özgü, sessiz kaydedilir)
    previewHeight: 320,
    treeWidth: 280,
    transcriptWidth: 380,
    linkPreview: true,
  },
});

let store = null;
const uid = () => crypto.randomBytes(8).toString('hex');

function loadStore() {
  applyLanguage();
  try {
    store = { ...defaultStore(), ...JSON.parse(fs.readFileSync(storePath(), 'utf8')) };
    store.settings = { ...defaultStore().settings, ...(store.settings || {}) };
    if (!store.syncMeta) store.syncMeta = {};
    if (!store.local) store.local = {};
  } catch {
    store = defaultStore();
  }
  applyAppTheme();
  applyLanguage();
}

function applyAppTheme() {
  const v = store.settings.appTheme;
  nativeTheme.themeSource = v === 'light' || v === 'system' ? v : 'dark';
}
const windowBg = () => (nativeTheme.shouldUseDarkColors ? '#0b0f17' : '#eef2f7');

let saveTimer = null;
// Kütüphane değişikliği kaydedilir ve (3 sn sonra) senkron tetiklenir; cihaza özgü kayıtlar için { sync: false }
function saveStore({ sync = true } = {}) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeStore, 150);
  if (sync && account) account.onLocalChange();
}
function writeStore() {
  saveTimer = null;
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
}

function encrypt(text) {
  if (!text) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64');
  return 'b64:' + Buffer.from(text, 'utf8').toString('base64');
}
function decrypt(value) {
  if (!value) return '';
  if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
  if (value.startsWith('b64:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
  return value;
}

const getLocal = (id) => store.local[id] || (store.local[id] = { sourcePath: '', unchecked: [] });

function publicStore() {
  return {
    folders: store.folders,
    settings: store.settings,
    projects: store.projects.map((p) => ({ ...p, sourcePath: getLocal(p.id).sourcePath || '' })),
  };
}

function broadcastStore() {
  const data = publicStore();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('store:changed', data);
}

// ---------------------------------------------------------------------------
// Mastertool hesabı (convertmaster.app) ve uçtan uca şifreli senkron
// ---------------------------------------------------------------------------
let account = null;
let loginWindow = null;
let loginNotice = null;

function initAccount() {
  account = createAccount({
    userDataDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    encrypt,
    decrypt,
    getStore: () => store,
    replaceLibrary: ({ folders, projects, settings, syncMeta }) => {
      const prevLang = currentLang();
      Object.assign(store, { folders, projects, syncMeta });
      Object.assign(store.settings, settings);
      writeStore();
      applyAppTheme();
      applyLanguage();
      broadcastStore();
      for (const r of runners.values()) { r.computeOutputs(); r.pump(); }
      for (const [pid, w] of projectWindows) {
        if (!store.projects.some((p) => p.id === pid)) w.destroy(); // başka cihazda silindi
        else w.webContents.send('project:changed', projectFor(pid));
      }
      if (currentLang() !== prevLang && mainWindow) mainWindow.webContents.reload();
    },
    persistStore: writeStore,
    backupAndClearLibrary: () => {
      const hasData = store.projects.length || store.folders.length;
      let file = null;
      if (hasData) {
        file = userDir(`store-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
      }
      Object.assign(store, { folders: [], projects: [], local: {}, syncMeta: {} });
      writeStore();
      return file;
    },
    onStatus: (st) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('account:status', st);
    },
    onSessionExpired: (code) =>
      showLogin(t(code === 'app_disabled' ? 'auth.errAppDisabled' : code === 'wrong_app' ? 'auth.errWrongApp' : 'auth.errSessionExpired')),
    onUpdate: (info) => mainWindow && mainWindow.webContents.send('app:update', info),
  });
}

// ---------------------------------------------------------------------------
// Pencereler
// ---------------------------------------------------------------------------
let mainWindow = null;
const projectWindows = new Map(); // projeId -> BrowserWindow
const webPreferences = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false };

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 440, height: 640, resizable: false, maximizable: false, backgroundColor: windowBg(),
    title: 'Convert Master', icon: ICON, autoHideMenuBar: true, webPreferences,
  });
  loginWindow.setMenuBarVisibility(false);
  loginWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));
  loginWindow.on('closed', () => (loginWindow = null));
}

// Oturum yoksa ya da düştüyse: giriş ekranını aç, diğer tüm pencereleri kapat (süren işler durur)
function showLogin(notice) {
  loginNotice = notice || null;
  if (!loginWindow) createLoginWindow();
  else loginWindow.focus();
  for (const r of runners.values()) r.close();
  runners.clear();
  for (const w of BrowserWindow.getAllWindows()) if (w !== loginWindow) { w.forceClose = true; w.destroy(); }
  projectWindows.clear();
  mainWindow = null;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 760, minWidth: 760, minHeight: 500, backgroundColor: windowBg(),
    title: 'Convert Master', icon: ICON, autoHideMenuBar: true, webPreferences,
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => (mainWindow = null));
}

function showMainWindow() {
  if (!account || !account.isLoggedIn()) {
    if (loginWindow) loginWindow.focus(); else showLogin();
    return;
  }
  if (!mainWindow) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function projectFor(id) {
  const p = store.projects.find((x) => x.id === id);
  return p ? { ...p, sourcePath: getLocal(id).sourcePath || '' } : null;
}

function openProjectWindow(id) {
  if (!account || !account.isLoggedIn()) return;
  const p = store.projects.find((x) => x.id === id);
  if (!p) return;
  const existing = projectWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 920, minHeight: 560, backgroundColor: windowBg(),
    title: `${p.name} — Convert Master`, icon: ICON, autoHideMenuBar: true, webPreferences,
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'project.html'), { query: { id } });
  projectWindows.set(id, win);
  win.on('close', (e) => {
    const r = runners.get(id);
    if (!r || win.forceClose || !r.isBusy()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: [t('main.closeAnyway'), t('common.cancel')], defaultId: 1, cancelId: 1,
      title: 'Convert Master', message: t('main.closeActive'),
    });
    if (choice !== 0) e.preventDefault();
  });
  win.on('closed', () => {
    projectWindows.delete(id);
    const r = runners.get(id);
    if (r) { r.close(); runners.delete(id); }
    broadcastStats();
  });
}

// ---------------------------------------------------------------------------
// Proje çalıştırıcıları ve konuşma motoru
// ---------------------------------------------------------------------------
const runners = new Map(); // projeId -> ProjectRunner
let speech = null;

function getRunner(id) {
  let r = runners.get(id);
  if (!r) {
    r = new ProjectRunner(id, {
      userDataDir: app.getPath('userData'),
      getProject: (pid) => store.projects.find((x) => x.id === pid),
      getLocal,
      getSettings: () => store.settings,
      speech,
      errText,
      send: (ch, data) => {
        const w = projectWindows.get(id);
        if (w && !w.isDestroyed()) w.webContents.send(ch, data);
        if (ch === 'job:finished') broadcastStats();
      },
    });
    runners.set(id, r);
  }
  return r;
}

// Pencereden gelen isteğin projesi (URL'deki ?id=)
function senderProject(event) {
  const id = new URL(event.sender.getURL()).searchParams.get('id');
  if (!id || !store.projects.some((p) => p.id === id)) throw new Error(t('main.errProjectNotFound'));
  return id;
}

// Ana penceredeki kartlar için özet (dönüştürülen / hatalı / toplam)
function projectStats() {
  const out = {};
  for (const p of store.projects) {
    let st = null;
    const r = runners.get(p.id);
    if (r) st = r.state;
    else { try { st = JSON.parse(fs.readFileSync(userDir('work', p.id, 'state.json'), 'utf8')); } catch { st = null; } }
    const items = st ? Object.values(st.items || {}) : [];
    out[p.id] = {
      done: items.filter((x) => x.status === 'done').length,
      error: items.filter((x) => x.status === 'error').length,
      running: !!(r && r.isBusy()),
    };
  }
  return out;
}
function broadcastStats() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('projects:stats', projectStats());
}

// ---------------------------------------------------------------------------
// Önizleme: cvm://media/<anahtar> → yerel dosya
// ---------------------------------------------------------------------------
const mediaTokens = new Map(); // anahtar -> mutlak yol
const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  ico: 'image/x-icon', svg: 'image/svg+xml',
};

function mediaUrl(abs) {
  const key = crypto.createHash('sha1').update(abs).digest('hex');
  mediaTokens.set(key, abs);
  let v = 0;
  try { v = Math.round(fs.statSync(abs).mtimeMs); } catch { /* yok */ }
  return `cvm://media/${key}/${encodeURIComponent(path.basename(abs))}?v=${v}`;
}

function registerMediaProtocol() {
  protocol.handle('cvm', async (req) => {
    const u = new URL(req.url);
    const key = u.pathname.split('/')[1];
    const abs = mediaTokens.get(key);
    if (u.host !== 'media' || !abs) return new Response('not found', { status: 404 });
    let st;
    try { st = await fs.promises.stat(abs); } catch { return new Response('not found', { status: 404 }); }
    const type = MIME[FORMATS.extOf(abs)] || 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
    if (range && st.size) {
      const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
      return new Response(Readable.toWeb(fs.createReadStream(abs, { start, end })), {
        status: 206,
        headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes' },
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(abs)), {
      status: 200, headers: { 'Content-Type': type, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes' },
    });
  });
}

const cacheDir = () => userDir('cache', 'preview');
async function cacheKey(abs) {
  const st = await fs.promises.stat(abs);
  return crypto.createHash('sha1').update(`${abs}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
}

// Önizleme bilgisi: oynatılabilir adres, bilgi, video için kare, ses için dalga biçimi
async function previewFor(abs, kind) {
  const ext = FORMATS.extOf(abs);
  const info = await media.mediaInfo(abs);
  const key = await cacheKey(abs);
  const T = FORMATS.TYPES;
  // Videodan ses çıkarıldıysa çıktı bir ses dosyasıdır
  const k = kind === 'video' && T.video.audioOnlyTargets.includes(ext) ? 'audio' : kind === 'video' && ext === 'gif' ? 'image' : kind;
  const out = { kind: k, info, name: path.basename(abs), path: abs };
  if (k === 'image') {
    if (T.image.play.includes(ext)) out.url = mediaUrl(abs);
    else {
      const png = path.join(cacheDir(), `${key}.png`);
      if (!fs.existsSync(png)) await media.previewCopy(abs, png, 'image');
      out.url = mediaUrl(png);
    }
    return out;
  }
  if (k === 'audio') {
    const wave = path.join(cacheDir(), `${key}.wave.png`);
    try { if (!fs.existsSync(wave)) await media.waveform(abs, wave); out.waveform = mediaUrl(wave); } catch { /* sessiz */ }
    if (T.audio.play.includes(ext)) out.url = mediaUrl(abs);
    else {
      const mp3 = path.join(cacheDir(), `${key}.mp3`);
      if (!fs.existsSync(mp3)) await media.previewCopy(abs, mp3, 'audio', { duration: info.duration });
      out.url = mediaUrl(mp3);
    }
    return out;
  }
  // video
  const poster = path.join(cacheDir(), `${key}.jpg`);
  try { if (!fs.existsSync(poster)) await media.poster(abs, poster, info.duration); out.poster = mediaUrl(poster); } catch { /* kare alınamadı */ }
  const proxy = path.join(cacheDir(), `${key}.mp4`);
  if (fs.existsSync(proxy)) { out.url = mediaUrl(proxy); out.proxy = true; } else if (T.video.play.includes(ext)) out.url = mediaUrl(abs);
  else out.needProxy = true;
  return out;
}

async function cleanupCache(maxAgeDays = 14) {
  const dir = cacheDir();
  let entries = [];
  try { entries = await fs.promises.readdir(dir); } catch { return; }
  const limit = Date.now() - maxAgeDays * 86400000;
  for (const n of entries) {
    const p = path.join(dir, n);
    try { if ((await fs.promises.stat(p)).atimeMs < limit) await fs.promises.rm(p, { force: true }); } catch { /* kullanımda */ }
  }
}

// ---------------------------------------------------------------------------
// IPC — hesap
// ---------------------------------------------------------------------------
ipcMain.handle('account:state', () => ({ ...account.state(), notice: loginNotice, appVersion: app.getVersion() }));

ipcMain.handle('account:login', async (_e, { email, password, remember }) => {
  try {
    const { backupFile } = await account.login(email, password, remember);
    loginNotice = null;
    if (!mainWindow) createMainWindow();
    if (loginWindow) loginWindow.destroy();
    if (backupFile) mainWindow.webContents.once('did-finish-load', () => mainWindow.webContents.send('account:backup', backupFile));
    account.start();
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.code || 'error', message: e.message };
  }
});

ipcMain.handle('account:logout', async () => {
  await account.logout();
  showLogin();
});
ipcMain.handle('account:syncNow', () => account.syncNow());
ipcMain.handle('account:setSync', async (_e, on) => {
  try { await account.setSyncEnabled(on); return { ok: true }; } catch (e) { return { ok: false, code: e.code }; }
});
ipcMain.handle('account:deleteRemote', async () => {
  try { await account.deleteRemote(); return { ok: true }; } catch (e) { return { ok: false, code: e.code }; }
});

// Mastertool düğmesi: portal, uygulamanın dili ve o anki gece/gündüz temasıyla tarayıcıda açılır
ipcMain.handle('app:openMastertool', () => {
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  shell.openExternal(`https://mastertool.download/?lang=${encodeURIComponent(currentLang())}&theme=${theme}`);
});

// Hesap sayfaları varsayılan tarayıcıda açılır (yalnız bu adresler)
ipcMain.handle('account:openWeb', (_e, page) => {
  const allowed = { forgot: '/sifremi-unuttum', register: '/kayit', account: '/hesabim' };
  if (!allowed[page]) return;
  const base = apiBase();
  shell.openExternal(base + allowed[page] + (base.includes('mastertool.download') ? '?app=cv' : ''));
});
ipcMain.on('app:lang', (e) => { e.returnValue = currentLang(); });
ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });
ipcMain.handle('app:showMain', () => showMainWindow());

// ---------------------------------------------------------------------------
// IPC — depo, projeler, klasörler
// ---------------------------------------------------------------------------
ipcMain.handle('store:get', () => publicStore());
ipcMain.handle('projects:stats', () => projectStats());

const num = (v, def, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};
const oneOf = (v, list, def) => (list.includes(v) ? v : def);

function cleanOptions(o = {}) {
  const d = FORMATS.defaultOptions();
  const v = o.video || {};
  const i = o.image || {};
  const a = o.audio || {};
  return {
    video: {
      quality: oneOf(v.quality, FORMATS.QUALITY, d.video.quality),
      resolution: oneOf(String(v.resolution), FORMATS.RESOLUTIONS, d.video.resolution),
      fps: oneOf(String(v.fps), FORMATS.FPS, d.video.fps),
      codec: oneOf(v.codec, ['h264', 'h265'], d.video.codec),
      speed: oneOf(v.speed, ['veryfast', 'fast', 'medium', 'slow'], d.video.speed),
      audioBitrate: oneOf(String(v.audioBitrate), FORMATS.AUDIO_BITRATES, d.video.audioBitrate),
      noAudio: !!v.noAudio,
    },
    image: {
      quality: num(i.quality, d.image.quality, 1, 100),
      maxWidth: num(i.maxWidth, 0, 0, 20000),
      maxHeight: num(i.maxHeight, 0, 0, 20000),
      keepMeta: !!i.keepMeta,
    },
    audio: {
      bitrate: oneOf(String(a.bitrate), FORMATS.AUDIO_BITRATES, d.audio.bitrate),
      sampleRate: oneOf(String(a.sampleRate), FORMATS.SAMPLE_RATES, d.audio.sampleRate),
      channels: oneOf(a.channels, ['source', 'stereo', 'mono'], d.audio.channels),
    },
  };
}

ipcMain.handle('project:save', (_e, form) => {
  let p = form.id ? store.projects.find((x) => x.id === form.id) : null;
  const isNew = !p;
  if (!p) {
    p = { id: uid(), createdAt: Date.now() };
    store.projects.push(p);
  }
  const type = oneOf(form.type, Object.keys(FORMATS.TYPES), 'video');
  const T = FORMATS.TYPES[type];
  const sourceExts = [...new Set((form.sourceExts || []).filter((x) => T.source.includes(x)))];
  const prevTarget = p.targetExt;
  Object.assign(p, {
    name: String(form.name || '').trim().slice(0, 120) || t('main.untitled'),
    type,
    sourceExts: sourceExts.length ? sourceExts : [...T.defaultSource],
    targetExt: oneOf(form.targetExt, T.target, T.defaultTarget),
    sourceMode: form.sourceMode === 'file' ? 'file' : 'folder',
    includeSubfolders: form.includeSubfolders !== false,
    concurrency: num(form.concurrency, store.settings.defaultConcurrency || 2, 1, 32),
    speech: {
      enabled: (type === 'video' || type === 'audio') && !!(form.speech && form.speech.enabled),
      model: oneOf(form.speech && form.speech.model, Object.keys(FORMATS.SPEECH_MODELS), store.settings.speechModel || 'base'),
      language: oneOf(form.speech && form.speech.language, FORMATS.SPEECH_LANGS, 'auto'),
      perWindow: !!(form.speech && form.speech.perWindow),
    },
    options: cleanOptions(form.options),
    folderId: form.folderId ?? p.folderId ?? null,
    color: form.color || p.color || T.color,
    notes: String(form.notes || '').slice(0, 2000),
  });
  if (typeof form.sourcePath === 'string') {
    const loc = getLocal(p.id);
    if (loc.sourcePath !== form.sourcePath) { loc.sourcePath = form.sourcePath; loc.unchecked = []; }
  }
  saveStore();
  broadcastStore();
  const r = runners.get(p.id);
  if (r) {
    if (!isNew && prevTarget !== p.targetExt) r.computeOutputs();
    r.pump();
  }
  const w = projectWindows.get(p.id);
  if (w) { w.setTitle(`${p.name} — Convert Master`); w.webContents.send('project:changed', projectFor(p.id)); }
  return p.id;
});

ipcMain.handle('project:delete', async (_e, id) => {
  const w = projectWindows.get(id);
  if (w) { w.forceClose = true; w.destroy(); }
  const r = runners.get(id);
  if (r) { r.close(); runners.delete(id); }
  store.projects = store.projects.filter((p) => p.id !== id);
  delete store.local[id];
  saveStore();
  broadcastStore();
  await fs.promises.rm(userDir('converted', id), { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(userDir('work', id), { recursive: true, force: true }).catch(() => {});
});

ipcMain.handle('project:duplicate', (_e, id) => {
  const p = store.projects.find((x) => x.id === id);
  if (!p) return;
  const copy = { ...JSON.parse(JSON.stringify(p)), id: uid(), name: p.name + t('main.copySuffix'), createdAt: Date.now() };
  store.projects.push(copy);
  store.local[copy.id] = { sourcePath: getLocal(id).sourcePath || '', unchecked: [...(getLocal(id).unchecked || [])] };
  saveStore();
  broadcastStore();
});

ipcMain.handle('project:move', (_e, { id, folderId }) => {
  const p = store.projects.find((x) => x.id === id);
  if (p) p.folderId = folderId || null;
  saveStore();
  broadcastStore();
});

ipcMain.handle('project:open', (_e, id) => openProjectWindow(id));

ipcMain.handle('project:clearOutputs', async (_e, { id, transcripts }) => {
  const r = runners.get(id) || getRunner(id);
  await r.deleteOutputs({ transcripts });
  if (!projectWindows.has(id)) { r.close(); runners.delete(id); }
  broadcastStats();
});

ipcMain.handle('folder:save', (_e, { id, name, parentId }) => {
  let f = id ? store.folders.find((x) => x.id === id) : null;
  if (!f) {
    f = { id: uid(), parentId: parentId || null };
    store.folders.push(f);
  }
  f.name = String(name).trim();
  saveStore();
  broadcastStore();
  return f.id;
});

ipcMain.handle('folder:move', (_e, { id, parentId }) => {
  let p = parentId;
  while (p) {
    if (p === id) return false;
    p = (store.folders.find((x) => x.id === p) || {}).parentId;
  }
  const f = store.folders.find((x) => x.id === id);
  if (f) f.parentId = parentId || null;
  saveStore();
  broadcastStore();
  return true;
});

ipcMain.handle('folder:delete', (_e, id) => {
  const f = store.folders.find((x) => x.id === id);
  if (!f) return;
  for (const p of store.projects) if (p.folderId === id) p.folderId = f.parentId || null;
  for (const sub of store.folders) if (sub.parentId === id) sub.parentId = f.parentId || null;
  store.folders = store.folders.filter((x) => x.id !== id);
  saveStore();
  broadcastStore();
});

// Görünüm ayarları (panel boyutları vb.) sessizce kaydedilir, yayınlanmaz ve senkronlanmaz
const QUIET_SETTINGS = ['previewHeight', 'treeWidth', 'transcriptWidth', 'linkPreview'];

ipcMain.handle('settings:set', (_e, patch) => {
  Object.assign(store.settings, patch);
  const loud = Object.keys(patch).some((k) => !QUIET_SETTINGS.includes(k));
  saveStore({ sync: loud });
  if ('appTheme' in patch) applyAppTheme();
  if ('language' in patch) {
    applyLanguage();
    if (mainWindow) mainWindow.webContents.reload();
    if (loginWindow) loginWindow.webContents.reload();
    return;
  }
  if (loud) broadcastStore();
  if ('speechConcurrency' in patch) for (const r of runners.values()) r.pump();
});

// --- Dosya / klasör seçimi -------------------------------------------------------------
// Tür: video / resim / ses; uzantılar: projede seçilen kaynak uzantıları (önce), sonra türün tümü
ipcMain.handle('dialog:pickSource', async (event, { mode, type, exts, defaultPath }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const T = FORMATS.TYPES[type] || FORMATS.TYPES.video;
  if (mode === 'folder') {
    const r = await dialog.showOpenDialog(win, { title: t('main.pickFolder'), defaultPath: defaultPath || os.homedir(), properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  }
  const sel = (exts || []).filter((x) => T.source.includes(x));
  const filters = [];
  if (sel.length && sel.length < T.source.length) filters.push({ name: sel.map((x) => x.toUpperCase()).join(', '), extensions: sel });
  filters.push({ name: t(`type.${type}All`), extensions: T.source });
  const r = await dialog.showOpenDialog(win, { title: t('main.pickFile'), defaultPath: defaultPath || os.homedir(), properties: ['openFile'], filters });
  return r.canceled ? null : r.filePaths[0];
});

// ---------------------------------------------------------------------------
// IPC — proje penceresi
// ---------------------------------------------------------------------------
const wrap = (fn) => async (event, arg) => {
  try {
    return await fn(event, arg);
  } catch (err) {
    throw new Error(errText(err));
  }
};

ipcMain.handle('pj:init', wrap(async (event) => {
  const id = senderProject(event);
  const r = getRunner(id);
  const snap = await r.scan();
  return { project: projectFor(id), snapshot: snap };
}));

ipcMain.handle('pj:scan', wrap((event) => getRunner(senderProject(event)).scan()));

ipcMain.handle('pj:check', wrap((event, { rels, checked }) => {
  const id = senderProject(event);
  const loc = getLocal(id);
  const set = new Set(loc.unchecked || []);
  for (const rel of rels) { if (checked) set.delete(rel); else set.add(rel); }
  loc.unchecked = [...set];
  saveStore({ sync: false });
  getRunner(id).onSelectionChanged();
}));

ipcMain.handle('pj:start', wrap((event, opts) => getRunner(senderProject(event)).start(opts || {})));
ipcMain.handle('pj:stop', wrap((event) => getRunner(senderProject(event)).stop()));
ipcMain.handle('pj:transcribe', wrap((event, rels) => getRunner(senderProject(event)).transcribeOnly(rels)));
ipcMain.handle('pj:transcript', wrap((event, rel) => getRunner(senderProject(event)).transcript(rel)));
ipcMain.handle('pj:deleteOutputs', wrap(async (event, opts) => {
  await getRunner(senderProject(event)).deleteOutputs(opts || {});
  broadcastStats();
}));

ipcMain.handle('pj:setConcurrency', wrap((event, n) => {
  const id = senderProject(event);
  const p = store.projects.find((x) => x.id === id);
  p.concurrency = num(n, p.concurrency, 1, 32);
  saveStore();
  broadcastStore();
  getRunner(id).pump();
  return p.concurrency;
}));

ipcMain.handle('pj:changeSource', wrap(async (event) => {
  const id = senderProject(event);
  const p = store.projects.find((x) => x.id === id);
  const r = getRunner(id);
  if (r.isBusy()) r.stop();
  const loc = getLocal(id);
  const picked = await ipcMainPick(event, p, loc.sourcePath);
  if (!picked) return null;
  if (p.sourceMode === 'file') {
    const ext = FORMATS.extOf(picked);
    if (!p.sourceExts.includes(ext)) { p.sourceExts = [...p.sourceExts, ext]; saveStore(); }
  }
  loc.sourcePath = picked;
  loc.unchecked = [];
  saveStore({ sync: false });
  broadcastStore();
  event.sender.send('project:changed', projectFor(id));
  return r.scan();
}));

async function ipcMainPick(event, p, current) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const T = FORMATS.TYPES[p.type];
  const defaultPath = current ? (p.sourceMode === 'file' ? path.dirname(current) : current) : os.homedir();
  if (p.sourceMode === 'folder') {
    const r = await dialog.showOpenDialog(win, { title: t('main.pickFolder'), defaultPath, properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  }
  const filters = [{ name: p.sourceExts.map((x) => x.toUpperCase()).join(', '), extensions: p.sourceExts }, { name: t(`type.${p.type}All`), extensions: T.source }];
  const r = await dialog.showOpenDialog(win, { title: t('main.pickFile'), defaultPath, properties: ['openFile'], filters });
  return r.canceled ? null : r.filePaths[0];
}

// Önizleme: which = 'src' | 'out'
ipcMain.handle('pj:preview', wrap(async (event, { rel, which }) => {
  const id = senderProject(event);
  const r = getRunner(id);
  const p = store.projects.find((x) => x.id === id);
  const abs = which === 'out' ? r.outPath(rel) : r.srcPath(rel);
  if (!fs.existsSync(abs)) return null;
  return previewFor(abs, p.type);
}));

// Chromium'un oynatamadığı video için 480p önizleme kopyası (ilerleme: preview:progress)
ipcMain.handle('pj:proxy', wrap(async (event, { rel, which }) => {
  const id = senderProject(event);
  const r = getRunner(id);
  const abs = which === 'out' ? r.outPath(rel) : r.srcPath(rel);
  const info = await media.probe(abs);
  const out = path.join(cacheDir(), `${await cacheKey(abs)}.mp4`);
  if (!fs.existsSync(out)) {
    await media.previewCopy(abs, out, 'video', {
      duration: info.duration,
      onProgress: (x) => !event.sender.isDestroyed() && event.sender.send('preview:progress', { rel, which, progress: x }),
    });
  }
  return mediaUrl(out);
}));

ipcMain.handle('pj:open', wrap(async (event, { rel, which }) => {
  const r = getRunner(senderProject(event));
  const abs = which === 'out' ? r.outPath(rel) : r.srcPath(rel);
  const err = await shell.openPath(abs);
  if (err) throw new Error(err);
}));
ipcMain.handle('pj:reveal', wrap((event, { rel, which }) => {
  const r = getRunner(senderProject(event));
  shell.showItemInFolder(which === 'out' ? r.outPath(rel) : r.srcPath(rel));
}));
ipcMain.handle('pj:openOutDir', wrap(async (event) => {
  const r = getRunner(senderProject(event));
  await fs.promises.mkdir(r.outDir, { recursive: true });
  shell.openPath(r.outDir);
}));

// Dönüştürülmüş dosyaları (klasör yapısıyla) kullanıcının seçtiği yere kopyalar
ipcMain.handle('pj:exportOutputs', wrap(async (event, rels) => {
  const id = senderProject(event);
  const r = getRunner(id);
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, { title: t('main.exportTo'), properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled) return null;
  const dest = res.filePaths[0];
  const list = (rels && rels.length ? rels : Object.keys(r.state.items)).filter((rel) => (r.state.items[rel] || {}).status === 'done');
  let n = 0;
  for (const rel of list) {
    const src = r.outPath(rel);
    if (!fs.existsSync(src)) continue;
    const target = path.join(dest, path.relative(r.outDir, src));
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(src, target);
    n++;
  }
  return { count: n, dest };
}));

ipcMain.handle('pj:exportTranscript', wrap(async (event, { rel, format }) => {
  const r = getRunner(senderProject(event));
  const tr = await r.transcript(rel);
  if (!tr) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  const base = path.basename(rel, path.extname(rel));
  const res = await dialog.showSaveDialog(win, {
    title: t('main.saveTranscript'), defaultPath: path.join(app.getPath('documents'), `${base}.${format}`),
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.promises.writeFile(res.filePath, exportTranscript(tr.segments || [], format), 'utf8');
  return res.filePath;
}));

ipcMain.handle('pj:outSize', wrap((event) => dirSize(getRunner(senderProject(event)).outDir)));

// ---------------------------------------------------------------------------
// IPC — konuşma motoru ve depolama (ayarlar)
// ---------------------------------------------------------------------------
const downloads = new Map(); // model -> AbortController

ipcMain.handle('speech:status', () => ({ ...speech.status(), downloading: [...downloads.keys()] }));
ipcMain.handle('speech:download', async (event, model) => {
  if (downloads.has(model)) return { ok: true };
  const ctl = new AbortController();
  downloads.set(model, ctl);
  const send = (x) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('speech:download', x); };
  try {
    await speech.ensureEngine({ signal: ctl.signal, onProgress: (p) => send({ what: 'engine', progress: p }) });
    await speech.ensureModel(model, { signal: ctl.signal, onProgress: (p, got, total) => send({ what: 'model', model, progress: p, got, total }) });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: ctl.signal.aborted ? t('err.canceled') : errText(e) };
  } finally {
    downloads.delete(model);
    send(null);
  }
});
ipcMain.handle('speech:cancelDownload', (_e, model) => downloads.get(model)?.abort());
ipcMain.handle('speech:deleteModel', (_e, model) => speech.deleteModel(model));

ipcMain.handle('storage:info', async () => ({
  converted: await dirSize(userDir('converted')),
  cache: await dirSize(cacheDir()),
  models: await dirSize(userDir('models')),
  dir: app.getPath('userData'),
}));
ipcMain.handle('storage:clearConverted', async (_e, { transcripts } = {}) => {
  for (const p of store.projects) {
    const r = runners.get(p.id) || getRunner(p.id);
    await r.deleteOutputs({ transcripts });
    if (!projectWindows.has(p.id)) { r.close(); runners.delete(p.id); }
  }
  await fs.promises.rm(userDir('converted'), { recursive: true, force: true }).catch(() => {});
  broadcastStats();
});
ipcMain.handle('storage:clearCache', () => fs.promises.rm(cacheDir(), { recursive: true, force: true }).catch(() => {}));
ipcMain.handle('storage:open', async (_e, which) => {
  const dir = which === 'converted' ? userDir('converted') : which === 'models' ? userDir('models') : app.getPath('userData');
  await fs.promises.mkdir(dir, { recursive: true });
  shell.openPath(dir);
});

// ---------------------------------------------------------------------------
app.setAppUserModelId('com.convertmaster.app');

app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e) => e.preventDefault());
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    registerMediaProtocol();
    loadStore();
    speech = createSpeech({
      userDataDir: app.getPath('userData'),
      resourcesDir: app.isPackaged ? process.resourcesPath : null,
      devDir: path.join(__dirname, '..', 'vendor', 'whisper'),
      fetch: (url, opts) => net.fetch(url, opts), // sistem proxy ayarlarına uyar
    });
    initAccount();
    cleanupCache().catch(() => {});
    // Uygulama girişsiz açılmaz. "Beni hatırla" ile saklı oturum varsa doğrudan açılır
    // (çevrimdışıyken yerel kütüphaneyle), oturum sunucuda düşmüşse giriş ekranına dönülür.
    if (account.isLoggedIn()) {
      createMainWindow();
      account.start();
    } else {
      createLoginWindow();
    }
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && showMainWindow());
  });

  app.on('window-all-closed', () => {
    for (const r of runners.values()) r.close();
    if (saveTimer) { clearTimeout(saveTimer); writeStore(); }
    app.quit();
  });
}
