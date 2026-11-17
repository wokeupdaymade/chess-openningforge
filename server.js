#!/usr/bin/env node
// OpeningForge local server: static files, persistent JSON store, cached Lichess proxy.
// No external dependencies beyond the vendored browser libraries in node_modules.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.OPENINGFORGE_DATA || path.join(ROOT, 'data');
const PORT = +(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
fs.mkdirSync(DATA, { recursive: true });

const STORE_FILE = path.join(DATA, 'store.json');
const CACHE_FILE = path.join(DATA, 'cache.jsonl');
const BACKUP_DIR = path.join(DATA, 'backups');

// ---------- vendored libraries (served straight from node_modules) ----------
const VENDOR = {
  '/vendor/chess.js': 'node_modules/chess.js/dist/esm/chess.js',
  '/vendor/chessground.js': 'node_modules/chessground/dist/chessground.min.js',
  '/vendor/chessground.base.css': 'node_modules/chessground/assets/chessground.base.css',
  '/vendor/chessground.cburnett.css': 'node_modules/chessground/assets/chessground.cburnett.css',
  '/vendor/stockfish.js': 'node_modules/stockfish/bin/stockfish-19-lite-single.js',
  '/vendor/stockfish-19-lite-single.wasm': 'node_modules/stockfish/bin/stockfish-19-lite-single.wasm',
  '/vendor/stockfish.wasm': 'node_modules/stockfish/bin/stockfish-19-lite-single.wasm',
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};

// ---------- disk-backed response cache for Lichess data ----------
const cache = new Map(); // url -> {t, status, body}
if (fs.existsSync(CACHE_FILE)) {
  for (const line of fs.readFileSync(CACHE_FILE, 'utf8').split('\n')) {
    if (!line) continue;
    try { const e = JSON.parse(line); cache.set(e.u, { t: e.t, status: e.s, body: e.b }); } catch { /* skip corrupt line */ }
  }
}
const cacheStream = fs.createWriteStream(CACHE_FILE, { flags: 'a' });
function cachePut(url, status, body) {
  const e = { t: Date.now(), status, body };
  cache.set(url, e);
  cacheStream.write(JSON.stringify({ u: url, t: e.t, s: status, b: body }) + '\n');
}

const DAY = 86400e3;
const ALLOWED = {
  'explorer.lichess.ovh': { ttl: 60 * DAY, gap: 350, lichess: true },
  'lichess.org': { ttl: 30 * DAY, gap: 700, lichess: true },
  'api.chess.com': { ttl: 0, gap: 300, lichess: false },
};
const hostState = {}; // host -> {chain: Promise, blockedUntil}

function getToken() {
  if (process.env.LICHESS_TOKEN) return process.env.LICHESS_TOKEN;
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')).settings?.lichessToken || ''; } catch { return ''; }
}

async function upstream(url, { noCache = false, accept } = {}) {
  const u = new URL(url);
  const conf = ALLOWED[u.host];
  if (!conf || u.protocol !== 'https:') return { status: 400, body: JSON.stringify({ error: 'host not allowed' }) };
  const cacheable = conf.ttl > 0 && !noCache && !u.pathname.startsWith('/api/games/') && !u.pathname.startsWith('/api/user');
  if (cacheable) {
    const hit = cache.get(url);
    // 404s (position not in cloud eval) are re-checked more often than real data
    if (hit && Date.now() - hit.t < (hit.status === 404 ? 7 * DAY : conf.ttl)) return { status: hit.status, body: hit.body, cached: true };
  }
  const st = (hostState[u.host] ||= { chain: Promise.resolve(), blockedUntil: 0 });
  const run = async () => {
    if (Date.now() < st.blockedUntil) return { status: 429, body: JSON.stringify({ error: 'rate limited', retryAfter: Math.ceil((st.blockedUntil - Date.now()) / 1000) }) };
    const headers = { 'User-Agent': 'OpeningForge (local personal repertoire tool)', Accept: accept || 'application/json' };
    const token = conf.lichess ? getToken() : '';
    if (token) headers.Authorization = 'Bearer ' + token;
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
      const body = await r.text();
      if (r.status === 429) { st.blockedUntil = Date.now() + 61000; return { status: 429, body: JSON.stringify({ error: 'rate limited', retryAfter: 61 }) }; }
      if (cacheable && (r.status === 200 || r.status === 404)) cachePut(url, r.status, body);
      return { status: r.status, body };
    } catch (e) {
      return { status: 502, body: JSON.stringify({ error: 'upstream failed: ' + (e.cause?.code || e.message) }) };
    } finally {
      await new Promise(res => setTimeout(res, conf.gap));
    }
  };
  const p = st.chain.then(run, run);
  st.chain = p.catch(() => {});
  return p;
}

// ---------- store ----------
let lastBackupDay = '';
function writeStore(text) {
  JSON.parse(text); // validate
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, STORE_FILE);
  const day = new Date().toISOString().slice(0, 10);
  if (day !== lastBackupDay) {
    lastBackupDay = day;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(path.join(BACKUP_DIR, `store-${day}.json`), text);
    const files = fs.readdirSync(BACKUP_DIR).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 14))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  }
}

function readBody(req, limit = 200e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, body, type = 'application/json', extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  };
  try {
    // Only this machine's own page may talk to the API (blocks cross-site requests from other tabs).
    if (url.pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(403, '{"error":"forbidden"}');
    }
    if (url.pathname === '/api/store') {
      if (req.method === 'GET') return send(200, fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE) : 'null');
      if (req.method === 'PUT') { writeStore(await readBody(req)); return send(200, '{"ok":true}'); }
    }
    if (url.pathname === '/api/proxy' && req.method === 'GET') {
      const target = url.searchParams.get('url');
      const r = await upstream(target, { noCache: url.searchParams.get('nocache') === '1', accept: url.searchParams.get('accept') || undefined });
      return send(r.status, r.body, 'application/json', r.cached ? { 'X-Cache': 'hit' } : {});
    }
    if (url.pathname === '/api/cache-info') return send(200, JSON.stringify({ entries: cache.size, hasToken: !!getToken() }));
    if (req.method !== 'GET') return send(405, '{"error":"method"}');

    let file;
    if (VENDOR[url.pathname]) file = path.join(ROOT, VENDOR[url.pathname]);
    else {
      const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
      file = path.join(PUBLIC, rel || 'index.html');
      if (!file.startsWith(PUBLIC)) return send(403, 'forbidden', 'text/plain');
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': url.pathname.startsWith('/vendor/') ? 'max-age=86400' : 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(500, JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`OpeningForge running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Data directory: ${DATA}`);
});
