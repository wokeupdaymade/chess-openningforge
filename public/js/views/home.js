// Home: repertoires, daily tasks, online game review.
import { state, streak, today } from '../store.js';
import { h, icon, pct, relTime, progressBar } from '../ui.js';
import * as R from '../repertoire.js';
import { START_FEN } from '../chessutil.js';

export function homeView(ctx) {
  const side = ctx.side; let alive = true;
  ctx.board.set({ fen: START_FEN, interactive: false, orientation: 'white' });
  ctx.setLine(null);

  function render() {
    side.innerHTML = '';
    const root = h('div.view.home');
    root.append(h('div.section-head', h('span', 'Repertoires'), h('a.linkbtn', { href: '#/new' }, 'Add new ', icon('plus', 14))));
    let due = 0, total = 0, nextDue = Infinity;
    for (const rep of state.repertoires) {
      const an = R.cachedAnalysis(rep);
      const ls = R.learnStats(rep); due += ls.due; total += ls.total; nextDue = Math.min(nextDue, ls.nextDue);
      const empty = !ls.total;
      root.append(h('a.card.rep', { href: `#/rep/${rep.id}` },
        h('span.dot.' + (rep.color === 'w' ? 'white' : 'black')),
        h('span.rep-name', rep.name),
        h('span.rep-meta', empty ? 'Not started' : an ? `${pct(an.completion)} complete` : `${ls.total} moves`, an && !empty ? h('span.ring', { style: { '--p': an.completion } }) : null)));
    }
    const act = state.activity[today()];
    const st = streak();
    root.append(h('div.section-head', h('span', 'Daily tasks'), h('span.streak', `${st} day streak `, icon('fire', 14))));
    root.append(h('a.card' + (due ? '.primary' : ''), { href: '#/practice?batch=1' }, h('span', 'Practice moves'),
      h('span.muted', due ? `${due} due` : act?.practiced ? `${act.practiced} practiced today ✓` : total ? (isFinite(nextDue) ? `next in ${relTime(nextDue)}` : 'nothing due') : 'no moves yet')));
    if (act?.practiced) root.append(h('div.goal', progressBar(Math.min(1, act.practiced / state.settings.dailyGoal), { cls: 'tiny ok' }), h('span.muted', `${Math.min(act.practiced, state.settings.dailyGoal)} / ${state.settings.dailyGoal} daily goal`)));
    root.append(h('a.card', { href: '#/model' }, h('span', 'Play through a model game'), h('span.muted', 'guess the move')));

    const connected = state.settings.lichessUser || state.settings.chesscomUser;
    root.append(h('div.section-head', h('span', 'Review your online games'), h('a.linkbtn', { href: '#/games' }, connected ? [state.settings.lichessUser, state.settings.chesscomUser].filter(Boolean).join(' · ') : 'Connect account')));
    const gr = state.gameReview;
    root.append(h('a.card', { href: '#/games' }, h('span', 'Correct your opening mistakes'), h('span.muted', !connected ? 'Not connected' : gr ? `${gr.mistakes.length} found` : 'Scan games')));
    root.append(h('a.card', { href: '#/games?tab=perf' }, h('span', 'View performance by opening'), h('span.muted', !connected ? 'Not connected' : gr ? `${gr.games} games` : '')));

    root.append(h('div.section-head', h('span', 'Data')));
    root.append(h('a.card.flat', { href: '#/settings' }, h('span', 'Settings, backup & restore'), icon('gear', 14)));
    side.append(root);
  }
  render();
  // compute completion for each repertoire in the background
  (async () => {
    for (const rep of state.repertoires) {
      if (!Object.keys(rep.positions).length || R.cachedAnalysis(rep)) continue;
      try { await R.analyze(rep, { prio: -8 }); } catch { /* ignore */ }
      if (!alive) return; render();
    }
  })();
  return () => { alive = false; };
}
