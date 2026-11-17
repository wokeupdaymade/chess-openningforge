// Lichess data access (opening explorer, masters DB, cloud evals) through the local caching proxy.
import { state, ratingBuckets } from './store.js';
import { Chess, normUci, epdOf } from './chessutil.js';

const mem = new Map(); // url -> Promise
export const net = { pending: 0, rateLimitedUntil: 0, lastError: '', listeners: new Set() };
function notify() { for (const fn of net.listeners) fn(net); }

// Small priority queue so that what the user is looking at beats background coverage analysis.
const queue = []; let active = 0; const MAX_ACTIVE = 2;
function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    queue.sort((a, b) => b.prio - a.prio || a.seq - b.seq);
    const job = queue.shift(); active++;
    job.run().finally(() => { active--; net.pending = active + queue.length; notify(); pump(); });
  }
}
let seq = 0;
function enqueue(prio, fn) {
  return new Promise((resolve, reject) => {
    queue.push({ prio, seq: seq++, run: () => fn().then(resolve, reject) });
    net.pending = active + queue.length; notify(); pump();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rawFetch(url, { nocache = false, accept } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = net.rateLimitedUntil - Date.now();
    if (wait > 0) await sleep(wait);
    let r;
    try {
      r = await fetch('/api/proxy?url=' + encodeURIComponent(url) + (nocache ? '&nocache=1' : '') + (accept ? '&accept=' + encodeURIComponent(accept) : ''));
    } catch (e) { net.lastError = 'Local server unreachable'; notify(); await sleep(1500); continue; }
    if (r.status === 429) {
      let ra = 61; try { ra = (await r.json()).retryAfter || 61; } catch { /* default */ }
      net.rateLimitedUntil = Date.now() + ra * 1000; net.lastError = `Lichess rate limit — resuming in ${ra}s`; notify();
      continue;
    }
    if (r.status === 401 || r.status === 403) { net.lastError = 'Lichess rejected the request — add a Lichess API token in Settings'; notify(); }
    else if (r.status === 502) { net.lastError = 'Could not reach Lichess'; notify(); await sleep(1000 * (attempt + 1)); continue; }
    else if (net.lastError) { net.lastError = ''; notify(); }
    return { status: r.status, text: await r.text() };
  }
  return { status: 599, text: '' };
}

export function proxy(url, { prio = 0, nocache = false, accept, cache = true } = {}) {
  if (cache && !nocache && mem.has(url)) return mem.get(url);
  const p = enqueue(prio, () => rawFetch(url, { nocache, accept }));
  if (cache && !nocache) { mem.set(url, p); p.then(r => { if (r.status >= 500 || r.status === 401 || r.status === 403) mem.delete(url); }, () => mem.delete(url)); }
  return p;
}

export const openingNames = new Map(); // epd -> opening name
function norm(d, fen) {
  if (!d) return null;
  if (d.opening?.name) openingNames.set(epdOf(fen), d.opening.name);
  const chess = new Chess(fen);
  const total = d.white + d.draws + d.black;
  return {
    white: d.white, draws: d.draws, black: d.black, total, opening: d.opening || null,
    topGames: d.topGames || [],
    moves: (d.moves || []).map(m => ({
      san: m.san, uci: normUci(m.uci, chess), white: m.white, draws: m.draws, black: m.black,
      total: m.white + m.draws + m.black, avgRating: m.averageRating, opening: m.opening || null,
    })),
  };
}

// Peer games at the configured rating / time controls.
export async function explorer(fen, { prio = 0, settings = state.settings } = {}) {
  const url = `https://explorer.lichess.ovh/lichess?variant=standard&fen=${encodeURIComponent(fen)}&ratings=${ratingBuckets(settings).join(',')}&speeds=${settings.speeds.join(',')}&moves=40&topGames=0&recentGames=0`;
  const r = await proxy(url, { prio });
  if (r.status !== 200) return null;
  try { return norm(JSON.parse(r.text), fen); } catch { return null; }
}
export function explorerCached(fen, settings = state.settings) {
  const url = `https://explorer.lichess.ovh/lichess?variant=standard&fen=${encodeURIComponent(fen)}&ratings=${ratingBuckets(settings).join(',')}&speeds=${settings.speeds.join(',')}&moves=40&topGames=0&recentGames=0`;
  return mem.has(url);
}

export async function masters(fen, { prio = 0 } = {}) {
  const url = `https://explorer.lichess.ovh/masters?fen=${encodeURIComponent(fen)}&moves=40&topGames=15`;
  const r = await proxy(url, { prio });
  if (r.status !== 200) return null;
  try { return norm(JSON.parse(r.text), fen); } catch { return null; }
}

export async function highRated(fen, { prio = 0 } = {}) {
  const url = `https://explorer.lichess.ovh/lichess?variant=standard&fen=${encodeURIComponent(fen)}&ratings=2200,2500&speeds=blitz,rapid,classical&moves=12&topGames=15&recentGames=0`;
  const r = await proxy(url, { prio });
  if (r.status !== 200) return null;
  try { return norm(JSON.parse(r.text), fen); } catch { return null; }
}

export async function masterGamePgn(id) {
  const r = await proxy(`https://explorer.lichess.ovh/masters/pgn/${id}`, { prio: 5, accept: 'application/x-chess-pgn' });
  return r.status === 200 ? r.text : null;
}
export async function lichessGamePgn(id) {
  const r = await proxy(`https://lichess.org/game/export/${id}?clocks=false&evals=false`, { prio: 5, accept: 'application/x-chess-pgn' });
  return r.status === 200 ? r.text : null;
}

const MATE = 100000;
export function scoreOf(pv) { // -> centipawns, white POV, mates mapped to large values
  if (pv.mate != null) return pv.mate > 0 ? MATE - pv.mate : -MATE - pv.mate;
  return pv.cp;
}
export function fmtEval(cp) {
  if (cp == null) return '';
  if (Math.abs(cp) > MATE - 1000) return (cp > 0 ? '#' : '#-') + (MATE - Math.abs(cp));
  const v = Math.round(cp / 10) / 10;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
}

// Cloud eval. Returns {depth, pvs:[{uci, cp(white POV), line}]} or null when the position is not in the cloud.
export async function cloudEval(fen, multiPv = 1, { prio = 0 } = {}) {
  const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`;
  const r = await proxy(url, { prio });
  if (r.status !== 200) return null;
  try {
    const d = JSON.parse(r.text);
    const chess = new Chess(fen);
    return { depth: d.depth, knodes: d.knodes, pvs: d.pvs.map(pv => ({ uci: normUci(pv.moves.split(' ')[0], chess), cp: scoreOf(pv), line: pv.moves })) };
  } catch { return null; }
}

export async function studyPgn(idOrUrl) {
  const m = String(idOrUrl).match(/study\/([A-Za-z0-9]{8})(?:\/([A-Za-z0-9]{8}))?/) || String(idOrUrl).match(/^([A-Za-z0-9]{8})$/);
  if (!m) throw new Error('That does not look like a Lichess study link');
  const url = m[2] ? `https://lichess.org/api/study/${m[1]}/${m[2]}.pgn` : `https://lichess.org/api/study/${m[1]}.pgn`;
  const r = await proxy(url + '?clocks=false&comments=true&variations=true', { prio: 5, nocache: true, accept: 'application/x-chess-pgn' });
  if (r.status !== 200) throw new Error(r.status === 404 ? 'Study not found' : r.status === 403 || r.status === 401 ? 'Study is private (export must be enabled)' : 'Could not download the study');
  return r.text;
}

// Recent games of a Lichess user -> [{id, white, black, winner, moves:[san], opening, speed, date, url}]
export async function lichessGames(user, max = 100) {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(user)}?max=${max}&opening=true&moves=true&perfType=bullet,blitz,rapid,classical&rated=true`;
  const r = await proxy(url, { prio: 5, nocache: true, accept: 'application/x-ndjson' });
  if (r.status !== 200) throw new Error(r.status === 404 ? `Lichess user "${user}" not found` : 'Could not download games from Lichess');
  const out = [];
  for (const line of r.text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const g = JSON.parse(line);
      if (g.variant !== 'standard' || !g.moves) continue;
      const wn = g.players.white.user?.name || 'Anonymous', bn = g.players.black.user?.name || 'Anonymous';
      out.push({
        id: g.id, site: 'lichess', url: `https://lichess.org/${g.id}`, white: wn, black: bn,
        whiteElo: g.players.white.rating, blackElo: g.players.black.rating,
        winner: g.winner || 'draw', moves: g.moves.split(' '), opening: g.opening?.name || '', speed: g.speed, date: g.createdAt,
        color: wn.toLowerCase() === user.toLowerCase() ? 'w' : 'b',
      });
    } catch { /* skip */ }
  }
  return out;
}

// Recent games of a Chess.com user (monthly archives, newest first).
export async function chesscomGames(user, max = 100, parsePgnGames, mainline) {
  const a = await proxy(`https://api.chess.com/pub/player/${encodeURIComponent(user.toLowerCase())}/games/archives`, { prio: 5, nocache: true });
  if (a.status !== 200) throw new Error(a.status === 404 ? `Chess.com user "${user}" not found` : 'Could not download games from Chess.com');
  const archives = JSON.parse(a.text).archives || [];
  const out = [];
  for (const url of archives.reverse()) {
    if (out.length >= max) break;
    const r = await proxy(url, { prio: 5, nocache: true });
    if (r.status !== 200) continue;
    const games = (JSON.parse(r.text).games || []).reverse();
    for (const g of games) {
      if (out.length >= max) break;
      if (g.rules !== 'chess' || !g.pgn) continue;
      const parsed = parsePgnGames(g.pgn)[0]; if (!parsed) continue;
      const res = g.white.result === 'win' ? 'white' : g.black.result === 'win' ? 'black' : 'draw';
      const eco = (parsed.headers.ECOUrl || '').split('/').pop()?.replace(/-/g, ' ') || parsed.headers.ECO || '';
      out.push({
        id: g.uuid || g.url, site: 'chesscom', url: g.url, white: g.white.username, black: g.black.username,
        whiteElo: g.white.rating, blackElo: g.black.rating, winner: res, moves: mainline(parsed.root), opening: eco,
        speed: g.time_class, date: g.end_time * 1000, color: g.white.username.toLowerCase() === user.toLowerCase() ? 'w' : 'b',
      });
    }
  }
  return out;
}

export { epdOf };
