// Model games: play through a strong game that follows one of your lines and guess your side's moves.
import { state, save, getRep } from '../store.js';
import { h, icon, toast, sfx, pct } from '../ui.js';
import { replay, parsePgnGames, mainline, START_FEN, START_EPD, moveLabel, lineText } from '../chessutil.js';
import { masters, highRated, masterGamePgn, lichessGamePgn } from '../api.js';
import * as R from '../repertoire.js';
import { decLine } from '../app.js';

function randomLine(rep) {
  const line = []; let epd = START_EPD; const seen = new Set([epd]);
  for (;;) {
    const ms = R.movesAt(rep, epd).filter(m => !seen.has(m.to) && !(m.mine && m.disabled));
    if (!ms.length) return line;
    const m = ms[Math.floor(Math.random() * ms.length)];
    line.push(m.san); epd = m.to; seen.add(epd);
  }
}

export function modelView(ctx) {
  const side = ctx.side; let alive = true, timer = null;
  const reps = state.repertoires.filter(r => Object.keys(r.positions).length);
  let rep = getRep(ctx.params.rep) || reps[0];
  ctx.setCrumbs([{ label: 'Model games' }]); ctx.setLine(null);
  let phase = 'pick', games = [], baseLine = decLine(ctx.params.line), status = '', game = null, steps = [], ply = 0, start = 0, hits = 0, asked = 0, last = null;
  const later = (fn, ms) => { clearTimeout(timer); timer = setTimeout(() => alive && fn(), ms); };

  async function findGames() {
    if (!rep) { phase = 'empty'; return render(); }
    phase = 'loading'; status = 'Looking for games in your lines…'; render();
    let line = baseLine.length ? baseLine : randomLine(rep);
    const src = state.settings.modelSource;
    const me = rep.color === 'w' ? 'white' : 'black';
    for (let tries = 0; tries < 12; tries++) {
      const st = replay(line);
      const fen = st.length ? st[st.length - 1].fenAfter : START_FEN;
      const found = [];
      if (src !== 'lichess') { const d = await masters(fen, { prio: 5 }); for (const g of d?.topGames || []) found.push({ ...g, src: 'masters' }); }
      if (src !== 'masters' || found.length < 3) { const d = await highRated(fen, { prio: 5 }); for (const g of d?.topGames || []) found.push({ ...g, src: 'lichess' }); }
      if (!alive) return;
      if (found.length >= 2 || !line.length) {
        // prefer games where my colour did well
        found.sort((a, b) => (b.winner === me) - (a.winner === me) || (a.winner == null ? 0 : 1) - (b.winner == null ? 0 : 1));
        games = found.slice(0, 12); baseLine = line; phase = 'pick';
        const l = st[st.length - 1];
        ctx.board.set({ fen, lastMove: l ? [l.from, l.to] : null, interactive: false, orientation: me });
        ctx.setLine({ sans: line, cur: line.length, fen, opening: rep.positions[l?.epdAfter]?.name || '' });
        return render();
      }
      line = line.slice(0, -1);
    }
    games = []; phase = 'pick'; render();
  }

  async function loadGame(g) {
    phase = 'loading'; status = 'Loading the game…'; render();
    const pgn = g.src === 'masters' ? await masterGamePgn(g.id) : await lichessGamePgn(g.id);
    const parsed = pgn ? parsePgnGames(pgn)[0] : null;
    if (!parsed) { toast('Could not load that game', 'err'); phase = 'pick'; return render(); }
    steps = replay(mainline(parsed.root)); game = { ...g, headers: parsed.headers };
    // skip the part that is already in your repertoire
    start = 0; let epd = START_EPD;
    while (start < steps.length && rep.positions[epd]?.moves[steps[start].san]) { epd = steps[start].epdAfter; start++; }
    ply = Math.max(0, start - 1); hits = 0; asked = 0; last = null; phase = 'play';
    ctx.board.orientation = rep.color === 'w' ? 'white' : 'black';
    setBoard(false); later(advance, 500);
  }
  const fenAt = i => (i ? steps[i - 1].fenAfter : START_FEN);
  function setBoard(interactive, shapes = []) {
    const st = ply ? steps[ply - 1] : null;
    ctx.board.set({ fen: fenAt(ply), lastMove: st ? [st.from, st.to] : null, interactive: interactive ? (rep.color === 'w' ? 'white' : 'black') : false, shapes });
    ctx.setLine({ sans: steps.slice(0, ply).map(s => s.san), cur: ply, fen: fenAt(ply), opening: `${game.white.name} – ${game.black.name}` });
  }
  function advance() {
    if (ply >= steps.length) { phase = 'done'; state.modelHistory.push({ id: game.id, repId: rep.id, date: Date.now(), hits, asked }); save(); sfx.done(); return render(); }
    const st = steps[ply];
    if (st.color !== rep.color || ply < start) {
      ctx.board.set({ fen: st.fenBefore, interactive: false, animate: false, lastMove: ply ? [steps[ply - 1].from, steps[ply - 1].to] : null });
      ctx.board.playSan(st.san); ply++;
      ctx.setLine({ sans: steps.slice(0, ply).map(s => s.san), cur: ply, fen: fenAt(ply), opening: `${game.white.name} – ${game.black.name}` });
      return later(advance, ply < start ? 220 : 600);
    }
    phase = 'ask'; setBoard(true); render();
  }
  ctx.board.onMove = m => {
    if (phase !== 'ask') return;
    const st = steps[ply]; asked++;
    if (m.san === st.san) { hits++; sfx.good(); last = { ok: true, san: st.san, ply }; ply++; phase = 'play'; setBoard(false); render(); later(advance, 500); }
    else {
      sfx.bad(); last = { ok: false, san: st.san, played: m.san, ply };
      phase = 'reveal'; render();
      later(() => { ctx.board.set({ fen: st.fenBefore, interactive: false, animate: false, shapes: [{ from: st.from, to: st.to, brush: 'green' }], lastMove: ply ? [steps[ply - 1].from, steps[ply - 1].to] : null }); }, 500);
    }
  };
  function cont() { if (phase !== 'reveal') return; ctx.board.playSan(steps[ply].san); ply++; phase = 'play'; render(); later(advance, 500); }
  ctx.onKey = e => { if ((e.key === ' ' || e.key === 'Enter') && phase === 'reveal') { cont(); return true; } return false; };

  function render() {
    side.innerHTML = '';
    const root = h('div.view');
    if (phase === 'empty' || !rep) {
      root.append(h('h1', 'Model games'), h('p.sub', 'Add some moves to a repertoire first — model games are picked to follow your own lines.'), h('div.actions', h('a.action', { href: '#/' }, h('span', icon('back'), ' Home'))));
    } else if (phase === 'loading') root.append(h('h1', 'Model games'), h('div.loading', h('span.spinner'), ' ', status));
    else if (phase === 'pick') {
      root.append(h('h1', 'Play through a model game'),
        h('p.sub', 'See how strong players handle the positions your openings lead to. Their moves are played for you until the game leaves your repertoire — then you guess your side\'s moves.'),
        reps.length > 1 && h('div.set-row', h('span', 'Repertoire'), h('select', { onchange: e => { rep = getRep(e.target.value); baseLine = []; findGames(); } }, reps.map(r => h('option', { value: r.id, selected: r === rep }, r.name)))),
        h('div.section-head', h('span', baseLine.length ? `Games after ${lineText(baseLine)}` : 'Games'), h('button.linkbtn', { onclick: () => { baseLine = []; findGames(); } }, 'Another line')));
      if (!games.length) root.append(h('p.muted.pad', 'No games found for this line. Try another line.'));
      const tbl = h('div.table.games');
      for (const g of games) tbl.append(h('button.trow.clickable', { onclick: () => loadGame(g) },
        h('span', h('b', g.white.name), h('span.muted', ` ${g.white.rating}`), ' – ', h('b', g.black.name), h('span.muted', ` ${g.black.rating}`)),
        h('span.c.num', g.winner === 'white' ? '1–0' : g.winner === 'black' ? '0–1' : '½–½'), h('span.c.muted', g.year || ''), h('span.c.muted', g.src === 'masters' ? 'OTB' : 'online')));
      root.append(tbl);
      const hist = state.modelHistory.slice(-200); const tot = hist.reduce((a, x) => a + x.asked, 0);
      if (hist.length) root.append(h('p.muted.small.pad', `You have played through ${state.modelHistory.length} model game${state.modelHistory.length === 1 ? '' : 's'}, matching the master move ${tot ? pct(hist.reduce((a, x) => a + x.hits, 0) / tot) : '—'} of the time.`));
    } else {
      root.append(h('h1', `${game.white.name} – ${game.black.name}`), h('p.sub', [game.headers?.Event, game.year || game.headers?.Date?.slice(0, 4), game.winner === 'white' ? '1–0' : game.winner === 'black' ? '0–1' : '½–½'].filter(Boolean).join(' · ')));
      root.append(h('div.counters.left', h('span.cnt.ok', hits, icon('check')), h('span.cnt.due', `of ${asked} guesses`)));
      if (phase === 'ask') root.append(h('div.prompt', h('span.mv-num', moveLabel(ply, '').trim()), h('b', '＿'), h('span.note', 'What would you play? Guess the move on the board.')));
      else if (phase === 'reveal') root.append(h('div.prompt', h('span.mv-num', moveLabel(ply, '').trim()), h('b', last.san), h('span.note', `You tried ${last.played}; the game continued ${last.san}.`)), h('div.actions', h('button.action.primary', { onclick: cont }, h('span', 'Continue'), h('kbd', 'Space'))));
      else if (phase === 'done') root.append(h('div.bigstat', h('b', asked ? pct(hits / asked) : '—'), ' moves matched'), h('p.sub', `You guessed ${hits} of ${asked} moves.`),
        h('div.actions', h('button.action.primary', { onclick: () => { baseLine = []; findGames(); } }, h('span', icon('play'), ' Another game')), game.src === 'lichess' && h('a.action', { href: `https://lichess.org/${game.id}`, target: '_blank', rel: 'noopener' }, h('span', icon('ext'), ' Open on Lichess')), h('a.action', { href: '#/' }, h('span', icon('check'), ' Done'))));
      else if (last) root.append(h('p.sub', last.ok ? h('span.ok', `${last.san} — same as the game!`) : ''));
      if (phase !== 'done') root.append(h('div.actions', h('button.action.subtle', { onclick: () => { clearTimeout(timer); phase = 'done'; state.modelHistory.push({ id: game.id, repId: rep.id, date: Date.now(), hits, asked }); save(); render(); } }, h('span', 'Stop here'))));
    }
    side.append(root);
  }
  findGames();
  return () => { alive = false; clearTimeout(timer); };
}
