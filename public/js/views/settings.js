// Global settings, new repertoire, first-run setup.
import { state, save, flush, applyData, newRepertoire, DEFAULT_SETTINGS, ALL_BUCKETS, ALL_SPEEDS, ratingBuckets, lichessEquivalent } from '../store.js';
import { h, icon, toast, confirmDialog, download, pickFile } from '../ui.js';
import { START_FEN } from '../chessutil.js';
import * as R from '../repertoire.js';

function ratingControls(onChange) {
  const s = state.settings;
  const info = h('span.muted.small');
  const upd = () => { info.textContent = `Opponent statistics use Lichess games rated ${ratingBuckets(s).map(b => b + '+').join(', ')} (≈ ${lichessEquivalent(s)} Lichess).`; };
  upd();
  const set = (k, v) => { s[k] = v; save(); R.invalidateAnalysis(); upd(); onChange?.(); };
  return [
    h('div.set-row', h('span', 'Your rating'), h('span', h('input.num-input.wide', { type: 'number', min: 400, max: 3000, step: 50, value: s.rating, onchange: e => set('rating', Math.max(400, Math.min(3000, +e.target.value || 1500))) }))),
    h('div.set-row', h('span', 'Platform'), h('select', { onchange: e => set('ratingPlatform', e.target.value) }, [['lichess', 'Lichess'], ['chesscom', 'Chess.com'], ['fide', 'FIDE / over the board']].map(([v, l]) => h('option', { value: v, selected: s.ratingPlatform === v }, l)))),
    h('div.set-row', h('span', 'Time controls'), h('span.chips', ALL_SPEEDS.filter(x => x !== 'ultraBullet' && x !== 'correspondence').map(sp => h('label.chip', h('input', { type: 'checkbox', checked: s.speeds.includes(sp), onchange: e => { const next = e.target.checked ? [...s.speeds, sp] : s.speeds.filter(x => x !== sp); if (next.length) set('speeds', next); else e.target.checked = true; } }), sp)))),
    h('div.set-note', info),
  ];
}

export function settingsView(ctx) {
  const side = ctx.side; const s = state.settings;
  ctx.setCrumbs([{ label: 'Settings' }]); ctx.setLine(null);
  ctx.board.set({ fen: START_FEN, interactive: false });
  const num = (k, min, max, step, after) => h('input.num-input', { type: 'number', min, max, step, value: s[k], onchange: e => { const v = Math.max(min, Math.min(max, parseFloat(e.target.value))); if (!isNaN(v)) { s[k] = v; save(); after?.(); } } });
  const sel = (k, opts, after) => h('select', { onchange: e => { const o = opts.find(x => String(x[0]) === e.target.value); s[k] = o[0]; save(); after?.(); } }, opts.map(([v, l]) => h('option', { value: v, selected: s[k] === v }, l)));
  const chk = (k, after) => h('input', { type: 'checkbox', checked: !!s[k], onchange: e => { s[k] = e.target.checked; save(); after?.(); } });
  const row = (label, control, help) => h('div.set-row', h('span', label, help && h('div.muted.small', help)), control);
  const inval = () => R.invalidateAnalysis();
  const boardUpd = () => ctx.board.applySettings();

  function render() {
    side.innerHTML = '';
    const custom = !!s.ratingBuckets?.length;
    const text = (k, type = 'text', ph = '') => h('input', { type, placeholder: ph, value: s[k] || '', autocomplete: 'off', onchange: e => { s[k] = e.target.value.trim(); save(); if (k === 'lichessToken') flush(); } });
    const root = h('div.view.settings', h('h1', 'Settings'),
      h('div.section-head', h('span', 'Who you play against')),
      ratingControls(render),
      row('Pick Lichess rating bands manually', h('input', { type: 'checkbox', checked: custom, onchange: e => { s.ratingBuckets = e.target.checked ? ratingBuckets(s) : null; save(); inval(); render(); } })),
      custom && h('div.set-row', h('span', 'Rating bands'), h('span.chips', ALL_BUCKETS.map(b => h('label.chip', h('input', { type: 'checkbox', checked: s.ratingBuckets.includes(b), onchange: e => { const next = e.target.checked ? [...s.ratingBuckets, b] : s.ratingBuckets.filter(x => x !== b); if (next.length) { s.ratingBuckets = next; save(); inval(); render(); } else e.target.checked = true; } }), b + '+')))),

      h('div.section-head', h('span', 'Coverage — how much do you want to prepare?')),
      row('Cover positions seen in', sel('incidenceN', [[50, 'Light — 1 in 50 games'], [100, 'Casual — 1 in 100 games'], [150, 'Standard — 1 in 150 games'], [200, 'Advanced — 1 in 200 games'], [300, 'Tournament ready — 1 in 300 games'], [400, 'Bulletproof — 1 in 400 games'], [600, 'Overkill — 1 in 600 games'], [800, 'Extreme — 1 in 800 games'], ...([50, 100, 150, 200, 300, 400, 600, 800].includes(s.incidenceN) ? [] : [[s.incidenceN, `Custom — 1 in ${s.incidenceN} games`]])], inval), 'Depth: lines keep going until the position becomes rarer than this.'),
      row('…or an exact value: 1 in', num('incidenceN', 5, 5000, 25, () => { inval(); render(); })),
      row('Coverage goal per position (%)', num('coverageGoal', 10, 100, 5, inval), 'Breadth: share of the opponent\'s replies you want an answer to in each position.'),
      row('Ignore opponent moves under (%)', num('minMoveFreq', 0, 50, 0.5, inval), 'Replies played less often than this in a position are never required.'),
      row('Minimum games for reliable statistics', num('minGames', 1, 100000, 10, inval)),
      row('Maximum depth (plies)', num('maxDepth', 4, 80, 2, inval)),

      h('div.section-head', h('span', 'Move recommendations')),
      row('Sound move threshold (centipawns)', num('evalThreshold', 0, 300, 5), 'Your candidate moves within this distance of the best evaluation are marked as sound.'),
      row('Use local Stockfish when there is no cloud evaluation', chk('engineFallback')),
      row('Local engine depth', num('engineDepth', 8, 24, 1)),
      row('Save moves as soon as I play them in the builder', chk('autoSave')),

      h('div.section-head', h('span', 'Practice')),
      row('Practice', sel('practiceMode', [['moves', 'Individual moves'], ['lines', 'Complete lines (every time)'], ['linesOnce', 'Complete lines (once per session)']])),
      row('Daily practice goal', sel('dailyGoal', [[10, '10 moves'], [20, '20 moves'], [50, '50 moves'], [100, '100 moves']]), 'Also the size of a daily practice batch.'),
      row('Pause after playing a move', sel('pauseAfter', [['never', 'Never'], ['always', 'Always'], ['wrong', 'When you get it wrong'], ['note', "When there's a note"]])),

      h('div.section-head', h('span', 'Board')),
      row('Appearance', sel('boardTheme', [['forest', 'Forest'], ['walnut', 'Walnut'], ['ocean', 'Ocean'], ['slate', 'Slate'], ['sand', 'Sand']], boardUpd)),
      row('Piece animation', sel('animation', [[500, 'Slow'], [300, 'Normal'], [200, 'Fast'], [100, 'Very fast'], [0, 'Disabled']], boardUpd)),
      row('Sound effects', chk('sound')),
      row('Coordinates', chk('showCoords', boardUpd)),

      h('div.section-head', h('span', 'Accounts & data sources')),
      row('Lichess username', text('lichessUser')),
      row('Chess.com username', text('chesscomUser')),
      row('Lichess API token', text('lichessToken', 'password', 'optional'), ['Only needed if Lichess asks for sign-in to use the opening explorer. Create one (no scopes needed) at ', h('a', { href: 'https://lichess.org/account/oauth/token', target: '_blank', rel: 'noopener' }, 'lichess.org/account/oauth/token'), '. It is stored only on this computer.']),
      row('Model games source', sel('modelSource', [['masters', 'Master games'], ['lichess', 'High-level online games'], ['both', 'Online and master games']])),

      h('div.section-head', h('span', 'Backup')),
      h('div.actions',
        h('button.action', { onclick: () => download(`openingforge-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ ...state, settings: { ...state.settings, lichessToken: '' } }, null, 1), 'application/json') }, h('span', icon('download'), ' Export everything (JSON backup)')),
        h('button.action', { onclick: async () => {
          const t = await pickFile('.json'); if (!t) return;
          let data; try { data = JSON.parse(t); } catch { return toast('That file is not valid JSON', 'err'); }
          if (!Array.isArray(data.repertoires)) return toast('That file is not an OpeningForge backup', 'err');
          if (!(await confirmDialog('Restore backup?', `This replaces your current ${state.repertoires.length} repertoires with the ${data.repertoires.length} in the backup.`, 'Restore', true))) return;
          const token = state.settings.lichessToken; applyData(data); if (!state.settings.lichessToken) state.settings.lichessToken = token;
          R.invalidateAnalysis(); save(); toast('Backup restored', 'ok'); ctx.go('/');
        } }, h('span', icon('upload'), ' Restore from backup…')),
        h('button.action', { onclick: async () => {
          if (!(await confirmDialog('Reset all learning?', 'Your repertoires and moves stay exactly as they are. Review history, the spaced-repetition schedule, model game history and daily totals are wiped.', 'Reset all learning', true))) return;
          for (const rep of state.repertoires) for (const p of Object.values(rep.positions)) for (const m of Object.values(p.moves)) if (m.mine) m.srs = R.newCard();
          state.activity = {}; state.modelHistory = []; save(); toast('Learning progress reset');
        } }, h('span', icon('undo'), ' Reset all learning')),
        h('button.action', { onclick: async () => { if (await confirmDialog('Restore default settings?', 'Repertoires are not affected.', 'Restore defaults')) { const keep = { lichessUser: s.lichessUser, chesscomUser: s.chesscomUser, lichessToken: s.lichessToken }; Object.assign(s, DEFAULT_SETTINGS, keep); save(); inval(); boardUpd(); render(); } } }, h('span', icon('gear'), ' Restore default settings'))),
      h('p.muted.small.pad', 'Your data lives in the data/ folder next to the app (store.json, with daily backups). Lichess responses are cached there too, so revisiting a position is instant and gentle on the Lichess API.'));
    side.append(root);
  }
  render();
}

export function newRepView(ctx) {
  const side = ctx.side; let color = 'w';
  ctx.setCrumbs([{ label: 'New repertoire' }]); ctx.setLine(null);
  function render() {
    side.innerHTML = '';
    const name = h('input', { type: 'text', placeholder: color === 'w' ? 'e.g. White — blitz' : 'e.g. Black — solid' });
    side.append(h('div.view', h('h1', 'Add new repertoire'),
      h('p.sub', 'A repertoire is a collection of openings for one colour. Create a separate one only if you want something entirely different (say, bullet versus classical); otherwise add alternative moves to an existing one.'),
      h('div.set-row', h('span', 'Colour'), h('span.seg', h('button' + (color === 'w' ? '.on' : ''), { onclick: () => { color = 'w'; render(); } }, 'White'), h('button' + (color === 'b' ? '.on' : ''), { onclick: () => { color = 'b'; render(); } }, 'Black'))),
      h('div.set-row', h('span', 'Name'), name),
      h('div.actions', h('button.action.primary', { onclick: () => { const rep = newRepertoire(name.value.trim() || (color === 'w' ? 'White openings' : 'Black openings'), color); state.repertoires.push(rep); save(); ctx.go(`/rep/${rep.id}`, true); } }, h('span', icon('plus'), ' Create repertoire')))));
  }
  render();
}

export function onboardingView(ctx) {
  const side = ctx.side;
  ctx.setCrumbs([]); ctx.setLine(null);
  ctx.board.set({ fen: START_FEN, interactive: false });
  const finish = to => { state.onboarded = true; save(); ctx.go(to, true); };
  const w = state.repertoires.find(r => r.color === 'w'), b = state.repertoires.find(r => r.color === 'b');
  side.append(h('div.view', h('h1', 'Set up your repertoire'),
    h('p.sub', 'OpeningForge helps you build an opening repertoire around the moves your opponents actually play, pick sound replies with engine evaluations, and memorise it with spaced repetition.'),
    h('div.section-head', h('span', "What's your rating?")),
    h('p.muted.small', 'This decides which games are used to predict your opponents\' moves.'),
    ratingControls(),
    h('div.actions',
      h('button.action.primary', { onclick: () => finish(`/rep/${w.id}/build`) }, h('span', icon('plus'), ' Start building as White')),
      h('button.action', { onclick: () => finish(`/rep/${b.id}/build`) }, h('span', icon('plus'), ' Start building as Black')),
      h('button.action', { onclick: () => finish(`/rep/${w.id}/import`) }, h('span', icon('upload'), ' Import an existing repertoire (PGN / Lichess study)')),
      h('button.action.subtle', { onclick: () => finish('/') }, h('span', 'Skip, take me to the home screen')))));
}
