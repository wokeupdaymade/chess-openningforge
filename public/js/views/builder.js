// Repertoire builder: frequency-based coverage of opponent moves + evaluation-based recommendations for my moves.
import { state, save, getRep, repSettings } from '../store.js';
import { h, icon, toast, pct, oneIn, fmtCount, progressBar, resultBar, confirmDialog, promptDialog } from '../ui.js';
import { replay, moveLabel, START_EPD, START_FEN, epdOf } from '../chessutil.js';
import { moveTable, rankCandidates, sortCandidates } from '../posinfo.js';
import { explorer, fmtEval, openingNames } from '../api.js';
import * as R from '../repertoire.js';
import { encLine, decLine } from '../app.js';

export function builderView(ctx) {
  const rep = getRep(ctx.params.rep);
  if (!rep) { ctx.go('/'); return; }
  const S = () => repSettings(rep);
  const me = rep.color;
  let steps = replay(decLine(ctx.params.line));
  let line = steps.map(x => x.san);
  let cur = line.length;
  let table = null, unsub = null;
  let an = R.cachedAnalysis(rep), anProgress = null;
  let lineInc = null;
  let showAll = false, hover = null, showSettings = false, alive = true, raf = 0;
  const side = ctx.side;

  ctx.board.orientation = me === 'w' ? 'white' : 'black';
  ctx.setCrumbs([{ label: rep.name, href: `/rep/${rep.id}` }, { label: 'Build' }]);

  const curFen = () => (cur ? steps[cur - 1].fenAfter : START_FEN);
  const curEpd = () => epdOf(curFen());
  const myTurn = () => curFen().split(' ')[1] === me;
  const savedFlags = () => steps.map(st => !!rep.positions[st.epdBefore]?.moves[st.san]);
  // unsaved moves that "Save" would add (up to my last move in the visible line)
  function pending() {
    let end = cur; while (end > 0 && steps[end - 1].color !== me) end--;
    const flags = savedFlags(); let n = 0;
    for (let i = 0; i < end; i++) if (!flags[i]) n++;
    return n;
  }
  function openingName() {
    for (let i = cur; i >= 0; i--) {
      const e = i ? steps[i - 1].epdAfter : START_EPD;
      const n = openingNames.get(e) || rep.positions[e]?.name;
      if (n) return n;
    }
    return '';
  }
  const setSetting = (k, v) => {
    if (k in (rep.overrides || {})) rep.overrides[k] = v; else state.settings[k] = v;
    save(); R.invalidateAnalysis(); an = null; setPos(); refreshAnalysis();
  };

  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (alive) render(); }); }

  async function refreshAnalysis() {
    try {
      const res = await R.analyze(rep, { prio: -5, onProgress: p => { anProgress = p; schedule(); } });
      if (!alive) return;
      an = res; anProgress = null; schedule();
    } catch (e) { console.warn(e); }
  }

  async function computeLineInc() {
    const myLine = line.slice(0, cur).join(' ');
    let inc = 1;
    for (let i = 0; i < cur; i++) {
      if (steps[i].color === me) continue;
      const st = await explorer(steps[i].fenBefore, { prio: 8, settings: S() });
      if (!alive || myLine !== line.slice(0, cur).join(' ')) return;
      const m = st?.moves.find(x => x.san === steps[i].san);
      inc *= st?.total ? (m ? m.total / st.total : 0.5 / st.total) : 1;
    }
    lineInc = inc; schedule();
  }

  function setPos({ animate = true } = {}) {
    const fen = curFen();
    ctx.silent(`/rep/${rep.id}/build/${encLine(line.slice(0, cur))}`);
    unsub?.(); hover = null; showAll = false; lineInc = an?.incidence.get(curEpd()) ?? null;
    const p = rep.positions[curEpd()];
    table = moveTable(fen, { prio: 10, settings: S(), evals: myTurn(), extraSans: Object.keys(p?.moves || {}) });
    const t = table, fn = () => { if (t === table) schedule(); };
    t.listeners.add(fn); unsub = () => t.listeners.delete(fn);
    ctx.board.set({ fen, lastMove: cur ? [steps[cur - 1].from, steps[cur - 1].to] : null, interactive: 'both', animate });
    computeLineInc();
    render();
  }

  function jump(i) { cur = Math.max(0, Math.min(line.length, i)); setPos(); }
  function goLine(sans) { steps = replay(sans); line = steps.map(x => x.san); cur = line.length; setPos(); }
  function play(san) {
    if (line[cur] !== san) { steps = replay([...line.slice(0, cur), san]); line = steps.map(x => x.san); }
    if (steps.length <= cur) return; // illegal
    cur++;
    if (S().autoSave && steps[cur - 1].color === me) saveLine(true);
    setPos();
  }
  ctx.board.onMove = m => play(m.san);

  function saveLine(quiet = false) {
    const sans = line.slice(0, cur);
    const added = R.addLine(rep, sans);
    // remember opening names and a quality snapshot for my moves
    for (let i = 0; i < Math.min(cur, steps.length); i++) {
      const st = steps[i];
      const n = openingNames.get(st.epdAfter); if (n && rep.positions[st.epdAfter]) rep.positions[st.epdAfter].name = n;
      if (st.color === me) snapshotQuality(st);
    }
    save();
    if (!quiet) toast(added ? `Saved ${added} move${added === 1 ? '' : 's'} to ${rep.name}` : 'Line saved', 'ok');
    refreshAnalysis(); schedule();
  }
  function snapshotQuality(st) {
    const mv = rep.positions[st.epdBefore]?.moves[st.san]; if (!mv || mv.q) return;
    const t = moveTable(st.fenBefore, { prio: 1, settings: S(), evals: true, extraSans: [st.san] });
    t.done.then(() => { const r = t.rows.find(x => x.san === st.san); if (r) { mv.q = { loss: r.loss, win: r.win, share: r.share }; save(); } });
  }
  function discard() {
    const flags = savedFlags(); let i = 0; while (i < flags.length && flags[i]) i++;
    goLine(line.slice(0, i));
  }

  async function nextGap(fromHere = false) {
    if (!an) { toast('Analysing coverage…'); await refreshAnalysis(); }
    if (!an) return;
    const here = curEpd();
    const g = fromHere ? an.gaps.find(x => x.path.includes(here) && x.epd !== here) : an.gaps.find(x => x.epd !== here) || an.gaps[0];
    if (!g) { toast(fromHere ? 'No gaps below this position' : 'No gaps left at your current coverage settings 🎉', 'ok'); return; }
    goLine(g.line);
  }

  async function removeMove(epd, san) {
    const n = R.subtreeSize(rep, epd, san);
    if (n > 1 && !(await confirmDialog('Remove move?', `Removing ${san} also removes ${n - 1} move${n - 1 === 1 ? '' : 's'} that are only reachable through it.`, 'Remove', true))) return;
    R.removeMove(rep, epd, san);
    toast(`Removed ${n} move${n === 1 ? '' : 's'}`);
    refreshAnalysis(); setPos({ animate: false });
  }
  async function editNote(epd, san) {
    const mv = rep.positions[epd]?.moves[san]; if (!mv) return;
    const v = await promptDialog(`Note for ${san}`, { value: mv.note || '', multiline: true, placeholder: 'Why this move? Plans, traps, ideas…' });
    if (v == null) return;
    mv.note = v.trim() || undefined; R.touch(rep); render();
  }
  function toggleExclude(san) {
    const p = R.pos(rep, curEpd(), true);
    p.excluded = p.excluded || [];
    if (p.excluded.includes(san)) p.excluded = p.excluded.filter(x => x !== san); else p.excluded.push(san);
    if (!p.excluded.length) delete p.excluded;
    R.touch(rep); refreshAnalysis(); render();
  }

  // ---------- rendering ----------
  function evalBadge(c) {
    if (c.eval == null) return h('span.eval.none', c.evalPending ? h('span.spinner') : '—');
    const white = me === 'w' ? c.eval : -c.eval; // show from White's point of view, like every chess UI
    return h('span.eval' + (white >= 0 ? '.pos' : '.neg'), { title: `${c.evalSource === 'engine' ? 'Local Stockfish' : 'Lichess cloud'} · depth ${c.depth ?? '?'}${c.loss ? ` · ${(c.loss / 100).toFixed(2)} worse than the best move` : ''}` }, fmtEval(white), c.evalSource === 'engine' && h('sup', '•'));
  }

  function savedActions(epd, mv) {
    return h('div.row-actions', { onclick: e => e.stopPropagation() },
      h('button.mini', { onclick: () => removeMove(epd, mv.san) }, icon('trash', 13), ' Remove'),
      mv.mine && h('button.mini', { onclick: () => { mv.disabled = !mv.disabled || undefined; R.touch(rep); refreshAnalysis(); render(); } }, icon(mv.disabled ? 'play' : 'pause', 13), mv.disabled ? ' Enable' : ' Disable'),
      h('button.mini', { onclick: () => editNote(epd, mv.san) }, icon('note', 13), mv.note ? ' Edit note' : ' Add note'));
  }

  function renderMine(root) {
    const s = S(), epd = curEpd(), ply = cur;
    const p = rep.positions[epd];
    const savedMoves = p ? Object.values(p.moves) : [];
    const ranked = table ? rankCandidates(table, s) : [];
    let list = sortCandidates(ranked, s.candidateSort);
    const savedSet = new Set(savedMoves.map(m => m.san));
    const title = savedMoves.length ? 'Your move in this position' : cur === 0 ? 'Choose your first move' : `Choose a response to ${moveLabel(cur - 1, line[cur - 1])}`;
    root.append(h('h1', title));
    root.append(h('p.sub', lineInc != null && cur > 0 ? `You reach this position in about ${oneIn(lineInc)} games. ` : '',
      savedMoves.length ? 'You can add an alternative, or continue down the line.' : 'Moves within your evaluation threshold are marked as sound; pick one from the list or play it on the board.'));

    const controls = h('div.controls',
      h('label', 'Sort ', h('select', { onchange: e => { state.settings.candidateSort = e.target.value; save(); render(); } },
        [['smart', 'Recommended'], ['popularity', 'Popularity (peers)'], ['masters', 'Popularity (masters)'], ['eval', 'Evaluation'], ['winrate', 'Win rate']].map(([v, l]) => h('option', { value: v, selected: s.candidateSort === v }, l)))),
      h('label', { title: 'A move is "sound" when it is at most this many centipawns worse than the best move.' }, 'Sound within ', numInput(s.evalThreshold, 0, 300, 5, v => setSetting('evalThreshold', v)), ' cp'),
      h('label.check', h('input', { type: 'checkbox', checked: s.hideWeakMoves, onchange: e => { state.settings.hideWeakMoves = e.target.checked; save(); render(); } }), ' hide unsound'));
    root.append(controls);

    const head = h('div.trow.thead', h('span', savedMoves.length ? 'Moves' : 'Candidate moves'), h('span'), h('span.c', { title: 'Share of master games' }, 'Masters'), h('span.c', 'Eval'), h('span.c', { title: 'Results in games between players around your rating' }, 'Peer results'));
    const tbl = h('div.table.mine', head);
    const mkRow = c => {
      const mv = p?.moves[c.san];
      const cls = (mv ? '.saved' : '') + (mv?.disabled ? '.disabled' : '') + (c.acceptable === false ? '.weak' : '') + (c.acceptable ? '.sound' : '');
      return h('div.trow.clickable' + cls, {
        onclick: () => play(c.san), onmouseenter: () => { hover = c; shapes(); }, onmouseleave: () => { hover = null; shapes(); },
      },
        h('span.mv-cell', h('span.mv-num', moveLabel(ply, '').trim()), h('b', c.san), c.glyph && h('span.glyph', c.glyph)),
        h('span.name-cell',
          h('span.oname', c.opening?.name || ''),
          mv && h('span.badge.ok', icon('check', 11), mv.disabled ? ' disabled' : ' in repertoire'),
          c.recommended && h('span.badge.rec', { title: 'Best blend of soundness, results at your level and popularity among the sound moves' }, icon('star', 11), ' recommended'),
          c.best && !c.recommended && h('span.badge.best', 'engine best'),
          c.acceptable && !c.best && !c.recommended && h('span.badge.sound', 'sound'),
          c.acceptable === false && h('span.badge.weak', `−${(c.loss / 100).toFixed(1)}`),
          mv?.auto && h('span.badge', 'autofilled'),
          mv?.note && h('div.note', mv.note),
          mv && savedActions(epd, mv)),
        h('span.c.num', c.mastersShare ? pct(c.mastersShare) : table?.masters ? '·' : ''),
        h('span.c', evalBadge(c)),
        h('span.peer', c.peer ? [resultBar(c.peer), h('span.games', `${pct(c.share)} · ${fmtCount(c.peer.total)}`)] : h('span.games', table?.peer ? 'no games' : '')));
    };
    const saved = list.filter(c => savedSet.has(c.san));
    let others = list.filter(c => !savedSet.has(c.san));
    if (s.hideWeakMoves) others = others.filter(c => c.acceptable !== false);
    saved.forEach(c => tbl.append(mkRow(c)));
    if (saved.length && others.length) tbl.append(h('div.trow.divider', 'Alternatives'));
    const limit = showAll ? others.length : saved.length ? 5 : 8;
    others.slice(0, limit).forEach(c => tbl.append(mkRow(c)));
    root.append(tbl);
    if (!table || (table.peer === undefined && !ranked.length)) root.append(h('div.loading', h('span.spinner'), ' Loading moves…'));
    else if (!ranked.length) root.append(h('p.muted.pad', 'No statistics for this position. Play any legal move on the board.'));
    const foot = h('div.table-foot');
    if (others.length > limit) foot.append(h('button.linkbtn', { onclick: () => { showAll = true; render(); } }, `Show ${others.length - limit} more`));
    if (table?.evalInfo) foot.append(h('span.muted', table.evalInfo.source === 'engine' ? `Evals: local Stockfish, depth ${table.evalInfo.depth}` : `Evals: Lichess cloud, depth ${table.evalInfo.depth}`));
    else if (table?.engineWorking) foot.append(h('span.muted', h('span.spinner'), ' no cloud eval — running local Stockfish…'));
    else if (table && !table.loading && table.bestEval == null) foot.append(h('span.muted', 'No evaluation available for this position'));
    root.append(foot);
  }

  function renderOpp(root) {
    const s = S(), epd = curEpd(), ply = cur;
    const p = rep.positions[epd];
    const stats = table?.peer;
    root.append(h('h1', 'Choose a move to prepare for'));
    const req = stats ? R.requiredMoves(stats, p, s) : null;
    const inc = lineInc;
    if (req && stats.total) {
      const needed = req.rows.filter(r => r.status === 'needed');
      const below = inc != null && inc < 1 / s.incidenceN;
      root.append(h('div.coverage-box',
        h('div.cov-head', h('b', `${pct(req.covered)} of replies covered`), h('span.muted', `goal ${s.coverageGoal}%`)),
        progressBar(req.covered, { goal: s.coverageGoal / 100, cls: req.goalMet ? 'ok' : 'warn' }),
        h('div.cov-note', req.goalMet ? [icon('check', 13), ' Coverage goal reached for this position.']
          : below ? `This position is rarer than 1 in ${s.incidenceN} games, so nothing here is required.`
            : `Prepare ${needed.map(r => r.san).join(', ')} to reach your goal.`),
        h('div.controls',
          h('label', { title: 'Share of the opponent\'s replies you want an answer for, in every position' }, 'Coverage goal ', numInput(s.coverageGoal, 10, 100, 5, v => setSetting('coverageGoal', v)), ' %'),
          h('label', { title: 'Opponent moves played less often than this are never required' }, 'Ignore moves under ', numInput(s.minMoveFreq, 0, 50, 0.5, v => setSetting('minMoveFreq', v)), ' %'),
          h('label', { title: 'Only positions that occur at least this often in your games count as gaps' }, 'Positions seen 1 in ', numInput(s.incidenceN, 5, 5000, 25, v => setSetting('incidenceN', v)), ' games'))));
    } else if (inc != null) root.append(h('p.sub', `This position occurs in about ${oneIn(inc)} of your games.`));

    const tbl = h('div.table.opp', h('div.trow.thead', h('span', "Opponent's move"), h('span'), h('span.c', { title: 'How often this move is played from this position by players around your rating' }, 'Frequency'), h('span.c', { title: 'How often the resulting position shows up in your games overall' }, 'Expected in'), h('span.c', 'Status')));
    let rows = req?.rows || [];
    // moves saved in the repertoire that the explorer does not list
    for (const mv of Object.values(p?.moves || {})) if (!rows.some(r => r.san === mv.san)) rows = [...rows, { san: mv.san, freq: 0, share: 0, status: 'covered', have: true, stats: null }];
    const limit = showAll ? rows.length : Math.max(6, rows.filter(r => r.status === 'needed' || r.have).length + 2);
    const statusChip = r => {
      if (r.status === 'covered') {
        const child = p.moves[r.san].to;
        const hasReply = R.myMovesAt(rep, child).length > 0;
        const comp = an ? R.subCompletion(an, child) : null;
        if (!hasReply) return h('span.badge.need', 'no reply yet');
        return h('span.status-cov', { title: comp != null ? `${pct(comp)} of games through this move stay inside your preparation` : '' }, h('span.badge.ok', icon('check', 11), ' covered'), comp != null && progressBar(comp, { cls: comp > 0.999 ? 'ok tiny' : 'warn tiny' }));
      }
      if (r.status === 'needed') return h('span.badge.need', { title: 'Needed to reach your coverage goal' }, 'prepare');
      if (r.status === 'optional') return h('span.badge', { title: 'Goal already reached without this move' }, 'optional');
      if (r.status === 'rare') return h('span.badge', { title: `Played in under ${s.minMoveFreq}% of games here` }, 'rare');
      return h('span.badge', 'excluded');
    };
    rows.slice(0, limit).forEach(r => {
      const mv = p?.moves[r.san];
      tbl.append(h('div.trow.clickable.' + r.status, {
        onclick: () => play(r.san), onmouseenter: () => { hover = { row: table.rows.find(x => x.san === r.san) }; shapes(); }, onmouseleave: () => { hover = null; shapes(); },
      },
        h('span.mv-cell', h('span.mv-num', moveLabel(ply, '').trim()), h('b', r.san)),
        h('span.name-cell', h('span.oname', r.opening?.name || ''),
          mv?.note && h('div.note', mv.note),
          h('div.row-actions', { onclick: e => e.stopPropagation() },
            mv && h('button.mini', { onclick: () => removeMove(epd, r.san) }, icon('trash', 13), ' Remove'),
            mv && h('button.mini', { onclick: () => editNote(epd, r.san) }, icon('note', 13), mv.note ? ' Edit note' : ' Add note'),
            !mv && h('button.mini', { onclick: () => toggleExclude(r.san), title: 'Never ask me to prepare for this move' }, icon(r.status === 'excluded' ? 'undo' : 'ban', 13), r.status === 'excluded' ? ' Include again' : ' Exclude'))),
        h('span.freq', h('div.fbar', h('div', { style: { width: Math.min(100, r.freq * 100) + '%' } })), h('span.num', r.freq ? (r.freq < 0.01 ? '<1%' : pct(r.freq)) : '—')),
        h('span.c.num', inc != null && r.freq ? oneIn(inc * r.freq) : '—'),
        h('span.c', statusChip(r))));
    });
    root.append(tbl);
    if (stats === undefined) root.append(h('div.loading', h('span.spinner'), ' Loading opponent moves from Lichess…'));
    else if (stats === null) root.append(h('p.warn.pad', 'Could not load Lichess statistics for this position. Check your connection (and Lichess token in Settings).'));
    else if (!stats.total) root.append(h('p.muted.pad', 'No games in the database reach this position at your level.'));
    else if (stats.total < s.minGames) root.append(h('p.muted.pad', `Only ${stats.total} games reach this position — too few for reliable statistics, so nothing here is required.`));
    if (rows.length > limit) root.append(h('div.table-foot', h('button.linkbtn', { onclick: () => { showAll = true; render(); } }, `Show ${rows.length - limit} more`)));
  }

  function numInput(value, min, max, step, onchange) {
    return h('input.num-input', { type: 'number', value, min, max, step, onchange: e => { const v = Math.max(min, Math.min(max, parseFloat(e.target.value))); if (!isNaN(v)) onchange(v); } });
  }

  function shapes() {
    if (!table) return;
    const out = []; const p = rep.positions[curEpd()];
    const find = san => table.rows.find(r => r.san === san);
    if (myTurn()) {
      for (const mv of Object.values(p?.moves || {})) { const r = find(mv.san); if (r) out.push({ from: r.from, to: r.to, brush: mv.disabled ? 'paleGrey' : 'green' }); }
      if (!out.length) { const rec = rankCandidates(table, S()).find(c => c.recommended); if (rec) out.push({ from: rec.from, to: rec.to, brush: 'paleBlue' }); }
    } else if (table.peer) {
      const req = R.requiredMoves(table.peer, p, S());
      for (const r of req.rows.slice(0, 8)) {
        const x = find(r.san); if (!x) continue;
        if (r.status === 'covered') out.push({ from: x.from, to: x.to, brush: 'green' });
        else if (r.status === 'needed') out.push({ from: x.from, to: x.to, brush: 'red' });
      }
    }
    if (hover?.row) out.push({ from: hover.row.from, to: hover.row.to, brush: 'yellow' });
    ctx.board.setShapes(out);
  }

  function render() {
    const flags = savedFlags();
    ctx.setLine({ opening: openingName(), sans: line, cur, saved: flags, onJump: jump, fen: curFen() });
    shapes();
    const keep = side.scrollTop;
    side.innerHTML = '';
    const root = h('div.view.builder');
    // repertoire completion + gap navigation
    const comp = an ? an.completion : null;
    const hereGap = an?.gaps.find(x => x.path.includes(curEpd()) && x.epd !== curEpd());
    root.append(h('div.build-top',
      h('div.comp', h('div.comp-head', h('b', comp != null ? `${pct(comp)} complete` : 'Analysing coverage…'), an && h('span.muted', an.gaps.length ? `${an.gaps.length} gap${an.gaps.length === 1 ? '' : 's'} left` : 'no gaps'), !an && anProgress && h('span.muted', `${anProgress.visited} positions`)),
        progressBar(comp ?? 0, { cls: comp > 0.999 ? 'ok' : '' })),
      h('a.linkbtn', { href: `#/rep/${rep.id}/autofill/${encLine(line.slice(0, cur))}`, title: 'Let the app fill gaps with recommended moves' }, icon('wand', 14), ' Autofill')));

    const n = pending();
    if (n) root.append(h('div.pending', h('div', h('b', `${n} unsaved move${n === 1 ? '' : 's'}`), h('span.muted', ' in this line')),
      h('div.pending-actions', h('button.btn', { onclick: discard }, 'Discard'), h('button.btn.primary', { onclick: () => saveLine() }, icon('check', 14), ` Save line`, h('kbd', 'Enter')))));

    if (myTurn()) renderMine(root); else renderOpp(root);

    const acts = h('div.actions');
    if (an?.gaps.length) {
      const g = an.gaps.find(x => x.epd !== curEpd()) || an.gaps[0];
      acts.append(h('button.action', { onclick: () => nextGap(false) }, h('span', icon('target'), ' Go to your biggest gap'), h('span.muted', `${oneIn(g.incidence)} games · `, h('kbd', 'G'))));
      if (hereGap && hereGap !== g) acts.append(h('button.action', { onclick: () => nextGap(true) }, h('span', icon('down'), ' Biggest gap below this position'), h('span.muted', `${oneIn(hereGap.incidence)} games`)));
    } else if (an && !n) acts.append(h('div.action.static', h('span', icon('check'), ' No gaps at your current coverage settings'), h('a.linkbtn', { href: `#/rep/${rep.id}/practice` }, 'Practice')));
    if (R.movesAt(rep, curEpd()).length) acts.append(h('a.action', { href: `#/rep/${rep.id}/practice/${encLine(line.slice(0, cur))}?mode=all` }, h('span', icon('play'), ' Practice moves from this position')));
    acts.append(h('button.action.subtle', { onclick: () => { showSettings = !showSettings; render(); } }, h('span', icon('gear'), ' Coverage & recommendation settings'), icon(showSettings ? 'x' : 'down')));
    root.append(acts);
    if (showSettings) {
      const s = S();
      root.append(h('div.inline-settings',
        setRow('Cover positions seen in at least', h('span', '1 in ', numInput(s.incidenceN, 5, 5000, 25, v => setSetting('incidenceN', v)), ' games')),
        setRow('Coverage goal per position', h('span', numInput(s.coverageGoal, 10, 100, 5, v => setSetting('coverageGoal', v)), ' % of opponent replies')),
        setRow('Ignore opponent moves played less than', h('span', numInput(s.minMoveFreq, 0, 50, 0.5, v => setSetting('minMoveFreq', v)), ' % of the time')),
        setRow('Sound move = within', h('span', numInput(s.evalThreshold, 0, 300, 5, v => setSetting('evalThreshold', v)), ' centipawns of the best move')),
        setRow('Save moves as soon as I play them', h('input', { type: 'checkbox', checked: s.autoSave, onchange: e => { state.settings.autoSave = e.target.checked; save(); render(); } })),
        h('p.muted', 'Opponent statistics: Lichess games, ratings ', (S().ratingBuckets?.length ? S().ratingBuckets.join(', ') : 'around ' + S().rating), ' · ', S().speeds.join(', '), '. ', h('a', { href: '#/settings' }, 'Change in Settings'))));
    }
    side.append(root);
    side.scrollTop = keep;
  }
  const setRow = (label, control) => h('div.set-row', h('span', label), control);

  ctx.onKey = e => {
    if (e.key === 'Enter') { if (pending()) saveLine(); else nextGap(false); return true; }
    if (e.key === 'g' || e.key === 'G') { nextGap(false); return true; }
    return false;
  };

  setPos({ animate: false });
  refreshAnalysis();
  if (ctx.params.gap) nextGap(false);
  return () => { alive = false; unsub?.(); cancelAnimationFrame(raf); };
}
