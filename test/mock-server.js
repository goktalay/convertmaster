'use strict';

// Geliştirme ve testler için /api/cv sahte sunucusu (bellekte). Kullanım:
//   node test/mock-server.js 8787   →   CVM_API=http://127.0.0.1:8787 npm start
// Hesap: test@example.com / Test1234!

const http = require('http');
const { deriveKeys } = require('../src/account');

const SALT = 'AAECAwQFBgcICQoLDA0ODw==';
const KDF = { alg: 'PBKDF2-SHA256', iter: 310000, salt: SALT };

function createMock() {
  const state = { version: 0, blob: null, sync: true, token: 'tok-' + Date.now(), puts: 0 };
  let authHash = null;
  const ready = deriveKeys('Test1234!', KDF).then((k) => { authHash = k.authHash; });
  const user = { id: 'u1', email: 'test@example.com', name: 'Test' };

  const server = http.createServer(async (req, res) => {
    await ready;
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : {};
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const authed = () => (req.headers.authorization === `Bearer ${state.token}` ? true : (send(401, { code: 'session_expired' }), false));
    const url = req.url.split('?')[0];
    if (url === '/api/cv/auth/prelogin') return send(200, { kdf: KDF });
    if (url === '/api/cv/auth/login') {
      if (json.email !== user.email || json.auth_hash !== authHash) return send(401, { code: 'bad_credentials' });
      return send(200, { token: state.token, user, sync_enabled: state.sync, kdf: KDF });
    }
    if (url === '/api/cv/auth/logout') return send(200, {});
    if (!authed()) return;
    if (url === '/api/cv/me') return send(200, { user, sync_enabled: state.sync, kdf: KDF });
    if (url === '/api/cv/settings') { state.sync = !!json.sync_enabled; return send(200, { sync_enabled: state.sync }); }
    if (url === '/api/cv/releases/latest') return send(200, { version: '0.0.1' });
    if (url === '/api/cv/library') {
      if (req.method === 'GET') return send(200, { version: state.blob ? state.version : null, blob: state.blob });
      if (req.method === 'DELETE') { state.blob = null; state.version = 0; return send(200, {}); }
      if (req.method === 'PUT') {
        if ((json.base_version ?? null) !== (state.blob ? state.version : null)) return send(409, { code: 'conflict', version: state.version, blob: state.blob });
        state.version += 1;
        state.blob = json.blob;
        state.puts++;
        return send(200, { version: state.version });
      }
    }
    send(404, { code: 'not_found' });
  });
  return { server, state };
}

if (require.main === module) {
  const port = Number(process.argv[2]) || 8787;
  createMock().server.listen(port, '127.0.0.1', () => console.log(`mock /api/cv http://127.0.0.1:${port}`));
}

module.exports = { createMock, KDF };
