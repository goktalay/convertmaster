'use strict';

// Mastertool hesabı ve uçtan uca şifreli proje kütüphanesi senkronu (convertmaster.app, sözleşme v1).
// SSH Master / FTP Masters'taki account.js'in Convert Master uyarlaması: uçlar /api/cv/*, şifreleme anahtarı "cvm-enc-v1".
// Senkronlanan: proje tanımları (ad, tür, uzantılar, kaynak türü, ayarlar), proje klasörleri ve genel ayarlar.
// Senkronlanmayan: dosyaların kendisi, kaynak yolları, seçimler, çıktılar ve metinler (cihaza özgü).
//
// Anahtarlar istemcide türetilir; sunucu ne şifreyi ne de şifreleme anahtarını görür:
//   master   = PBKDF2-SHA256(şifre, salt, iter, 32B)
//   encKey   = HKDF-SHA256(master, salt = boş, info = "cvm-enc-v1", 32B)   → AES-256-GCM
//   authHash = base64(PBKDF2-SHA256(master, şifre, 1, 32B))                → girişte gönderilen tek değer
// Kütüphane blob'u: base64(iv12 ‖ şifreli metin ‖ tag16), açık metni { schema: 1, items: [...] }.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const API_BASES = process.env.CVM_API ? [process.env.CVM_API] : ['https://convertmaster.app', 'https://mastertool.download'];
const SYNC_DEBOUNCE_MS = 3000;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BLOB_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Kriptografi
// ---------------------------------------------------------------------------
const pbkdf2 = (pass, salt, iter, len) =>
  new Promise((resolve, reject) => crypto.pbkdf2(pass, salt, iter, len, 'sha256', (e, k) => (e ? reject(e) : resolve(k))));

async function deriveKeys(password, kdf) {
  if (!kdf || kdf.alg !== 'PBKDF2-SHA256') throw Object.assign(new Error('unsupported_kdf'), { code: 'unsupported_kdf' });
  const pw = Buffer.from(password, 'utf8');
  const master = await pbkdf2(pw, Buffer.from(kdf.salt, 'base64'), kdf.iter, 32);
  const authHash = (await pbkdf2(master, pw, 1, 32)).toString('base64');
  const encKey = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from('cvm-enc-v1'), 32));
  master.fill(0);
  return { authHash, encKey };
}

function encryptLibrary(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

function decryptLibrary(key, blob) {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < 29) throw Object.assign(new Error('decrypt_failed'), { code: 'decrypt_failed' });
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(buf.length - 16));
    const pt = Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch {
    throw Object.assign(new Error('decrypt_failed'), { code: 'decrypt_failed' });
  }
}

// Anahtar sırası sabit JSON (içerik değişti mi karşılaştırması için)
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const hashOf = (data) => crypto.createHash('sha256').update(stable(data)).digest('base64');

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// Asıl adres convertmaster.app; DNS hazır olana dek aynı API mastertool.download'da da var. Ağ hatasında
// (ya da JSON olmayan 404/5xx yanıtında) sıradaki adres denenir ve çalışan adres hatırlanır.
let baseIndex = 0;
const apiBase = () => API_BASES[baseIndex];

async function api(method, route, opts = {}) {
  let lastErr;
  for (let n = 0; n < API_BASES.length; n++) {
    const i = (baseIndex + n) % API_BASES.length;
    try {
      const out = await apiAt(API_BASES[i], method, route, opts);
      baseIndex = i;
      return out;
    } catch (e) {
      lastErr = e;
      if (!e.retryOther) throw e;
    }
  }
  throw lastErr;
}

async function apiAt(base, method, route, { token, body, timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(base + route, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } catch {
    throw Object.assign(new ApiError(0, 'offline', 'offline'), { retryOther: true });
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = await res.json(); } catch { /* boş gövde */ }
  if (!res.ok) {
    const code = (json && (json.code || json.detail)) || `http_${res.status}`;
    const err = new ApiError(res.status, code, json && json.message);
    err.body = json;
    if (!json && [404, 502, 503, 504, 521, 522, 523, 530].includes(res.status)) err.retryOther = true;
    throw err;
  }
  return json || {};
}

// ---------------------------------------------------------------------------
// Hesap + senkron yöneticisi
// ---------------------------------------------------------------------------
function createAccount(deps) {
  // deps: { userDataDir, appVersion, encrypt, decrypt, getStore, replaceLibrary, persistStore, backupAndClearLibrary,
  //         onStatus, onSessionExpired, onUpdate }
  const file = path.join(deps.userDataDir, 'account.json');

  // Kalıcı alanlar (token ve anahtar yalnız "Beni hatırla" seçiliyse ve DPAPI ile şifreli yazılır)
  let saved = { deviceId: crypto.randomUUID(), email: '', remember: true, lastUserId: null };
  try { saved = { ...saved, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* ilk açılış */ }

  // Oturum (bellekte)
  let session = null; // { token, user, encKey: Buffer, kdfSalt, syncEnabled }
  if (saved.token && saved.encKey) {
    try {
      session = {
        token: deps.decrypt(saved.token),
        encKey: Buffer.from(deps.decrypt(saved.encKey), 'base64'),
        user: saved.user,
        kdfSalt: saved.kdfSalt,
        syncEnabled: saved.syncEnabled !== false,
      };
    } catch { session = null; }
  }

  const status = { state: 'idle', lastSyncAt: saved.lastSyncAt || null, error: null, libraryVersion: saved.libraryVersion ?? null };

  function persist() {
    const out = { ...saved };
    if (session && saved.remember) {
      out.token = deps.encrypt(session.token);
      out.encKey = deps.encrypt(session.encKey.toString('base64'));
      out.user = session.user;
      out.kdfSalt = session.kdfSalt;
      out.syncEnabled = session.syncEnabled;
    } else {
      delete out.token; delete out.encKey;
    }
    out.lastSyncAt = status.lastSyncAt;
    out.libraryVersion = status.libraryVersion;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  }

  function publicState() {
    return {
      loggedIn: !!session,
      user: session ? session.user : null,
      email: saved.email,
      syncEnabled: session ? session.syncEnabled : false,
      ...status,
    };
  }

  function setStatus(patch) {
    Object.assign(status, patch);
    deps.onStatus(publicState());
  }

  const deviceName = () => `${os.hostname()} (Windows)`.slice(0, 120);

  // --- Kimlik doğrulama ----------------------------------------------------
  async function login(email, password, remember) {
    email = String(email || '').trim().toLowerCase();
    const pre = await api('POST', '/api/cv/auth/prelogin', { body: { email } });
    const { authHash, encKey } = await deriveKeys(password, pre.kdf);
    const res = await api('POST', '/api/cv/auth/login', {
      body: { email, auth_hash: authHash, device: deviceName(), app_version: String(deps.appVersion).slice(0, 30) },
    });
    // Sunucu girişte güncel kdf'yi döner; tuz farklıysa (şifre başka yerde değişmiş) anahtarı yeniden türet
    let key = encKey;
    if (res.kdf && res.kdf.salt !== pre.kdf.salt) key = (await deriveKeys(password, res.kdf)).encKey;

    // Farklı bir hesapla giriş: bu bilgisayardaki kütüphane başka bir hesaba ait olabilir; birleştirme yerine yedekle
    let backupFile = null;
    if (saved.lastUserId && saved.lastUserId !== res.user.id) backupFile = deps.backupAndClearLibrary();

    session = { token: res.token, user: res.user, encKey: key, kdfSalt: (res.kdf || pre.kdf).salt, syncEnabled: res.sync_enabled !== false };
    saved.email = email;
    saved.remember = !!remember;
    saved.lastUserId = res.user.id;
    if (backupFile) { status.libraryVersion = null; status.lastSyncAt = null; }
    persist();
    setStatus({ error: null });
    return { backupFile };
  }

  async function logout() {
    const token = session && session.token;
    session = null;
    stopTimers();
    persist();
    setStatus({ state: 'idle', error: null });
    if (token) api('POST', '/api/cv/auth/logout', { token }).catch(() => {});
  }

  // Oturum sunucuda geçersiz: 401 session_expired, ya da 403 app_disabled (yönetici bu hesapta
  // Convert Master'ı kapattı) / wrong_app (başka uygulamanın oturumu). Yerel kütüphane korunur.
  function expire(code = 'session_expired') {
    session = null;
    stopTimers();
    persist();
    setStatus({ state: 'idle', error: code });
    deps.onSessionExpired(code);
  }

  async function authed(method, route, body) {
    if (!session) throw new ApiError(401, 'session_expired');
    try {
      return await api(method, route, { token: session.token, body });
    } catch (e) {
      if (e.status === 401) expire('session_expired');
      else if (e.status === 403 && ['app_disabled', 'wrong_app'].includes(e.code)) expire(e.code);
      throw e;
    }
  }

  // --- Yerel kütüphane ↔ senkron öğeleri ------------------------------------
  // Her öğe: { id, kind, updated_at, rev, device, deleted, data }
  const meta = () => {
    const st = deps.getStore();
    if (!st.syncMeta) st.syncMeta = {};
    return st.syncMeta;
  };

  // Senkronlanan proje alanları (sözleşme: kind "project"). Kaynak yolu, seçim ve çıktılar cihaza özgüdür
  // (store.local[projeId]) ve gönderilmez.
  const PROJECT_FIELDS = ['createdAt', 'name', 'type', 'sourceExts', 'targetExt', 'sourceMode', 'includeSubfolders', 'concurrency',
    'speech', 'options', 'folderId', 'color', 'notes'];
  const SETTINGS_FIELDS = ['appTheme', 'language', 'defaultConcurrency', 'speechModel', 'speechConcurrency'];
  const SETTINGS_ID = 'settings';

  // Yerel deponun o anki halinden öğe verileri
  function currentData() {
    const st = deps.getStore();
    const out = new Map();
    for (const p of st.projects) {
      const data = {};
      for (const k of PROJECT_FIELDS) data[k] = p[k] ?? null;
      out.set(p.id, { kind: 'project', data });
    }
    for (const f of st.folders) out.set(f.id, { kind: 'folder', data: { name: f.name, parentId: f.parentId || null } });
    const settings = {};
    for (const k of SETTINGS_FIELDS) settings[k] = st.settings[k] ?? null;
    out.set(SETTINGS_ID, { kind: 'settings', data: settings });
    return out;
  }

  // Değişen/eklenen/silinen yerel öğelerin zaman damgasını ve rev'ini ilerlet
  function refreshMeta() {
    const m = meta();
    const now = Date.now();
    const cur = currentData();
    let changed = false;
    for (const [id, { kind, data }] of cur) {
      const h = hashOf(data);
      const old = m[id];
      if (!old || old.deleted || old.hash !== h) {
        // Bu cihazın ayarları ilk kez kayda geçiyorsa (yeni kurulum ya da yeni hesap) en eski zamanı alır;
        // böylece hesapta kayıtlı ayarlar varsayılan değerlerin üzerine yazılmaz, yoksa bunlar yüklenir.
        const fresh = id === SETTINGS_ID && !old;
        m[id] = { kind, hash: h, updated_at: fresh ? 0 : now, rev: (old ? old.rev : 0) + 1, device: saved.deviceId, deleted: false };
        changed = true;
      }
    }
    for (const [id, old] of Object.entries(m)) {
      if (!cur.has(id) && !old.deleted) {
        m[id] = { ...old, hash: null, deleted: true, updated_at: now, rev: old.rev + 1, device: saved.deviceId };
        changed = true;
      }
      if (m[id].deleted && now - m[id].updated_at > TOMBSTONE_TTL_MS) { delete m[id]; changed = true; }
    }
    return { cur, changed };
  }

  function localItems() {
    const { cur, changed } = refreshMeta();
    if (changed) deps.persistStore(); // zaman damgaları hemen diske; yoksa yeniden açılışta tekrar "değişti" sayılır
    const m = meta();
    return Object.entries(m).map(([id, x]) => ({
      id, kind: x.kind, updated_at: x.updated_at, rev: x.rev, device: x.device, deleted: !!x.deleted,
      data: x.deleted ? null : cur.get(id).data,
    }));
  }

  // Aynı id'de: büyük updated_at → büyük rev → büyük cihaz id'si kazanır (deterministik)
  const newer = (a, b) =>
    a.updated_at !== b.updated_at ? a.updated_at > b.updated_at : (a.rev || 0) !== (b.rev || 0) ? (a.rev || 0) > (b.rev || 0) : String(a.device || '') > String(b.device || '');

  function merge(a, b) {
    const map = new Map();
    for (const it of [...a, ...b]) {
      const prev = map.get(it.id);
      if (!prev || newer(it, prev)) map.set(it.id, it);
    }
    const now = Date.now();
    return [...map.values()].filter((it) => !(it.deleted && now - it.updated_at > TOMBSTONE_TTL_MS));
  }

  const itemsKey = (items) => stable([...items].sort((x, y) => (x.id < y.id ? -1 : 1)).map((x) => [x.id, x.updated_at, x.rev, x.deleted]));

  // Birleştirilmiş öğeleri yerel depoya uygula (cihaza özgü kayıtlar store.local'da olduğu için korunur)
  function applyItems(items) {
    const st = deps.getStore();
    const oldProjects = new Map(st.projects.map((x) => [x.id, x]));
    const live = items.filter((x) => !x.deleted && x.data);

    const folders = live.filter((x) => x.kind === 'folder').map((x) => ({ id: x.id, name: x.data.name, parentId: x.data.parentId || null }));
    const projects = live.filter((x) => x.kind === 'project').map((x) => {
      const d = x.data;
      const old = oldProjects.get(x.id) || {};
      const p = { id: x.id };
      for (const k of PROJECT_FIELDS) if (d[k] !== undefined && d[k] !== null) p[k] = d[k];
      p.createdAt = d.createdAt || old.createdAt || Date.now();
      p.folderId = d.folderId || null;
      return p;
    });
    const s = live.find((x) => x.kind === 'settings');
    const settings = {};
    if (s) for (const k of SETTINGS_FIELDS) if (k in s.data) settings[k] = s.data[k];

    const m = {};
    for (const it of items) {
      m[it.id] = { kind: it.kind, hash: null, updated_at: it.updated_at, rev: it.rev || 0, device: it.device, deleted: !!it.deleted };
    }
    deps.replaceLibrary({ folders, projects, settings, syncMeta: m });
    // Uygulanan verinin özetini kaydet ki yerel değişiklik sanılmasın
    const cur = currentData();
    for (const [id, x] of Object.entries(m)) if (!x.deleted && cur.has(id)) x.hash = hashOf(cur.get(id).data);
    deps.persistStore();
  }

  // --- Senkron döngüsü --------------------------------------------------------
  let running = null;
  let again = false;

  async function syncOnce() {
    if (!session) return;
    if (!session.syncEnabled) { setStatus({ state: 'off', error: null }); return; }
    setStatus({ state: 'syncing', error: null });
    try {
      const local = localItems();
      let remote = await authed('GET', '/api/cv/library');
      for (let attempt = 0; attempt < 4; attempt++) {
        let remoteItems = [];
        if (remote.blob) {
          const lib = decryptLibrary(session.encKey, remote.blob);
          remoteItems = Array.isArray(lib.items) ? lib.items : [];
        }
        // Bu cihazın ayarları hiç senkronlanmamışsa (updated_at 0) hesaptaki ayarlar kazanır
        const remoteHasSettings = remoteItems.some((x) => x.id === SETTINGS_ID && !x.deleted);
        const merged = merge(remoteHasSettings ? local.filter((x) => !(x.id === SETTINGS_ID && !x.updated_at)) : local, remoteItems);
        if (itemsKey(merged) !== itemsKey(local)) applyItems(merged);
        if (remote.blob && itemsKey(merged) === itemsKey(remoteItems)) {
          status.libraryVersion = remote.version;
          break; // sunucu zaten güncel
        }
        const blob = encryptLibrary(session.encKey, { schema: 1, items: merged });
        if (Buffer.byteLength(blob) > MAX_BLOB_BYTES) throw new ApiError(413, 'too_large');
        try {
          const put = await authed('PUT', '/api/cv/library', { base_version: remote.version ?? null, blob });
          status.libraryVersion = put.version;
          break;
        } catch (e) {
          if (e.status !== 409 || !e.body) throw e;
          remote = { version: e.body.version, blob: e.body.blob }; // çakışma: sunucudaki yeni hali birleştirip tekrar dene
          local.splice(0, local.length, ...merged);
        }
      }
      status.lastSyncAt = Date.now();
      persist();
      setStatus({ state: 'ok', error: null });
    } catch (e) {
      const code = e.code || 'error';
      if (code === 'session_expired') return;
      setStatus({ state: code === 'offline' ? 'offline' : 'error', error: code, errorMessage: e.message });
    }
  }

  function syncNow() {
    if (!session) return Promise.resolve();
    if (running) { again = true; return running; }
    running = syncOnce().finally(() => {
      running = null;
      if (again) { again = false; syncNow(); }
    });
    return running;
  }

  let debounce = null;
  let interval = null;
  function onLocalChange() {
    if (!session || !session.syncEnabled) return;
    clearTimeout(debounce);
    debounce = setTimeout(syncNow, SYNC_DEBOUNCE_MS);
  }
  function startTimers() {
    stopTimers();
    interval = setInterval(syncNow, SYNC_INTERVAL_MS);
  }
  function stopTimers() {
    clearTimeout(debounce);
    clearInterval(interval);
    debounce = interval = null;
  }

  // Açılış: oturum geçerli mi, senkron açık mı, yeni sürüm var mı
  async function start() {
    if (!session) return;
    startTimers();
    try {
      const me = await authed('GET', '/api/cv/me');
      session.user = me.user || session.user;
      session.syncEnabled = me.sync_enabled !== false;
      if (me.kdf && session.kdfSalt && me.kdf.salt !== session.kdfSalt) return expire(); // şifre başka yerde değişti
      persist();
    } catch (e) {
      if (e.status === 401 || e.status === 403) return;
      setStatus({ state: e.code === 'offline' ? 'offline' : 'error', error: e.code });
    }
    await syncNow();
    checkUpdate();
  }

  async function setSyncEnabled(on) {
    await authed('PUT', '/api/cv/settings', { sync_enabled: !!on });
    session.syncEnabled = !!on;
    persist();
    setStatus({ state: on ? 'idle' : 'off' });
    if (on) syncNow();
  }

  async function deleteRemote() {
    await authed('DELETE', '/api/cv/library');
    await setSyncEnabled(false);
    status.libraryVersion = null;
    // Sunucu kopyası gitti; yerel öğeler bir sonraki açılışta yeniden yüklenebilsin diye meta korunur
    persist();
  }

  async function checkUpdate() {
    try {
      const r = await authed('GET', '/api/cv/releases/latest');
      if (r && r.version && compareVersions(r.version, deps.appVersion) > 0) deps.onUpdate({ version: r.version, notes: r.notes || '' });
    } catch { /* bildirim isteğe bağlı */ }
  }

  return {
    isLoggedIn: () => !!session,
    state: publicState,
    login, logout, start, syncNow, onLocalChange, setSyncEnabled, deleteRemote, checkUpdate,
    // testler için
    _merge: merge,
  };
}

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

module.exports = { createAccount, deriveKeys, encryptLibrary, decryptLibrary, compareVersions, apiBase };
