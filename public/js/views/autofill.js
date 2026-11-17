// Autofill: closes gaps automatically with moves chosen by a weighted style (results / soundness / popularity).
import { state, save, getRep, repSettings } from '../store.js';
import { h, icon, toast, pct, oneIn, progressBar } from '../ui.js';
import { fenAfter, lineText, replay, START_FEN, moveLabel } from '../chessutil.js';
import { moveTable, rankCandidates } from '../posinfo.js';
import * as R from '../repertoire.js';
import { fmtEval } from '../api.js';
import { encLine, decLine } from '../app.js';

export function autofillView(ctx) {
  const rep = getRep(ctx.params.rep);
  if (!rep) { ctx.go('/'); return; }
  const side = ctx.side;
  const scopeLine = replay(decLine(ctx.params.line));
  const scopeEpd = scopeLine.length ? scopeLine[scopeLine.length - 1].epdAfter : null;
  const style = state.autofillStyle || { effectiveness: 2, soundness: 2, learnability: 2 };
  let max = 25, scoped = !!scopeEpd, running = false, stop = false, alive = true, log = [], addedKeys = [], status = '', an = R.cachedAnalysis(rep);
  ctx.setCrumbs([{ label: rep.name, href: `/rep/${rep.id}` }, { label: 'Autofill' }]);
  ctx.board.orientation = rep.color === 'w' ? 'white' : 'black';
  const show = sans => { const st = replay(sans); const l = st[st.length - 1]; ctx.board.set({ fen: l ? l.fenAfter : START_FEN, lastMove: l ? [l.from, l.to] : null, interactive: false }); ctx.setLine({ sans: st.map(x => x.san), cur: st.length, fen: l ? l.fenAfter : START_FEN, opening: '' }); };
  show(scopeLine.map(s => s.san));

  async function run() {
    running = true; stop = false; log = []; addedKeys = []; render();
    const s = repSettings(rep);
    const skipped = new Set();
    let added = 0;
    try {
      while (!stop && alive && added < max) {
        status = 'Finding the biggest gap…'; render();
        an = await R.analyze(rep, { prio: 3 });
        const gap = an.gaps.find(g => !skipped.has(g.epd) && (!scoped || !scopeEpd || g.path.includes(scopeEpd)));
        if (!gap) break;
        show(gap.line);
        status = `Choosing a reply after ${lineText(gap.line) || 'the start'}…`; render();
        const fen = gap.line.length ? fenAfter(gap.line) : START_FEN;
        const t = moveTable(fen, { prio: 6, settings: s, evals: true, childEvals: 2 });
        await t.done;
        if (stop || !alive) break;
        const ranked = rankCandidates(t, s, style);
        let pick = ranked.filter(c => c.acceptable).sort((a, b) => b.score - a.score)[0];
        let reason = pick ? '' : 'no evaluation — most popular move';
        if (!pick && t.bestEval == null) pick = [...ranked].sort((a, b) => (b.share + b.mastersShare) - (a.share + a.mastersShare))[0];
        if (!pick) { skipped.add(gap.epd); log.unshift({ line: gap.line, skipped: true }); continue; }
        const sans = [...gap.line, pick.san];
        R.addLine(rep, sans, { auto: true, quality: { [sans.length - 1]: { loss: pick.loss, win: pick.win, share: pick.share } } });
        const st = replay(sans); const last = st[st.length - 1];
        if (t.opening?.name && rep.positions[last.epdBefore]) rep.positions[last.epdBefore].name = t.opening.name;
        addedKeys.push([last.epdBefore, last.san]);
        added++;
        log.unshift({ line: gap.line, san: pick.san, incidence: gap.incidence, eval: pick.eval, win: pick.win, reason, sans });
        show(sans); render();
      }
    } catch (e) { console.error(e); toast('Autofill stopped: ' + (e.message || e), 'err'); }
    running = false; status = '';
    if (alive) { try { an = await R.analyze(rep, { prio: 3 }); } catch { /* ignore */ } render(); }
  }
  function undo() {
    for (const [epd, san] of addedKeys.reverse()) if (rep.positions[epd]?.moves[san]) delete rep.positions[epd].moves[san];
    R.prune(rep); R.touch(rep); toast(`Removed ${addedKeys.length} autofilled moves`); addedKeys = []; log = []; an = null; render();
    R.analyze(rep).then(r => { an = r; if (alive) render(); }).catch(() => {});
  }

  function slider(key, label, help) {
    return h('div.style-row', h('div', h('b', label), h('div.muted.small', help)),
      h('input', { type: 'range', min: 0, max: 5, step: 1, value: style[key], disabled: running, oninput: e => { style[key] = +e.target.value; state.autofillStyle = style; save(); e.target.nextSibling.textContent = style[key]; } }), h('span.num', style[key]));
  }
  function render() {
    side.innerHTML = '';
    const root = h('div.view', h('h1', scopeEpd && scoped ? 'Autofill this gap' : 'Autofill remaining gaps'),
      h('p.sub', 'Adds a sound reply to your biggest gaps, one at a time, following your coverage settings. Autofilled moves are tagged and can be removed at any time — you keep full control.'),
      an && h('div.comp', h('div.comp-head', h('b', `${pct(an.completion)} complete`), h('span.muted', `${an.gaps.length} gap${an.gaps.length === 1 ? '' : 's'}`)), progressBar(an.completion, { cls: an.completion > 0.999 ? 'ok' : '' })),
      h('div.section-head', h('span', 'Pick a style')),
      slider('effectiveness', 'Effectiveness', 'More points = more wins at your level'),
      slider('soundness', 'Soundness', 'More points = closer to the engine\'s first choice'),
      slider('learnability', 'Learnability', 'More points = more natural, commonly played moves'),
      h('div.set-row', h('span', 'Add at most'), h('select', { disabled: running, onchange: e => { max = +e.target.value; } }, [5, 10, 25, 50, 100, 250, 1000].map(n => h('option', { value: n, selected: n === max }, `${n} moves`)))),
      scopeEpd && h('label.set-row', h('span', `Only below ${lineText(scopeLine.map(s => s.san))}`), h('input', { type: 'checkbox', checked: scoped, disabled: running, onchange: e => { scoped = e.target.checked; render(); } })),
      h('div.actions',
        running ? h('button.action.danger', { onclick: () => { stop = true; status = 'Stopping…'; render(); } }, h('span', icon('x'), ' Stop'), h('span.muted', status))
          : h('button.action.primary', { onclick: run }, h('span', icon('wand'), ' Autofill moves in this style')),
        !running && addedKeys.length > 0 && h('button.action', { onclick: undo }, h('span', icon('undo'), ` Undo these ${addedKeys.length} moves`)),
        !running && h('a.action', { href: `#/rep/${rep.id}` }, h('span', icon('check'), ' Done'))),
      running && h('div.loading', h('span.spinner'), ' ', status));
    if (log.length) {
      root.append(h('div.section-head', h('span', `Added ${log.filter(l => !l.skipped).length} moves`), h('span.muted', 'expected in')));
      const tbl = h('div.table.gaps');
      for (const l of log.slice(0, 200)) tbl.append(l.skipped
        ? h('div.trow.muted', h('span', lineText(l.line), ' — skipped (no data)'), h('span'))
        : h('a.trow.clickable', { href: `#/rep/${rep.id}/build/${encLine(l.sans)}`, onmouseenter: () => !running && show(l.sans) },
          h('span.gap-line', h('span.muted', lineText(l.line) + ' '), h('b', moveLabel(l.line.length, l.san)), l.eval != null && h('span.muted', ` (${fmtEval(rep.color === 'w' ? l.eval : -l.eval)}${l.win != null ? ', scores ' + pct(l.win) : ''})`), l.reason && h('span.muted', ' · ' + l.reason)),
          h('span.c.num', oneIn(l.incidence))));
      root.append(tbl);
    }
    side.append(root);
  }
  render();
  if (!an && R.countMoves(rep).all) R.analyze(rep).then(r => { an = r; if (alive && !running) render(); }).catch(() => {});
  return () => { alive = false; stop = true; };
}
