// Spaced-repetition practice: plays through repertoire lines and quizzes my moves.
import { state, save, getRep, recordPractice } from '../store.js';
import { h, icon, sfx, pct, relTime } from '../ui.js';
import { replay, moveLabel, START_FEN } from '../chessutil.js';
import * as R from '../repertoire.js';
import { decLine } from '../app.js';
import { openingNames } from '../api.js';

export function practiceView(ctx) {
  const reps = ctx.params.rep ? [getRep(ctx.params.rep)].filter(Boolean) : state.repertoires;
  if (!reps.length) { ctx.go('/'); return; }
  const fromLine = decLine(ctx.params.line);
  const mode = ctx.params.mode === 'all' ? 'all' : 'due';
  const batch = ctx.params.batch ? state.settings.dailyGoal : Infinity;
  const pm = state.settings.practiceMode;
  const side = ctx.side;
  let alive = true, timer = null;
  const later = (fn, ms) => { clearTimeout(timer); timer = setTimeout(() => { if (alive) fn(); }, ms); };

  // ----- build the session -----
  let queue = []; let remaining = batch;
  for (const rep of reps) {
    if (remaining <= 0) break;
    const ls = R.practiceLines(rep, { dueOnly: mode === 'due', fromLine, limit: remaining });
    for (const l of ls) {
      const steps = replay(l.sans);
      let quiz = l.quiz;
      if (pm !== 'moves') { // quiz every one of my moves on the way
        quiz = new Set(l.quiz);
        steps.forEach((st, i) => { if (st.color === rep.color && i >= fromLine.length) quiz.add(i); });
      }
      queue.push({ rep, steps, quiz, graded: l.quiz });
      remaining -= l.quiz.size;
    }
  }
  if (pm === 'linesOnce') { // each move asked at most once per session
    const seen = new Set();
    for (const item of queue) { const q = new Set(); for (const i of item.quiz) { const k = item.steps[i].epdBefore + '|' + item.steps[i].san; if (!seen.has(k)) { seen.add(k); q.add(i); } } item.quiz = q; }
    queue = queue.filter(x => x.quiz.size);
  }
  const totalCards = queue.reduce((a, x) => a + x.quiz.size, 0);
  let left = totalCards, right = 0, wrong = 0;
  let qi = -1, item = null, ply = 0, failed = false, hintLevel = 0, phase = 'idle', feedback = '', wrongSan = '';

  ctx.setCrumbs(reps.length === 1 ? [{ label: reps[0].name, href: `/rep/${reps[0].id}` }, { label: 'Practice' }] : [{ label: 'Practice' }]);

  function nextItem() {
    qi++;
    if (qi >= queue.length) return finish();
    item = queue[qi];
    ctx.board.orientation = item.rep.color === 'w' ? 'white' : 'black';
    const first = Math.min(...item.quiz);
    // start just before the opponent move that leads to the first question
    ply = Math.max(0, first - 1);
    if (ply > 0 && item.steps[ply].color === item.rep.color) ply = first;
    showPos(false);
    later(advance, 350);
  }
  function fenAt(i) { return i ? item.steps[i - 1].fenAfter : START_FEN; }
  function showPos(animate = true, interactive = false) {
    const st = ply ? item.steps[ply - 1] : null;
    ctx.board.set({ fen: fenAt(ply), lastMove: st ? [st.from, st.to] : null, interactive: interactive ? (item.rep.color === 'w' ? 'white' : 'black') : false, animate });
    updateLine();
  }
  function updateLine() {
    const sans = item.steps.slice(0, ply).map(s => s.san);
    let name = '';
    for (let i = ply; i >= 0 && !name; i--) { const e = i ? item.steps[i - 1].epdAfter : null; if (e) name = openingNames.get(e) || item.rep.positions[e]?.name || ''; }
    ctx.setLine({ opening: name, sans, cur: sans.length, fen: fenAt(ply) });
  }
  function advance() {
    if (ply >= item.steps.length) return nextItem();
    const st = item.steps[ply];
    if (st.color !== item.rep.color || !item.quiz.has(ply)) {
      // opponent move, or one of my moves that is not being asked: play it automatically
      ctx.board.set({ fen: st.fenBefore, lastMove: ply ? [item.steps[ply - 1].from, item.steps[ply - 1].to] : null, interactive: false, animate: false });
      ctx.board.playSan(st.san);
      ply++; updateLine();
      if (ply >= item.steps.length) return later(nextItem, 500);
      return later(advance, st.color === item.rep.color ? 250 : 380);
    }
    // question
    failed = false; hintLevel = 0; phase = 'ask'; feedback = ''; wrongSan = '';
    showPos(true, true);
    render();
  }
  const card = () => item.rep.positions[item.steps[ply].epdBefore]?.moves[item.steps[ply].san];

  function markFail() {
    if (failed) return;
    failed = true;
    if (!item.retry) {
      wrong++;
      const c = card();
      if (c) { R.grade(c, false); recordPractice(false); save(); }
    }
    // ask again at the end of the session
    queue.push({ rep: item.rep, steps: item.steps.slice(0, ply + 1), quiz: new Set([ply]), graded: new Set(), retry: true });
  }

  ctx.board.onMove = m => {
    if (phase !== 'ask') return;
    const st = item.steps[ply];
    if (m.san === st.san) {
      sfx.good();
      const c = card();
      if (!failed) {
        if (!item.retry) { right++; left--; recordPractice(true); if (c && (item.graded.has(ply) || R.isDue(c))) R.grade(c, true); save(); }
      } else if (!item.retry) left--;
      phase = 'answered'; feedback = failed ? 'shown' : 'correct';
      ply++; updateLine();
      const pa = state.settings.pauseAfter;
      const pause = pa === 'always' || (pa === 'wrong' && failed) || (pa === 'note' && c?.note) || (c?.note && failed);
      render(c);
      if (!pause) later(advance, 450);
      return;
    }
    const alts = R.myMovesAt(item.rep, st.epdBefore).map(x => x.san);
    if (alts.includes(m.san)) {
      feedback = 'alt'; wrongSan = m.san;
      later(() => { showPos(false, true); }, 500); render();
      return;
    }
    sfx.bad(); markFail(); feedback = 'wrong'; wrongSan = m.san;
    render();
    later(() => { showPos(false, true); showHintShapes(); }, 650);
  };

  function showHintShapes() {
    if (phase !== 'ask') return;
    const st = item.steps[ply];
    if (hintLevel === 1) ctx.board.setShapes([{ from: st.from, to: undefined, brush: 'blue' }]);
    else if (hintLevel >= 2) ctx.board.setShapes([{ from: st.from, to: st.to, brush: 'green' }]);
  }
  function hint() {
    if (phase !== 'ask') return;
    hintLevel++;
    if (hintLevel >= 2) markFail();
    showHintShapes(); render();
  }

  function finish() {
    phase = 'done'; sfx.done();
    ctx.board.set({ fen: ctx.board.chess.fen(), interactive: false });
    render();
  }

  function render(answeredCard) {
    side.innerHTML = '';
    const root = h('div.view.practice');
    if (!totalCards) {
      const next = Math.min(...reps.map(r => R.learnStats(r).nextDue));
      root.append(h('h1', 'Nothing to practice'),
        h('p.sub', mode === 'due' ? (isFinite(next) ? `You are all caught up. Your next review is due in ${relTime(next)}.` : 'There are no saved moves here yet.') : 'There are no saved moves from this position.'),
        h('div.actions', mode === 'due' && isFinite(next) && h('a.action', { href: location.hash.split('?')[0] + '?mode=all' }, h('span', icon('play'), ' Practice all moves anyway')),
          h('button.action', { onclick: () => ctx.back() }, h('span', icon('back'), ' Back'))));
      side.append(root); return;
    }
    if (phase === 'done') {
      const answered = right + wrong;
      const ls = reps.map(r => R.learnStats(r));
      const tot = ls.reduce((a, x) => a + x.total, 0);
      const mast = tot ? ls.reduce((a, x) => a + x.mastery * x.total, 0) / tot : 0;
      const dueNow = ls.reduce((a, x) => a + x.due, 0);
      const next = Math.min(...ls.map(x => x.nextDue));
      root.append(h('h1', 'Practice complete!'),
        h('div.bigstat', h('b', pct(mast, 1)), ' mastered'),
        h('ul.summary',
          h('li', `You practiced ${answered} move${answered === 1 ? '' : 's'}`),
          h('li', `You played the correct move ${right} time${right === 1 ? '' : 's'} (${answered ? Math.round(100 * right / answered) : 0}%)`),
          h('li', dueNow ? `${dueNow} more move${dueNow === 1 ? ' is' : 's are'} due now` : isFinite(next) ? `Your next practice is due in ${relTime(next)}` : '')),
        h('div.actions',
          dueNow > 0 && h('button.action.primary', { onclick: () => ctx.go(location.hash.slice(1), true) }, h('span', icon('play'), ' Keep practicing'), h('span.muted', `${dueNow} due`)),
          h('button.action', { onclick: () => ctx.go(reps.length === 1 ? `/rep/${reps[0].id}` : '/') }, h('span', icon('check'), ' Continue'))));
      side.append(root); return;
    }
    root.append(h('div.practice-head', h('h1', 'Practicing moves'),
      h('div.counters', h('span.cnt.due', { title: 'Still to go' }, left, icon('clock')), h('span.cnt.ok', { title: 'Correct' }, right, icon('check')), h('span.cnt.bad', { title: 'Missed' }, wrong, icon('x')))));
    if (!item) { side.append(root); return; }
    if (phase === 'ask') {
      const st = item.steps[ply];
      root.append(h('p.sub', feedback === 'wrong' ? h('span.bad', `${wrongSan} is not in your repertoire. Try again.`)
        : feedback === 'alt' ? `${wrongSan} is also in your repertoire, but this line continues with a different move.`
          : ply === 0 ? 'Play your first move on the board.' : 'Play the correct move on the board.'));
      const c = card();
      root.append(h('div.prompt', h('span.mv-num', moveLabel(ply, '').trim()), h('b', hintLevel >= 2 ? st.san : '＿'), hintLevel >= 1 && c?.note && h('span.note', c.note)));
      root.append(h('div.actions', h('button.action', { onclick: hint }, h('span', hintLevel === 0 ? "I don't know, give me a hint" : hintLevel === 1 ? "I don't know, show me the answer" : 'Play the move shown on the board'), h('kbd', 'H'))));
    } else if (phase === 'answered') {
      const st = item.steps[ply - 1];
      root.append(h('p.sub', feedback === 'correct' ? h('span.ok', 'Correct!') : 'This is your saved move.'));
      root.append(h('div.prompt', h('span.mv-num', moveLabel(ply - 1, '').trim()), h('b', st.san), answeredCard?.note && h('span.note', answeredCard.note)));
      root.append(h('div.actions', h('button.action.primary', { onclick: () => { clearTimeout(timer); advance(); } }, h('span', 'Got it, continue practicing'), h('kbd', 'Space'))));
    }
    if (item.retry) root.append(h('p.muted.pad', 'Second try for a move you missed earlier.'));
    root.append(h('div.session-bar', h('div.pbar', h('div.pbar-fill', { style: { width: (totalCards ? 100 * (totalCards - left) / totalCards : 0) + '%' } }))));
    side.append(root);
  }

  ctx.onKey = e => {
    if (e.key === 'h' || e.key === 'H') { hint(); return true; }
    if ((e.key === ' ' || e.key === 'Enter') && phase === 'answered') { clearTimeout(timer); advance(); return true; }
    return false;
  };

  render();
  if (totalCards) nextItem(); else ctx.board.set({ fen: START_FEN, interactive: false });
  return () => { alive = false; clearTimeout(timer); };
}
