// Per-position move table: peer statistics + masters statistics + evaluations (cloud first, local engine fallback).
import { explorer, masters, cloudEval } from './api.js';
import { analyse } from './engine.js';
import { Chess, epdOf } from './chessutil.js';
import { state } from './store.js';

const tables = new Map(); // key -> table

export function winRate(st, color) { // score fraction for `color`
  if (!st || !st.total) return null;
  return ((color === 'w' ? st.white : st.black) + st.draws / 2) / st.total;
}

// Returns a live table object; `table.onUpdate` listeners fire as data arrives; `table.done` resolves when complete.
export function moveTable(fen, { prio = 0, settings = state.settings, evals = true, extraSans = [], childEvals = 8 } = {}) {
  const key = [epdOf(fen), settings.speeds.join(), settings.rating, settings.ratingPlatform, (settings.ratingBuckets || []).join(), evals, childEvals, settings.engineFallback, settings.engineDepth].join('|');
  let t = tables.get(key);
  if (t) { t.ensure(extraSans); return t; }
  const turn = fen.split(' ')[1];
  t = { fen, turn, rows: [], peer: undefined, masters: undefined, opening: null, evalInfo: null, bestEval: null, loading: true, listeners: new Set(), failed: false };
  tables.set(key, t);
  const bySan = new Map();
  const chess = new Chess(fen);
  const legal = new Map(chess.moves({ verbose: true }).map(m => [m.san, m]));
  const row = san => {
    let r = bySan.get(san);
    if (!r) {
      const m = legal.get(san); if (!m) return null;
      r = { san, uci: m.from + m.to + (m.promotion || ''), from: m.from, to: m.to, peer: null, masters: null, opening: null, eval: null, evalSource: null, depth: null, share: 0, mastersShare: 0 };
      bySan.set(san, r); t.rows.push(r);
    }
    return r;
  };
  const byUci = uci => { for (const m of legal.values()) if (m.from + m.to + (m.promotion || '') === uci) return row(m.san); return null; };
  const fire = () => { recompute(t); for (const fn of t.listeners) fn(t); };
  const setEval = (r, cpWhite, source, depth) => {
    if (!r || (r.eval != null && r.evalSource === 'cloud')) return;
    r.eval = turn === 'w' ? cpWhite : -cpWhite; r.evalSource = source; r.depth = depth;
  };
  const childFen = r => { const c = new Chess(fen); c.move(r.san); return c.fen(); };
  const evalChild = async r => {
    if (r.eval != null || r.evalPending) return;
    r.evalPending = true; fire();
    const cf = childFen(r);
    let ev = await cloudEval(cf, 1, { prio: prio - 1 });
    let src = 'cloud';
    if (!ev && settings.engineFallback) { ev = await analyse(cf, { depth: Math.max(8, settings.engineDepth - 1) }); src = 'engine'; }
    r.evalPending = false;
    if (ev?.pvs?.length) setEval(r, ev.pvs[0].cp, src, ev.depth);
    else {
      // terminal positions
      const c = new Chess(cf);
      if (c.isCheckmate()) setEval(r, turn === 'w' ? 99999 : -99999, 'rule', 0); else if (c.isDraw() || c.isStalemate()) setEval(r, 0, 'rule', 0);
    }
    fire();
  };

  const pending = new Set();
  t.ensure = sans => { for (const s of sans) { const r = row(s); if (r && evals && statsReady) pending.add(evalChild(r)); } };
  let statsReady = false;

  const pPeer = explorer(fen, { prio, settings }).then(d => {
    t.peer = d;
    if (d) { t.opening = d.opening || t.opening; for (const m of d.moves) { const r = row(m.san); if (r) { r.peer = m; r.opening = m.opening || r.opening; } } } else t.failed = true;
    fire();
  });
  const pMasters = masters(fen, { prio: prio - 1 }).then(d => {
    t.masters = d;
    if (d) { t.opening = t.opening || d.opening; for (const m of d.moves) { const r = row(m.san); if (r) { r.masters = m; r.opening = r.opening || m.opening; } } }
    fire();
  });
  for (const s of extraSans) row(s);

  const pEval = !evals ? Promise.resolve() : (async () => {
    let ev = null;
    for (const n of [5, 3, 1]) { ev = await cloudEval(fen, n, { prio }); if (ev) break; }
    let src = 'cloud';
    if (!ev && settings.engineFallback && legal.size) { t.engineWorking = true; fire(); ev = await analyse(fen, { multiPv: Math.min(5, legal.size), depth: settings.engineDepth }); src = 'engine'; t.engineWorking = false; }
    if (ev) { t.evalInfo = { source: src, depth: ev.depth }; for (const pv of ev.pvs) setEval(byUci(pv.uci), pv.cp, src, ev.depth); }
    fire();
    await pPeer; await pMasters;
    statsReady = true;
    // evaluate the most relevant remaining candidates one by one
    recompute(t);
    const want = t.rows.filter(r => r.eval == null).sort((a, b) => (b.share + b.mastersShare) - (a.share + a.mastersShare)).slice(0, childEvals);
    for (const s of extraSans) { const r = bySan.get(s); if (r && r.eval == null && !want.includes(r)) want.push(r); }
    for (const r of want) await evalChild(r);
    await Promise.all([...pending]);
  })();

  t.done = Promise.all([pPeer, pMasters, pEval]).then(() => { t.loading = false; fire(); return t; });
  t.statsDone = Promise.all([pPeer, pMasters]).then(() => t);
  return t;
}

function recompute(t) {
  const pt = t.peer?.total || 0, mt = t.masters?.total || 0;
  let best = null;
  for (const r of t.rows) {
    r.share = pt && r.peer ? r.peer.total / pt : 0;
    r.mastersShare = mt && r.masters ? r.masters.total / mt : 0;
    r.win = winRate(r.peer, t.turn);
    if (r.eval != null && (best == null || r.eval > best)) best = r.eval;
  }
  t.bestEval = best;
  for (const r of t.rows) r.loss = r.eval != null && best != null ? Math.max(0, best - r.eval) : null;
}

// Classifies and scores candidate moves for the side to move.
// style = {effectiveness, soundness, learnability} weights (any scale).
export function rankCandidates(t, settings, style = { effectiveness: 1, soundness: 1, learnability: 1 }) {
  const thr = settings.evalThreshold;
  const sum = (style.effectiveness + style.soundness + style.learnability) || 1;
  const out = t.rows.map(r => {
    const acceptable = r.loss != null ? r.loss <= thr : null;
    // shrink win rates with few games toward 50%
    const n = r.peer?.total || 0;
    const wr = r.win == null ? 0.5 : (r.win * n + 0.5 * 200) / (n + 200);
    const eff = Math.max(0, Math.min(1, (wr - 0.4) / 0.2));
    const snd = r.loss == null ? 0 : Math.max(0, 1 - r.loss / Math.max(thr, 1) / 2);
    const lrn = Math.min(1, Math.sqrt(Math.max(r.share, r.mastersShare * 0.8)));
    const score = (style.effectiveness * eff + style.soundness * snd + style.learnability * lrn) / sum;
    let glyph = '';
    if (r.loss != null) glyph = r.loss >= 200 ? '??' : r.loss >= 100 ? '?' : r.loss >= 50 ? '?!' : '';
    return { ...r, row: r, acceptable, score, glyph, eff, snd, lrn };
  });
  const known = out.filter(c => c.acceptable);
  const rec = known.length ? known.reduce((a, b) => (b.score > a.score ? b : a)) : null;
  const best = out.filter(c => c.loss === 0)[0] || null;
  for (const c of out) { c.recommended = c === rec; c.best = c === best; }
  return out;
}

export function sortCandidates(list, mode) {
  const by = {
    popularity: (a, b) => b.share - a.share || b.mastersShare - a.mastersShare,
    eval: (a, b) => (b.eval ?? -1e9) - (a.eval ?? -1e9) || b.share - a.share,
    winrate: (a, b) => (b.win ?? 0) - (a.win ?? 0),
    masters: (a, b) => b.mastersShare - a.mastersShare || b.share - a.share,
    smart: (a, b) => (b.acceptable === true) - (a.acceptable === true) || (a.acceptable === false) - (b.acceptable === false) || b.score - a.score,
  }[mode] || (() => 0);
  return [...list].sort(by);
}
