// Repertoire overview, learn menu, line browser, import and per-repertoire settings.
import { state, save, getRep, repSettings } from '../store.js';
import { h, icon, toast, pct, oneIn, relTime, progressBar, confirmDialog, download, pickFile } from '../ui.js';
import { START_FEN, START_EPD, replay, lineText, moveLabel, parsePgnGames, mainline } from '../chessutil.js';
import * as R from '../repertoire.js';
import { studyPgn, lichessGames, chesscomGames } from '../api.js';
import { encLine, decLine } from '../app.js';

export function overviewView(ctx) {
  const rep = getRep(ctx.params.rep);
  if (!rep) { ctx.go('/'); return; }
  const side = ctx.side; let alive = true, an = R.cachedAnalysis(rep), progress = null;
  ctx.board.set({ fen: START_FEN, interactive: false, orientation: rep.color === 'w' ? 'white' : 'black' });
  ctx.setCrumbs([{ label: rep.name }]);
  ctx.setLine(null);

  function render() {
    side.innerHTML = '';
    const root = h('div.view');
    const cnt = R.countMoves(rep), ls = R.learnStats(rep), q = R.qualityStats(rep);
    root.append(h('h1', rep.name));
    if (!cnt.mine) {
      root.append(h('p.sub', `This ${rep.color === 'w' ? 'White' : 'Black'} repertoire is empty. Build it move by move, or import lines you already know.`),
        h('div.actions',
          h('a.action.primary', { href: `#/rep/${rep.id}/build` }, h('span', icon('plus'), ' Start building')),
          h('a.action', { href: `#/rep/${rep.id}/import` }, h('span', icon('upload'), ' Import from PGN, a Lichess study or your games')),
          h('a.action', { href: `#/rep/${rep.id}/autofill` }, h('span', icon('wand'), ' Autofill a starter repertoire')),
          h('a.action.subtle', { href: `#/rep/${rep.id}/settings` }, h('span', icon('gear'), ' Settings'))));
      side.append(root); return;
    }
    root.append(h('div.comp', h('div.comp-head', h('b', an ? `${pct(an.completion)} complete` : 'Analysing coverage…'),
      h('span.muted', an ? (an.gaps.length ? `${an.gaps.length} gap${an.gaps.length === 1 ? '' : 's'}` : 'no gaps at your coverage settings') : progress ? `${progress.visited} positions checked` : '')),
      progressBar(an?.completion ?? 0, { cls: an?.completion > 0.999 ? 'ok' : '' })));
    const s = repSettings(rep);
    root.append(h('p.muted.small', `Goal: answer ${s.coverageGoal}% of replies (moves ≥ ${s.minMoveFreq}%) in every position seen at least 1 in ${s.incidenceN} games.`));

    root.append(h('div.section-head', h('span', 'Build')));
    const acts = h('div.actions');
    if (an?.gaps.length) acts.append(h('a.action.primary', { href: `#/rep/${rep.id}/build/${encLine(an.gaps[0].line)}` }, h('span', icon('target'), ' Go to your biggest gap'), h('span.muted', `${oneIn(an.gaps[0].incidence)} games`)));
    acts.append(h('a.action', { href: `#/rep/${rep.id}/build` }, h('span', icon('plus'), ' Continue building')),
      h('a.action', { href: `#/rep/${rep.id}/autofill` }, h('span', icon('wand'), ' Autofill remaining gaps')),
      h('a.action', { href: `#/rep/${rep.id}/browse` }, h('span', icon('tree'), ' Browse all lines'), h('span.muted', `${cnt.mine} moves`)));
    root.append(acts);
    if (an?.gaps.length) {
      root.append(h('div.section-head', h('span', 'Biggest gaps'), h('span.muted', 'expected in')));
      const list = h('div.table.gaps');
      for (const g of an.gaps.slice(0, 8)) list.append(h('a.trow.clickable', { href: `#/rep/${rep.id}/build/${encLine(g.line)}` },
        h('span.gap-line', lineText(g.line) || 'Starting position', g.opening && h('span.oname', ' ' + g.opening)), h('span.c.num', oneIn(g.incidence))));
      if (an.gaps.length > 8) list.append(h('div.trow.muted', `…and ${an.gaps.length - 8} more`));
      root.append(list);
    }

    root.append(h('div.section-head', h('span', 'Learn'), h('span.muted', `${ls.total} saved · ${pct(ls.mastery)} mastered`)));
    root.append(h('div.actions',
      h('a.action' + (ls.due ? '.primary' : ''), { href: `#/rep/${rep.id}/practice` }, h('span', icon('play'), ' Practice due moves'), h('span.muted', ls.due ? `${ls.due} due` : isFinite(ls.nextDue) ? `due in ${relTime(ls.nextDue)}` : '')),
      h('a.action', { href: `#/rep/${rep.id}/learn` }, h('span', icon('book'), ' Choose what to practice…')),
      h('a.action', { href: `#/model/${rep.id}` }, h('span', icon('users'), ' Model games in your lines'))));

    if (q) {
      root.append(h('div.section-head', h('span', 'Stats'), h('span.muted', `from ${q.n} moves`)));
      root.append(h('div.stats',
        stat('Effectiveness', q.effectiveness, 'How well your moves score for players around your rating'),
        stat('Soundness', q.soundness, 'How close your moves are to the engine\'s best move'),
        stat('Learnability', q.learnability, 'How natural (commonly played) your moves are'),
        h('div.stat.total', h('span', 'Total'), h('b', `${q.effectiveness + q.soundness + q.learnability} / 300`))));
    }
    root.append(h('div.actions', h('a.action.subtle', { href: `#/rep/${rep.id}/settings` }, h('span', icon('gear'), ' Repertoire settings, import & export'))));
    side.append(root);
  }
  const stat = (label, v, title) => h('div.stat', { title }, h('span', label), progressBar(v / 100, { cls: 'tiny' }), h('b', v));
  render();
  if (R.countMoves(rep).mine) R.analyze(rep, { prio: -3, onProgress: p => { progress = p; if (alive && !an) render(); } }).then(res => { an = res; if (alive) render(); }).catch(() => {});
  return () => { alive = false; };
}

// ---------- learn menu: drill into a specific opening ----------
function subtreeStats(rep, epd) {
  const seen = new Set([epd]); const stack = [epd];
  let n = 0, due = 0, mast = 0, next = Infinity;
  while (stack.length) {
    const e = stack.pop();
    for (const m of R.movesAt(rep, e)) {
      if (m.mine && m.disabled) continue;
      if (m.mine) { n++; mast += R.mastery(m); if (R.isDue(m)) due++; else next = Math.min(next, m.srs.due); }
      if (!seen.has(m.to)) { seen.add(m.to); stack.push(m.to); }
    }
  }
  return { n, due, mastery: n ? mast / n : 0, next };
}

export function learnView(ctx) {
  const rep = getRep(ctx.params.rep);
  if (!rep) { ctx.go('/'); return; }
  const side = ctx.side;
  let steps = replay(decLine(ctx.params.line));
  ctx.setCrumbs([{ label: rep.name, href: `/rep/${rep.id}` }, { label: 'Learn' }]);
  function render() {
    const line = steps.map(s => s.san);
    const epd = steps.length ? steps[steps.length - 1].epdAfter : START_EPD;
    const fen = steps.length ? steps[steps.length - 1].fenAfter : START_FEN;
    const last = steps[steps.length - 1];
    ctx.board.set({ fen, lastMove: last ? [last.from, last.to] : null, interactive: false, orientation: rep.color === 'w' ? 'white' : 'black' });
    ctx.setLine({ opening: rep.positions[epd]?.name || '', sans: line, cur: line.length, fen, onJump: i => { steps = steps.slice(0, i); ctx.silent(`/rep/${rep.id}/learn/${encLine(steps.map(s => s.san))}`); render(); } });
    side.innerHTML = '';
    const root = h('div.view');
    const all = subtreeStats(rep, epd);
    root.append(h('h1', steps.length ? 'What do you want to learn?' : 'What do you want to practice?'));
    root.append(h('p.sub', `${pct(all.mastery, 1)} mastered · ${all.n} move${all.n === 1 ? '' : 's'} ${steps.length ? 'from this position' : 'saved'}`));
    const pl = encLine(line);
    root.append(h('div.actions',
      h('a.action' + (all.due ? '.primary' : ''), { href: `#/rep/${rep.id}/practice/${pl}` }, h('span', icon('clock'), steps.length ? ' Practice due moves from here' : ' Just the moves that are due'), h('span.muted', `${all.due} due`)),
      h('a.action', { href: `#/rep/${rep.id}/practice/${pl}?mode=all` }, h('span', icon('play'), steps.length ? ' Practice all moves from here' : " All moves, even if they're not due"), h('span.muted', `${all.n} moves`))));
    const moves = R.movesAt(rep, epd).filter(m => !(m.mine && m.disabled));
    if (moves.length) {
      root.append(h('div.section-head', h('span', steps.length ? 'Or go deeper' : 'A specific opening…')));
      const tbl = h('div.table.learn', h('div.trow.thead', h('span', R.isMine(rep, epd) ? 'Your move' : "Opponent's move"), h('span'), h('span.c', 'Due'), h('span.c', 'Mastery')));
      for (const m of moves) {
        const st = subtreeStats(rep, m.to);
        const n = st.n + (m.mine ? 1 : 0);
        tbl.append(h('button.trow.clickable', { onclick: () => { steps = replay([...line, m.san]); ctx.silent(`/rep/${rep.id}/learn/${encLine(steps.map(s => s.san))}`); render(); } },
          h('span.mv-cell', h('span.mv-num', moveLabel(line.length, '').trim()), h('b', m.san)),
          h('span.name-cell', h('span.oname', rep.positions[m.to]?.name || ''), h('span.muted', ` ${n} move${n === 1 ? '' : 's'}`)),
          h('span.c.num', st.due ? `${st.due}` : isFinite(st.next) ? relTime(st.next) : '—'),
          h('span.c', progressBar(st.mastery, { cls: 'tiny ok' }))));
      }
      root.append(tbl);
    }
    side.append(root);
  }
  render();
}

// ---------- browse all lines ----------
export function browseView(ctx) {
  const rep = getRep(ctx.params.rep);
  if (!rep) { ctx.go('/'); return; }
  const side = ctx.side;
  ctx.setCrumbs([{ label: rep.name, href: `/rep/${rep.id}` }, { label: 'Lines' }]);
  ctx.board.set({ fen: START_FEN, interactive: false, orientation: rep.color === 'w' ? 'white' : 'black' });
  ctx.setLine(null);
  const collapsed = new Set(); let filter = '';
  const preview = sans => { const st = replay(sans); const l = st[st.length - 1]; if (l) ctx.board.set({ fen: l.fenAfter, lastMove: [l.from, l.to], interactive: false, animate: false }); };

  function branch(epd, line, onPath, depth) {
    // follow forced (single-move) sequences on one row, then list the alternatives beneath
    const frag = [];
    let moves = R.movesAt(rep, epd).filter(m => !onPath.has(m.to));
    for (const m of moves) {
      let seq = [m], e = m.to; const path = new Set(onPath); path.add(e);
      let next = R.movesAt(rep, e).filter(x => !path.has(x.to));
      while (next.length === 1) { seq.push(next[0]); e = next[0].to; path.add(e); next = R.movesAt(rep, e).filter(x => !path.has(x.to)); }
      const sans = [...line, ...seq.map(x => x.san)];
      const key = sans.join(' ');
      const name = [...seq].reverse().map(x => rep.positions[x.to]?.name).find(Boolean) || '';
      const text = lineText(seq.map(x => x.san), line.length);
      const hasKids = next.length > 0;
      const due = seq.filter(x => R.isDue(x)).length;
      const row = h('div.brow', { style: { paddingLeft: 12 + depth * 18 + 'px' }, onmouseenter: () => preview(sans) },
        hasKids ? h('button.twisty', { onclick: () => { collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key); render(); } }, collapsed.has(key) ? '▸' : '▾') : h('span.twisty'),
        h('a.bline', { href: `#/rep/${rep.id}/build/${encLine(sans)}` }, text),
        name && h('span.oname', name), due ? h('span.badge.need', `${due} due`) : null,
        seq.some(x => x.note) && h('span.muted', { title: seq.filter(x => x.note).map(x => `${x.san}: ${x.note}`).join('\n') }, icon('note', 12)),
        seq.some(x => x.disabled) && h('span.badge', 'disabled'));
      const kids = hasKids && !collapsed.has(key) ? branch(e, sans, path, depth + 1) : [];
      if (filter && !(text + ' ' + name).toLowerCase().includes(filter) && !kids.length) continue;
      frag.push(row, ...kids);
    }
    return frag;
  }
  function render() {
    const keepFocus = document.activeElement?.id === 'bfilter';
    side.innerHTML = '';
    const cnt = R.countMoves(rep);
    const root = h('div.view', h('h1', 'All lines'), h('p.sub', `${cnt.mine} of your moves, ${cnt.all - cnt.mine} opponent moves. Hover to preview, click a line to open it in the builder.`),
      h('input#bfilter.filter', { type: 'search', placeholder: 'Filter by move or opening name…', value: filter, oninput: e => { filter = e.target.value.toLowerCase(); render(); } }),
      h('div.browse', branch(START_EPD, [], new Set([START_EPD]), 0)));
    side.append(root);
    if (keepFocus) { const i = document.getElementById('bfilter'); i.focus(); i.setSelectionRange(filter.length, filter.length); }
  }
  render();
}

// ---------- import ----------
export function importView(ctx) {
  const rep = getRep(ctx.params.rep);
  if (!rep) { ctx.go('/'); return; }
  const side = ctx.side;
  ctx.setCrumbs([{ label: rep.name, href: `/rep/${rep.id}` }, { label: 'Import' }]);
  ctx.setLine(null);
  let busy = '', depth = 30;
  const done = res => {
    busy = '';
    toast(`Imported ${res.added} new move${res.added === 1 ? '' : 's'}${res.lines ? ` from ${res.lines} line${res.lines === 1 ? '' : 's'}` : ''}${res.skipped ? ` (${res.skipped} games from custom positions skipped)` : ''}`, 'ok', 5000);
    ctx.go(`/rep/${rep.id}`);
  };
  const run = async (label, fn) => { busy = label; render(); try { done(await fn()); } catch (e) { busy = ''; toast(e.message || String(e), 'err', 6000); render(); } };
  const doPgn = text => run('Importing PGN…', async () => { if (!text?.trim()) throw new Error('No PGN provided'); const r = R.importPgn(rep, text, { maxPly: depth }); if (!r.lines) throw new Error('No moves found in that PGN'); return r; });

  function render() {
    side.innerHTML = '';
    const pgnBox = h('textarea', { rows: 6, placeholder: '1. e4 e5 2. Nf3 (2. Bc4 Nf6) 2... Nc6 3. Bb5 *' });
    const study = h('input', { type: 'text', placeholder: 'https://lichess.org/study/…' });
    const lu = h('input', { type: 'text', placeholder: 'Lichess username', value: state.settings.lichessUser });
    const cu = h('input', { type: 'text', placeholder: 'Chess.com username', value: state.settings.chesscomUser });
    const root = h('div.view', h('h1', 'Choose an import source'),
      h('p.sub', `Moves are merged into ${rep.name}; nothing is overwritten. Variations and comments (as notes) are kept.`),
      busy && h('div.loading', h('span.spinner'), ' ', busy),
      h('div.set-row', h('span', 'Import depth'), h('span', h('input.num-input', { type: 'number', min: 2, max: 80, value: depth / 2, onchange: e => { depth = 2 * Math.max(1, +e.target.value || 15); } }), ' moves per side')),
      h('div.section-head', h('span', 'PGN')),
      h('div.form', pgnBox, h('div.form-row', h('button.btn.primary', { onclick: () => doPgn(pgnBox.value) }, 'Import pasted PGN'), h('button.btn', { onclick: async () => { const t = await pickFile('.pgn,.txt'); if (t) doPgn(t); } }, icon('upload', 14), ' Choose PGN file…'))),
      h('div.section-head', h('span', 'Lichess study')),
      h('div.form', study, h('div.form-row', h('button.btn.primary', { onclick: () => run('Downloading study…', async () => R.importPgn(rep, await studyPgn(study.value.trim()), { maxPly: depth })) }, 'Import study'))),
      h('div.section-head', h('span', `Your games (as ${rep.color === 'w' ? 'White' : 'Black'})`)),
      h('p.muted.small', 'Adds the opening moves you actually played in your most recent 100 games.'),
      h('div.form', h('div.form-row', lu, h('button.btn', { onclick: () => run('Downloading Lichess games…', async () => { const g = await lichessGames(lu.value.trim(), 100); return { added: R.importGames(rep, g, Math.min(depth, 20)) }; }) }, 'From Lichess')),
        h('div.form-row', cu, h('button.btn', { onclick: () => run('Downloading Chess.com games…', async () => { const g = await chesscomGames(cu.value.trim(), 100, parsePgnGames, mainline); return { added: R.importGames(rep, g, Math.min(depth, 20)) }; }) }, 'From Chess.com'))));
    side.append(root);
  }
  render();
}

// Opponent moves leading to positions rarer than the incidence threshold.
function trimCandidates(rep, an, s) {
  const out = [];
  const thr = 1 / s.incidenceN;
  for (const [epd, p] of Object.entries(rep.positions)) {
    if (R.isMine(rep, epd)) continue;
    for (const m of Object.values(p.moves)) { const inc = an.incidence.get(m.to); if (inc != null && inc < thr) out.push([epd, m.san]); }
  }
  return out;
}

export function repSettingsView(ctx) {
  const rep = getRep(ctx.params.rep);
  if (!rep) { ctx.go('/'); return; }
  const side = ctx.side;
  ctx.setCrumbs([{ label: rep.name, href: `/rep/${rep.id}` }, { label: 'Settings' }]);
  ctx.setLine(null);
  const KEYS = [['incidenceN', 'Cover positions seen in 1 in … games', 5, 5000, 25], ['coverageGoal', 'Coverage goal per position (%)', 10, 100, 5], ['minMoveFreq', 'Ignore opponent moves under (%)', 0, 50, 0.5], ['evalThreshold', 'Sound move threshold (centipawns)', 0, 300, 5]];
  function render() {
    side.innerHTML = '';
    const custom = Object.keys(rep.overrides || {}).length > 0;
    const s = repSettings(rep);
    const name = h('input', { type: 'text', value: rep.name, onchange: e => { rep.name = e.target.value.trim() || rep.name; save(); ctx.setCrumbs([{ label: rep.name, href: `/rep/${rep.id}` }, { label: 'Settings' }]); } });
    const root = h('div.view', h('h1', rep.name),
      h('div.set-row', h('span', 'Name'), name),
      h('div.set-row', h('span', 'Colour'), h('span', rep.color === 'w' ? 'White' : 'Black')),
      h('div.actions',
        h('a.action', { href: `#/rep/${rep.id}/import` }, h('span', icon('upload'), ' Import')),
        h('button.action', { onclick: () => download(rep.name.replace(/[^\w-]+/g, '_') + '.pgn', R.exportPgn(rep), 'application/x-chess-pgn') }, h('span', icon('download'), ' Export to PGN'))),
      h('div.section-head', h('span', 'Coverage for this repertoire')),
      h('label.set-row', h('span', 'Use custom settings (instead of the global ones)'), h('input', { type: 'checkbox', checked: custom, onchange: e => { rep.overrides = e.target.checked ? Object.fromEntries(KEYS.map(([k]) => [k, state.settings[k]])) : {}; R.touch(rep); render(); } })),
      KEYS.map(([k, label, min, max, step]) => h('div.set-row' + (custom ? '' : '.disabled'), h('span', label), h('input.num-input', { type: 'number', min, max, step, value: s[k], disabled: !custom, onchange: e => { const v = Math.max(min, Math.min(max, parseFloat(e.target.value))); if (!isNaN(v)) { rep.overrides[k] = v; R.touch(rep); } } }))),
      h('div.section-head', h('span', 'Danger zone')),
      h('div.actions',
        h('button.action', { onclick: async () => {
          let n = 0; for (const p of Object.values(rep.positions)) for (const m of Object.values(p.moves)) if (m.auto) n++;
          if (!n) return toast('There are no autofilled moves');
          if (!(await confirmDialog('Remove autofilled moves?', `${n} autofilled moves (and anything only reachable through them) will be removed.`, 'Remove', true))) return;
          for (const p of Object.values(rep.positions)) for (const m of Object.values(p.moves)) if (m.auto) delete p.moves[m.san];
          R.prune(rep); R.touch(rep); toast('Autofilled moves removed'); render();
        } }, h('span', icon('wand'), ' Remove autofilled moves')),
        h('button.action', { onclick: async () => {
          toast('Checking which lines are below your coverage goal…');
          const an = await R.analyze(rep, { prio: 2 });
          const list = trimCandidates(rep, an, repSettings(rep));
          if (!list.length) return toast('Nothing to trim — every line is within your goal', 'ok');
          const before = R.countMoves(rep).all;
          if (!(await confirmDialog('Trim moves past your goal?', `${list.length} rare branch${list.length === 1 ? '' : 'es'} occur less often than 1 in ${repSettings(rep).incidenceN} games. Trimming keeps only what you are likely to see.`, 'Trim rare lines', true))) return;
          for (const [epd, san] of list) delete rep.positions[epd]?.moves[san];
          R.prune(rep); R.touch(rep); toast(`Trimmed ${before - R.countMoves(rep).all} moves`, 'ok'); render();
        } }, h('span', icon('trash'), ' Trim unnecessary moves')),
        h('button.action', { onclick: async () => {
          if (!(await confirmDialog('Reset learning progress?', 'Every move in this repertoire goes back to unreviewed. The moves themselves are kept.', 'Reset', true))) return;
          for (const p of Object.values(rep.positions)) for (const m of Object.values(p.moves)) if (m.mine) m.srs = R.newCard();
          save(); toast('Learning progress reset');
        } }, h('span', icon('undo'), ' Reset learning progress')),
        h('button.action.danger', { onclick: async () => {
          if (!(await confirmDialog('Delete repertoire?', `"${rep.name}" and all of its ${R.countMoves(rep).all} moves will be permanently deleted.`, 'Delete', true))) return;
          state.repertoires = state.repertoires.filter(r => r !== rep); save(); ctx.go('/');
        } }, h('span', icon('trash'), ' Delete repertoire'))));
    side.append(root);
  }
  render();
}
