#!/usr/bin/env node
/* uventoy server — zero dependencies.
 * Serves the new mobile-friendly UI and proxies /vtoy/json
 * to the original V2DServer binary (same install/update/clean algorithms). */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
let listLocalDevices = () => [];
try { ({ listLocalDevices } = require('./lib/devices')); } catch (e) { console.error('[webx] local scan disabled:', e.message); }

const ROOT = path.join(__dirname, 'ventoy');   // official Ventoy package (tool/, boot/, ...)
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.ico':'image/x-icon', '.svg':'image/svg+xml', '.png':'image/png' };
// Only UI files are exposed. server.js, lib/, ventoy/, setup.sh, module.prop
// must NEVER be reachable over HTTP.
const STATIC = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/css/style.css': 'css/style.css',
  '/js/app.js': 'js/app.js',
  '/favicon.ico': 'public/favicon.ico',
};

let HOST = 'localhost', VTOY_PORT = 0, VTOY_GIVEN = false, spawned = null;
// Default port 3000, overridden by $PORT env var, overridden by -p flag.
const _envPort = parseInt(process.env.PORT, 10);
let PORT = (Number.isInteger(_envPort) && _envPort > 0 && _envPort <= 65535) ? _envPort : 3000;

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '-H') HOST = process.argv[++i];
  else if (a === '-p') PORT = +process.argv[++i];
  else if (a === '--vtoy-port') { VTOY_PORT = +process.argv[++i]; VTOY_GIVEN = true; }
  else if (a === '-h' || a === '--help') {
    console.log('Usage: node server.js [-H host] [-p port] [--vtoy-port port]\n  defaults: -H localhost -p 3000 (or $PORT if set) --vtoy-port 24680 (reuse VentoyWeb.sh if running)');
    process.exit(0);
  }
}
// Default backend = classic VentoyWeb.sh port, so we reuse it when already running.
if (!VTOY_GIVEN) VTOY_PORT = 24680;

function archDir() {
  const a = process.arch; // x64, arm64, mips64el?, ia32
  if (a === 'arm64') return 'aarch64';
  if (a === 'x64') return 'x86_64';
  if (String(a).startsWith('mips')) return 'mips64el';
  return 'i386';
}
function portOpen(h, p) {
  return new Promise(res => {
    const s = require('net').connect(p, h);
    s.once('connect', () => { s.end(); res(true); });
    s.once('error', () => res(false));
  });
}
async function ensureBackend() {
  if (await portOpen('127.0.0.1', VTOY_PORT)) { console.log(`[webx] reuse V2DServer on 127.0.0.1:${VTOY_PORT}`); return; }
  // If default port busy elsewhere (e.g. user runs VentoyWeb.sh on 24680 but asked another port), reuse 24680.
  if (!VTOY_GIVEN && VTOY_PORT !== 24680 && await portOpen('127.0.0.1', 24680)) {
    VTOY_PORT = 24680;
    console.log('[webx] reuse V2DServer on 127.0.0.1:24680');
    return;
  }
  const dir = archDir();
  const bin = path.join(ROOT, 'tool', dir, 'V2DServer');
  if (!fs.existsSync(path.join(ROOT, 'boot', 'boot.img'))) {
    console.error('Please run from the Ventoy install package root (boot/boot.img missing).');
    process.exit(1);
  }
  if (!fs.existsSync(bin)) {
    console.error('V2DServer not found: ' + bin);
    console.error('Hint: start the classic server first (sudo ./VentoyWeb.sh) then run: node server.js --vtoy-port 24680');
    process.exit(1);
  }
  try { fs.chmodSync(bin, 0o755); } catch {}
  console.log(`[webx] starting V2DServer 127.0.0.1:${VTOY_PORT} ... (${bin})`);
  spawned = spawn(bin, ['127.0.0.1', String(VTOY_PORT)], { cwd: ROOT, stdio: 'inherit' });
  spawned.on('error', e => {
    console.error('\n[webx] FAILED to execute: ' + bin);
    console.error('  reason: ' + (e.code || e.message));
    try {
      const st = fs.statSync(bin);
      console.error(`  file: size=${st.size} mode=${(st.mode & 0o777).toString(8)}`);
    } catch {}
    console.error(`  node arch=${process.arch} mapped dir=${dir} — wrong binary arch or Android/Termux cannot run glibc ELF (ENOENT).`);
    console.error('  FIX: in another terminal run:  sudo ./VentoyWeb.sh   (starts backend on 24680)');
    console.error('  then run:  node server.js --vtoy-port 24680');
    process.exit(1);
  });
  spawned.on('exit', c => { console.log('[webx] V2DServer exited ' + c); process.exit(c || 0); });
  for (let i = 0; i < 30; i++) { if (await portOpen('127.0.0.1', VTOY_PORT)) return; await new Promise(r => setTimeout(r, 300)); }
  console.error('V2DServer failed to start'); process.exit(1);
}
function serveStatic(req, res) {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const rel = STATIC[u];
  if (!rel) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return;
  }
  const f = path.join(__dirname, rel);
  if (!fs.existsSync(f)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}
function proxyVtoy(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const pr = http.request({ host: '127.0.0.1', port: VTOY_PORT, path: '/vtoy/json', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, r2 => {
      res.writeHead(r2.statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      r2.pipe(res);
    });
    pr.on('error', e => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: 'error', msg: String(e) })); });
    pr.end(body);
  });
}

(async () => {
  await ensureBackend();
  const onReady = () => {
    let ver = '?'; try { ver = fs.readFileSync(path.join(ROOT, 'ventoy', 'version'), 'utf8').trim(); } catch {}
    console.log('');
    console.log('===============================================================');
    console.log(`  uventoy (Ventoy ${ver}) is running ...`);
    console.log(`  Please open your browser and visit http://${HOST}:${PORT}`);
    console.log(`  backend V2DServer -> 127.0.0.1:${VTOY_PORT}`);
    console.log('===============================================================');
    console.log('################## Press Ctrl + C to exit #####################');
  };
  const handler = (req, res) => {
    if (req.url.startsWith('/vtoy/json')) return proxyVtoy(req, res);
    if (req.url === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, backend: VTOY_PORT })); }
    if (req.url === '/api/local-devs') {
      try {
        const list = listLocalDevices();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        return res.end(JSON.stringify({ ok: true, list }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, list: [], reason: String((e && e.message) || e) }));
      }
    }
    return serveStatic(req, res);
  };
  if (HOST === 'localhost') {
    // 'localhost' may resolve to 127.0.0.1 and/or ::1 — listen on both
    // loopback families so http://localhost:$PORT always works.
    http.createServer(handler).listen(PORT, '127.0.0.1', () => {
      const v6 = http.createServer(handler);
      v6.on('error', onReady); // no IPv6 stack — IPv4 is enough
      v6.listen(PORT, '::1', onReady);
    });
  } else {
    http.createServer(handler).listen(PORT, HOST, onReady);
  }
  const bye = () => { if (spawned) spawned.kill('SIGTERM'); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
})();
