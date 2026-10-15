'use strict';

// Hesap ve uçtan uca şifreli senkron: test vektörü, şifreleme, iki cihaz arasında proje senkronu (sahte sunucuyla)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMock } = require('./mock-server');

let mock;
let base;
test.before(async () => {
  mock = createMock();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${mock.server.address().port}`;
  process.env.CVM_API = base;
});
test.after(() => mock.server.close());

const load = () => {
  delete require.cache[require.resolve('../src/account')];
  return require('../src/account');
};

test('sözleşme test vektörü', async () => {
  const { deriveKeys } = load();
  const k = await deriveKeys('Test1234!', { alg: 'PBKDF2-SHA256', iter: 310000, salt: 'AAECAwQFBgcICQoLDA0ODw==' });
  assert.strictEqual(k.authHash, 'mLBQ6HQqD19kX/VavErWYq+7tM4mCmGfic7GuQQlBMY=');
  assert.strictEqual(k.encKey.subarray(0, 8).toString('hex'), '44199cbf68e39ac9');
});

test('şifreleme gidiş-dönüş ve bozuk blob', () => {
  const { encryptLibrary, decryptLibrary } = load();
  const key = Buffer.alloc(32, 7);
  const blob = encryptLibrary(key, { schema: 1, items: [{ id: 'a' }] });
  assert.deepStrictEqual(decryptLibrary(key, blob), { schema: 1, items: [{ id: 'a' }] });
  assert.throws(() => decryptLibrary(Buffer.alloc(32, 8), blob), /decrypt_failed/);
});

function device(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cvm-${name}-`));
  const store = { folders: [], projects: [], local: {}, syncMeta: {}, settings: { appTheme: 'dark', language: null, defaultConcurrency: 2, speechModel: 'base', speechConcurrency: 1 } };
  const { createAccount } = load();
  const acc = createAccount({
    userDataDir: dir, appVersion: '1.0.0', encrypt: (s) => s, decrypt: (s) => s,
    getStore: () => store,
    replaceLibrary: ({ folders, projects, settings, syncMeta }) => { Object.assign(store, { folders, projects, syncMeta }); Object.assign(store.settings, settings); },
    persistStore: () => {}, backupAndClearLibrary: () => null, onStatus: () => {}, onSessionExpired: () => {}, onUpdate: () => {},
  });
  return { store, acc };
}

test('iki cihaz: proje tanımı senkronlanır, yerel yollar senkronlanmaz', async () => {
  const A = device('a');
  const B = device('b');
  await A.acc.login('test@example.com', 'Test1234!', true);
  await B.acc.login('test@example.com', 'Test1234!', true);
  A.store.projects.push({ id: 'p1', createdAt: 1, name: 'Tatil', type: 'video', sourceExts: ['mkv'], targetExt: 'mp4', sourceMode: 'folder',
    includeSubfolders: true, concurrency: 3, speech: { enabled: true, model: 'base', language: 'auto', perWindow: false }, options: {}, folderId: null });
  A.store.local.p1 = { sourcePath: 'C:\\Videolar', unchecked: ['a.mkv'] };
  await A.acc.syncNow();
  assert.strictEqual(A.acc.state().state, 'ok');
  await B.acc.syncNow();
  assert.strictEqual(B.store.projects.length, 1);
  assert.strictEqual(B.store.projects[0].name, 'Tatil');
  assert.strictEqual(B.store.projects[0].concurrency, 3);
  assert.strictEqual(B.store.local.p1, undefined, 'kaynak yolu cihaza özgü kalmalı');
  // Sunucudaki blob açık metin içermez
  assert.ok(!Buffer.from(mock.state.blob, 'base64').toString('latin1').includes('Tatil'));
  // B yeniden adlandırır, A görür; B siler, A'dan da gider
  B.store.projects[0].name = 'Tatil 2026';
  await B.acc.syncNow();
  await A.acc.syncNow();
  assert.strictEqual(A.store.projects[0].name, 'Tatil 2026');
  assert.strictEqual(A.store.local.p1.sourcePath, 'C:\\Videolar');
  B.store.projects = [];
  await B.acc.syncNow();
  await A.acc.syncNow();
  assert.strictEqual(A.store.projects.length, 0);
});
