// Persistent application state. Saved to the local server (data/store.json) with a localStorage mirror.
export const DEFAULT_SETTINGS = {
  // who you play
  rating: 1500, ratingPlatform: 'lichess', // lichess | chesscom | fide
  speeds: ['blitz', 'rapid'],
  ratingBuckets: null, // explicit Lichess rating buckets override, e.g. [1600,1800]
  // coverage model
  incidenceN: 150,          // cover positions seen in at least 1 in N games
  coverageGoal: 90,         // % of opponent replies to answer in each position
  minMoveFreq: 2,           // % — ignore opponent moves rarer than this in a position
  minGames: 50,             // stop when the explorer has fewer games than this for a position
  maxDepth: 40,             // plies
  // recommendations
  evalThreshold: 30,        // centipawns from the best move still considered acceptable
  engineFallback: true,     // use local Stockfish when no cloud eval exists
  engineDepth: 16,
  candidateSort: 'smart',   // smart | popularity | eval | winrate
  hideWeakMoves: false,
  autoSave: false,          // save moves as soon as they are played in the builder
  // practice
  practiceMode: 'moves',    // moves | lines | linesOnce
  dailyGoal: 10,
  pauseAfter: 'wrong',      // never | always | wrong | note
  // board
  boardTheme: 'walnut', animation: 200, sound: true, showCoords: true,
  // accounts
  lichessUser: '', chesscomUser: '', lichessToken: '',
  modelSource: 'masters',   // masters | lichess | both
};

export const state = {
  version: 1,
  settings: { ...DEFAULT_SETTINGS },
  repertoires: [],
  activity: {},     // 'YYYY-MM-DD' -> {practiced, correct}
  gameReview: null, // cached result of the last online games scan
  modelHistory: [], // [{id, repId, date, score, total}]
  onboarded: false,
};

let serverOk = true, saveTimer = null, listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export async function load() {
  let data = null;
  try {
    const r = await fetch('/api/store');
    if (r.ok) data = await r.json(); else serverOk = false;
  } catch { serverOk = false; }
  if (!data) { try { data = JSON.parse(localStorage.getItem('openingforge-store') || 'null'); } catch { /* ignore */ } }
  if (data) applyData(data);
  if (!state.repertoires.length) {
    state.repertoires.push(newRepertoire('White openings', 'w'), newRepertoire('Black openings', 'b'));
  }
}

export function applyData(data) {
  Object.assign(state, data);
  state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  state.repertoires ||= []; state.activity ||= {}; state.modelHistory ||= [];
  for (const r of state.repertoires) { r.positions ||= {}; r.overrides ||= {}; }
}

export function save() {
  for (const fn of listeners) fn();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}
export async function flush() {
  clearTimeout(saveTimer);
  const text = JSON.stringify(state);
  try { localStorage.setItem('openingforge-store', text); } catch { /* quota: server copy is authoritative */ }
  if (!serverOk) return;
  try { await fetch('/api/store', { method: 'PUT', body: text, headers: { 'Content-Type': 'application/json' } }); } catch { /* retry on next save */ }
}
window.addEventListener('beforeunload', () => {
  if (saveTimer) { clearTimeout(saveTimer); try { const x = new XMLHttpRequest(); x.open('PUT', '/api/store', false); x.setRequestHeader('Content-Type', 'application/json'); x.send(JSON.stringify(state)); } catch { /* ignore */ } }
});

export function uid() { return Math.random().toString(36).slice(2, 10); }
export function newRepertoire(name, color) {
  return { id: uid(), name, color, positions: {}, overrides: {}, created: Date.now() };
}
export function getRep(id) { return state.repertoires.find(r => r.id === id); }

// Effective settings for a repertoire (per-repertoire overrides of the coverage model).
export function repSettings(rep) { return { ...state.settings, ...(rep?.overrides || {}) }; }

export function today(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function recordPractice(correct) {
  const a = (state.activity[today()] ||= { practiced: 0, correct: 0 });
  a.practiced++; if (correct) a.correct++;
}
export function streak() {
  let n = 0; const d = new Date();
  if (!state.activity[today(d)]?.practiced) d.setDate(d.getDate() - 1);
  while (state.activity[today(d)]?.practiced) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

// Lichess rating buckets implied by the user's rating.
const BUCKETS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
export const ALL_BUCKETS = BUCKETS;
export const ALL_SPEEDS = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'];
export function lichessEquivalent(s) {
  const off = s.ratingPlatform === 'chesscom' ? 200 : s.ratingPlatform === 'fide' ? 250 : 0;
  return s.rating + off;
}
export function ratingBuckets(s) {
  if (s.ratingBuckets?.length) return [...s.ratingBuckets].sort((a, b) => a - b);
  const r = lichessEquivalent(s);
  let i = 0;
  while (i + 1 < BUCKETS.length && BUCKETS[i + 1] <= r) i++;
  // the bucket containing the rating plus its closest neighbour
  const lo = BUCKETS[i], hi = BUCKETS[i + 1] ?? 3000;
  const j = (r - lo) > (hi - lo) / 2 ? Math.min(i + 1, BUCKETS.length - 1) : Math.max(i - 1, 0);
  return [...new Set([BUCKETS[i], BUCKETS[j]])].sort((a, b) => a - b);
}
