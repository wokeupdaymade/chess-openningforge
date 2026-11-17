// Repertoire graph operations, coverage / gap analysis, spaced repetition, PGN import & export.
import { Chess, START_FEN, START_EPD, epdOf, fenOfEpd, turnOfEpd, replay, lineText, parsePgnGames, pgnLines } from './chessutil.js';
import { explorer } from './api.js';
import { state, save, repSettings } from './store.js';

// rep.positions[epd] = { moves: { [san]: Move }, excluded: [san], name }
// Move = { san, to (epd), mine, note, disabled, auto, added, srs, q:{loss,win,share} }

export function pos(rep, epd, create = false) {
  let p = rep.positions[epd];
  if (!p && create) p = rep.positions[epd] = { moves: {} };
  return p;
}
export function movesAt(rep, epd) { return Object.values(rep.positions[epd]?.moves || {}); }
export function myMovesAt(rep, epd, activeOnly = true) { return movesAt(rep, epd).filter(m => m.mine && !(activeOnly && m.disabled)); }
export function isMine(rep, epd) { return turnOfEpd(epd) === rep.color; }
export function touch(rep) { rep.rev = (rep.rev || 0) + 1; rep.updated = Date.now(); analysisCache.delete(rep.id); save(); }

// Adds every move of a SAN line. Trailing opponent moves (no reply yet) are dropped unless keepTrailing.
export function addLine(rep, sans, { auto = false, notes = [], keepTrailing = false, quality = {} } = {}) {
  const steps = replay(sans);
  let end = steps.length;
  if (!keepTrailing) while (end > 0 && steps[end - 1].color !== rep.color) end--;
  let added = 0;
  for (let i = 0; i < end; i++) {
    const s = steps[i];
    const p = pos(rep, s.epdBefore, true);
    let m = p.moves[s.san];
    if (!m) {
      m = p.moves[s.san] = { san: s.san, to: s.epdAfter, mine: s.color === rep.color, added: Date.now() };
      if (auto) m.auto = true;
      if (m.mine) { m.srs = newCard(); added++; }
    }
    if (notes[i] && !m.note) m.note = notes[i];
    if (quality[i]) m.q = quality[i];
  }
  if (end) touch(rep);
  return added;
}

// Removes a move and everything that becomes unreachable from the start position.
export function removeMove(rep, epd, san) {
  const p = rep.positions[epd]; if (!p?.moves[san]) return 0;
  delete p.moves[san];
  const n = prune(rep);
  touch(rep);
  return n + 1;
}
export function prune(rep) {
  const seen = reachable(rep);
  let n = 0;
  for (const epd of Object.keys(rep.positions)) {
    if (!seen.has(epd)) { n += Object.keys(rep.positions[epd].moves).length; delete rep.positions[epd]; }
    else if (!Object.keys(rep.positions[epd].moves).length && !rep.positions[epd].excluded?.length) delete rep.positions[epd];
  }
  return n;
}
export function reachable(rep) {
  const seen = new Set([START_EPD]); const stack = [START_EPD];
  while (stack.length) {
    const e = stack.pop();
    for (const m of movesAt(rep, e)) if (!seen.has(m.to)) { seen.add(m.to); stack.push(m.to); }
  }
  return seen;
}
// How many moves would disappear if this move were removed.
export function subtreeSize(rep, epd, san) {
  const clone = { color: rep.color, positions: structuredClone(rep.positions) };
  delete clone.positions[epd].moves[san];
  return prune(clone) + 1;
}

export function countMoves(rep) {
  let mine = 0, all = 0;
  for (const p of Object.values(rep.positions)) for (const m of Object.values(p.moves)) { all++; if (m.mine) mine++; }
  return { mine, all };
}

// All (epd, move) pairs for my moves, with one shortest line leading to each.
export function myCards(rep) {
  const out = [];
  const seen = new Set([START_EPD]);
  let frontier = [{ epd: START_EPD, line: [] }];
  while (frontier.length) {
    const next = [];
    for (const { epd, line } of frontier) {
      for (const m of movesAt(rep, epd)) {
        if (m.mine && !m.disabled) out.push({ epd, move: m, line });
        if (m.mine && m.disabled) continue;
        if (!seen.has(m.to)) { seen.add(m.to); next.push({ epd: m.to, line: [...line, m.san] }); }
      }
    }
    frontier = next;
  }
  return out;
}

// A shortest SAN line from the start to a position, or null.
export function lineTo(rep, target) {
  if (target === START_EPD) return [];
  const prev = new Map([[START_EPD, null]]);
  let frontier = [START_EPD];
  while (frontier.length) {
    const next = [];
    for (const epd of frontier) for (const m of movesAt(rep, epd)) {
      if (prev.has(m.to)) continue;
      prev.set(m.to, { epd, san: m.san });
      if (m.to === target) {
        const line = []; let e = target;
        while (prev.get(e)) { line.unshift(prev.get(e).san); e = prev.get(e).epd; }
        return line;
      }
      next.push(m.to);
    }
    frontier = next;
  }
  return null;
}

// ---------------- coverage analysis ----------------
// Walks the repertoire from the start position in order of how often positions occur.
//  * my turn with no saved reply  -> a gap
//  * opponent's turn              -> fetch peer stats; the most frequent replies that are needed to reach the
//                                    per-position coverage goal (and are above the minimum frequency) must be answered.
// Positions rarer than 1 in N games (incidence threshold) are never required.
const analysisCache = new Map(); // rep.id -> {key, result}
export function invalidateAnalysis() { analysisCache.clear(); }

export function requiredMoves(stats, p, s) {
  // -> {rows:[{san, freq, cum, status}], covered, denom}
  const excluded = new Set(p?.excluded || []);
  const total = stats?.total || 0;
  const rows = [];
  if (!total) return { rows, covered: 0, goalMet: true, thin: true };
  const exFreq = stats.moves.filter(m => excluded.has(m.san)).reduce((a, m) => a + m.total, 0) / total;
  const denom = Math.max(1e-9, 1 - exFreq);
  const goal = s.coverageGoal / 100, minF = s.minMoveFreq / 100;
  let cum = 0, covered = 0;
  const sorted = [...stats.moves].sort((a, b) => b.total - a.total);
  for (const m of sorted) {
    const freq = m.total / total;
    const have = !!p?.moves[m.san];
    let status;
    if (excluded.has(m.san)) status = 'excluded';
    else {
      const eff = freq / denom;
      if (eff < minF) status = have ? 'covered' : 'rare';
      else if (cum >= goal - 1e-9) status = have ? 'covered' : 'optional';
      else status = have ? 'covered' : 'needed';
      if (status === 'needed' || (have && eff >= minF && cum < goal - 1e-9)) cum += eff;
      else if (have) { /* extra coverage beyond the goal */ }
      if (have) covered += eff;
    }
    rows.push({ san: m.san, uci: m.uci, freq, share: freq / denom, status, have, opening: m.opening, stats: m });
  }
  return { rows, covered: Math.min(1, covered), goal, goalMet: !rows.some(r => r.status === 'needed'), denom };
}

export async function analyze(rep, { onProgress, prio = -5, signal } = {}) {
  const s = repSettings(rep);
  const key = [rep.rev || 0, s.incidenceN, s.coverageGoal, s.minMoveFreq, s.minGames, s.maxDepth, s.rating, s.ratingPlatform, s.speeds.join(), (s.ratingBuckets || []).join()].join('|');
  const hit = analysisCache.get(rep.id);
  if (hit && hit.key === key) return hit.result instanceof Promise ? hit.result : hit.result;
  const promise = (async () => {
    const threshold = 1 / s.incidenceN;
    const gaps = [];
    const incidence = new Map();   // epd -> incidence
    const gapMass = new Map();     // epd -> total incidence of gaps below it
    const best = new Map([[START_EPD, 1]]);
    const heap = [{ epd: START_EPD, inc: 1, line: [], path: [START_EPD] }];
    let visited = 0, thin = 0;
    const addGap = g => { gaps.push(g); for (const e of new Set(g.path)) gapMass.set(e, (gapMass.get(e) || 0) + g.incidence); };
    while (heap.length) {
      if (signal?.aborted) throw new Error('aborted');
      // pop the most frequent position
      let bi = 0; for (let i = 1; i < heap.length; i++) if (heap[i].inc > heap[bi].inc) bi = i;
      const node = heap.splice(bi, 1)[0];
      if (incidence.has(node.epd)) continue;
      incidence.set(node.epd, node.inc);
      visited++;
      const p = rep.positions[node.epd];
      const required = node.inc >= threshold && node.line.length < s.maxDepth;
      if (isMine(rep, node.epd)) {
        const mine = myMovesAt(rep, node.epd);
        if (!mine.length) { if (required) addGap({ epd: node.epd, line: node.line, path: node.path, incidence: node.inc, kind: 'reply' }); continue; }
        for (const m of mine) push(node, m.san, m.to, node.inc);
      } else {
        const fen = fenOfEpd(node.epd);
        let stats = null;
        if (required || (p && Object.keys(p.moves).length)) stats = await explorer(fen, { prio, settings: s });
        if (onProgress && visited % 5 === 0) onProgress({ visited, gaps: gaps.length });
        const freqOf = {};
        if (stats && p) { // remember opening names for imported / autofilled lines
          if (stats.opening?.name && !p.name) p.name = stats.opening.name;
          for (const m of stats.moves) { const child = p.moves[m.san] && rep.positions[p.moves[m.san].to]; if (child && m.opening?.name && !child.name) child.name = m.opening.name; }
        }
        if (stats?.total) for (const m of stats.moves) freqOf[m.san] = m.total / stats.total;
        if (required && stats && stats.total >= s.minGames) {
          const req = requiredMoves(stats, p, s);
          for (const r of req.rows) {
            if (r.status !== 'needed') continue;
            const inc = node.inc * r.freq;
            if (inc < threshold) continue;
            // the reply position is a gap: opponent's move is not in the repertoire yet
            const c = new Chess(fen); let epdAfter;
            try { c.move(r.san); epdAfter = epdOf(c.fen()); } catch { continue; }
            addGap({ epd: epdAfter, line: [...node.line, r.san], path: [...node.path, epdAfter], incidence: inc, kind: 'new', opening: r.opening?.name });
          }
        } else if (required && stats && stats.total < s.minGames) thin++;
        for (const m of movesAt(rep, node.epd)) push(node, m.san, m.to, node.inc * (freqOf[m.san] ?? (stats?.total ? 0.5 / stats.total : 0.01)));
      }
    }
    function push(node, san, to, inc) {
      if (incidence.has(to) || (best.get(to) || 0) >= inc) return;
      best.set(to, inc);
      heap.push({ epd: to, inc, line: [...node.line, san], path: [...node.path, to] });
    }
    gaps.sort((a, b) => b.incidence - a.incidence);
    const missing = Math.min(1, gaps.reduce((a, g) => a + g.incidence, 0));
    const result = { gaps, incidence, gapMass, completion: 1 - missing, visited, thin, key };
    analysisCache.set(rep.id, { key, result });
    return result;
  })();
  analysisCache.set(rep.id, { key, result: promise });
  promise.catch(() => { if (analysisCache.get(rep.id)?.result === promise) analysisCache.delete(rep.id); });
  return promise;
}
export function cachedAnalysis(rep) {
  const hit = analysisCache.get(rep.id);
  return hit && !(hit.result instanceof Promise) ? hit.result : null;
}
// Completion of the sub-tree below a position: share of games reaching it that stay in book.
export function subCompletion(an, epd) {
  const inc = an.incidence.get(epd);
  if (!inc) return null;
  return Math.max(0, 1 - (an.gapMass.get(epd) || 0) / inc);
}

// ---------------- spaced repetition ----------------
const DAY = 86400e3;
export function newCard() { return { due: 0, interval: 0, ease: 2.3, reps: 0, lapses: 0 }; }
export function isDue(m, now = Date.now()) { return m.mine && !m.disabled && (m.srs?.due ?? 0) <= now; }
export function grade(m, correct, now = Date.now()) {
  const c = (m.srs ||= newCard());
  if (correct) {
    c.reps++;
    c.interval = c.reps === 1 ? 1 : c.reps === 2 ? 3 : Math.round(Math.max(c.interval + 1, c.interval * c.ease));
    c.ease = Math.min(2.8, c.ease + 0.05);
    c.due = now + c.interval * DAY - 4 * 3600e3; // a little slack so "tomorrow" means tomorrow
  } else {
    c.lapses++; c.reps = 0;
    c.interval = 0;
    c.ease = Math.max(1.5, c.ease - 0.25);
    c.due = now + 10 * 60e3;
  }
  c.last = now;
}
export function mastery(m) { // 0..1, saturates once the interval reaches about a month
  const i = m.srs?.interval || 0;
  return Math.min(1, Math.log(1 + i) / Math.log(31));
}
export function learnStats(rep, now = Date.now()) {
  const cards = myCards(rep);
  let due = 0, mast = 0, nextDue = Infinity, fresh = 0;
  for (const c of cards) {
    if (isDue(c.move, now)) due++; else nextDue = Math.min(nextDue, c.move.srs.due);
    if (!c.move.srs?.last) fresh++;
    mast += mastery(c.move);
  }
  return { total: cards.length, due, fresh, mastery: cards.length ? mast / cards.length : 0, nextDue };
}

// Builds practice lines: paths through the repertoire that pass over the selected cards.
// Returns [{sans:[...], quiz:Set(ply index)}]
export function practiceLines(rep, { dueOnly = true, fromLine = [], limit = Infinity, now = Date.now() } = {}) {
  const start = replay(fromLine);
  const startEpd = start.length ? start[start.length - 1].epdAfter : START_EPD;
  const lines = [];
  const expanded = new Set();
  // DFS collecting root-to-leaf lines; a position reached again by transposition is not expanded twice
  const walk = (epd, sans, quizzes) => {
    const moves = expanded.has(epd) ? [] : movesAt(rep, epd).filter(m => !(m.mine && m.disabled));
    expanded.add(epd);
    if (!moves.length) { if (quizzes.length) lines.push({ sans, quiz: new Set(quizzes) }); return; }
    for (const m of moves) {
      const q = m.mine && (!dueOnly || isDue(m, now));
      walk(m.to, [...sans, m.san], q ? [...quizzes, sans.length] : quizzes);
    }
  };
  walk(startEpd, [...fromLine], []);
  // de-duplicate quizzes shared between lines (keep the first occurrence)
  const seen = new Set(); const out = []; let count = 0;
  for (const l of lines) {
    const steps = replay(l.sans);
    const quiz = new Set();
    for (const i of l.quiz) { const k = steps[i].epdBefore + '|' + steps[i].san; if (!seen.has(k)) { seen.add(k); quiz.add(i); } }
    if (!quiz.size) continue;
    if (count >= limit) break;
    if (count + quiz.size > limit) { const keep = [...quiz].sort((a, b) => a - b).slice(0, limit - count); out.push({ sans: l.sans.slice(0, keep[keep.length - 1] + 1), quiz: new Set(keep) }); count = limit; break; }
    const lastQ = Math.max(...quiz);
    out.push({ sans: l.sans.slice(0, lastQ + 1), quiz }); count += quiz.size;
  }
  return out;
}

// ---------------- PGN ----------------
export function importPgn(rep, text, { maxPly = 60 } = {}) {
  const games = parsePgnGames(text);
  let lines = 0, added = 0, skipped = 0;
  for (const g of games) {
    if (g.root.fen && g.root.fen !== START_FEN) { skipped++; continue; }
    for (const l of pgnLines(g.root)) {
      const before = countMoves(rep).all;
      addLine(rep, l.sans.slice(0, maxPly), { notes: l.comments });
      added += countMoves(rep).all - before; lines++;
    }
  }
  return { games: games.length, lines, added, skipped };
}
// Import my side's moves from played games (first `plies` plies of games played with the repertoire colour).
export function importGames(rep, games, plies = 16) {
  let added = 0;
  for (const g of games) {
    if (g.color !== rep.color) continue;
    const before = countMoves(rep).all;
    addLine(rep, g.moves.slice(0, plies));
    added += countMoves(rep).all - before;
  }
  return added;
}

export function exportPgn(rep) {
  const onPath = new Set();
  const render = (epd, ply, forceNumber) => {
    const moves = movesAt(rep, epd).filter(m => !onPath.has(m.to));
    if (!moves.length) return '';
    const [main, ...alts] = moves;
    const tok = (m, force) => {
      let s = ply % 2 === 0 ? `${ply / 2 + 1}. ` : force ? `${(ply + 1) / 2}... ` : '';
      s += m.san;
      if (m.note) s += ` {${m.note.replace(/[{}]/g, '')}}`;
      return s;
    };
    let s = tok(main, forceNumber);
    for (const a of alts) {
      onPath.add(a.to);
      const rest = render(a.to, ply + 1, false);
      onPath.delete(a.to);
      s += ` (${tok(a, true)}${rest ? ' ' + rest : ''})`;
    }
    onPath.add(main.to);
    const rest = render(main.to, ply + 1, alts.length > 0 || !!main.note);
    onPath.delete(main.to);
    return s + (rest ? ' ' + rest : '');
  };
  onPath.add(START_EPD);
  const body = render(START_EPD, 0, false);
  const d = new Date();
  return `[Event "${rep.name.replace(/"/g, "'")}"]\n[Site "OpeningForge"]\n[Date "${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}"]\n[White "${rep.color === 'w' ? 'Me' : 'Opponent'}"]\n[Black "${rep.color === 'b' ? 'Me' : 'Opponent'}"]\n[Result "*"]\n\n${body} *\n`;
}

// Repertoire-level quality scores (0-100) from the snapshots stored when moves were added.
export function qualityStats(rep) {
  let n = 0, snd = 0, eff = 0, lrn = 0;
  for (const p of Object.values(rep.positions)) for (const m of Object.values(p.moves)) {
    if (!m.mine || !m.q) continue;
    n++;
    snd += m.q.loss == null ? 0.7 : Math.max(0, 1 - m.q.loss / 100);
    eff += m.q.win == null ? 0.5 : Math.max(0, Math.min(1, (m.q.win - 0.4) / 0.2));
    lrn += Math.min(1, Math.sqrt(m.q.share || 0));
  }
  if (!n) return null;
  return { n, soundness: Math.round(100 * snd / n), effectiveness: Math.round(100 * eff / n), learnability: Math.round(100 * lrn / n) };
}

export { lineText };
