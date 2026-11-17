// Online game review: where did I (or my opponent) leave my repertoire? Plus results by opening.
import { state, save } from '../store.js';
import { h, icon, toast, pct, progressBar } from '../ui.js';
import { replay, lineText, moveLabel, parsePgnGames, mainline, START_FEN, START_EPD } from '../chessutil.js';
import { lichessGames, chesscomGames } from '../api.js';
import * as R from '../repertoire.js';
import { encLine } from '../app.js';

function scanGame(g, reps) {
  // follow the game through each repertoire of my colour; keep the one that stays in book longest
  let best = null;
  const steps = replay(g.moves.slice(0, 40));
  for (const rep of reps) {
    let res = { rep, depth: 0, kind: 'none' };
    let epd = START_EPD;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      if (st.color === rep.color) {
        const mine = R.myMovesAt(rep, epd, false);
        if (!mine.length) { res = { rep, depth: i, kind: i === 0 ? 'none' : 'gap', ply: i, line: steps.slice(0, i).map(s => s.san), oppMove: i ? steps[i - 1].san : null }; break; }
        if (!mine.some(m => m.san === st.san)) { res = { rep, depth: i, kind: 'mistake', ply: i, line: steps.slice(0, i).map(s => s.san), played: st.san, expected: mine.filter(m => !m.disabled).map(m => m.san) }; break; }
      }
      epd = st.epdAfter; res = { rep, depth: i + 1, kind: 'inbook' };
    }
    if (!best || res.depth > best.depth) best = res;
  }
  return best;
}

export function gamesView(ctx) {
  const side = ctx.side; let tab = ctx.params.tab === 'perf' ? 'perf' : 'mistakes', busy = '', alive = true;
  ctx.setCrumbs([{ label: 'Online games' }]); ctx.setLine(null);
  ctx.board.set({ fen: START_FEN, interactive: false });
  const s = state.settings;
  const show = (sans, color) => { const st = replay(sans); const l = st[st.length - 1]; ctx.board.set({ fen: l ? l.fenAfter : START_FEN, lastMove: l ? [l.from, l.to] : null, interactive: false, orientation: color === 'w' ? 'white' : 'black', animate: false }); ctx.setLine({ sans: st.map(x => x.san), cur: st.length, fen: l ? l.fenAfter : START_FEN }); };

  async function scan() {
    if (!s.lichessUser && !s.chesscomUser) return toast('Enter a Lichess or Chess.com username first', 'err');
    busy = 'Downloading your recent games…'; render();
    const games = [];
    try {
      if (s.lichessUser) games.push(...await lichessGames(s.lichessUser, 150));
      if (s.chesscomUser) games.push(...await chesscomGames(s.chesscomUser, 150, parsePgnGames, mainline));
    } catch (e) { toast(e.message, 'err', 6000); if (!games.length) { busy = ''; render(); return; } }
    busy = 'Comparing with your repertoires…'; render();
    const mistakes = new Map(), gaps = new Map(), perf = new Map();
    let inBook = 0;
    for (const g of games) {
      const fam = (g.opening || 'Unknown').split(':')[0].split(',')[0].trim() || 'Unknown';
      const key = fam + '|' + g.color;
      const p = perf.get(key) || { name: fam, color: g.color, w: 0, d: 0, l: 0, depth: 0 };
      const mine = g.color === 'w' ? 'white' : 'black';
      if (g.winner === 'draw') p.d++; else if (g.winner === mine) p.w++; else p.l++;
      const reps = state.repertoires.filter(r => r.color === g.color && Object.keys(r.positions).length);
      const res = reps.length ? scanGame(g, reps) : null;
      if (res) { p.depth += res.depth; inBook += res.depth; }
      perf.set(key, p);
      if (!res) continue;
      const ref = { url: g.url, opp: g.color === 'w' ? g.black : g.white, date: g.date, result: g.winner === 'draw' ? '½' : g.winner === mine ? 'won' : 'lost' };
      if (res.kind === 'mistake') {
        const k = res.rep.id + '|' + res.line.join(' ') + '|' + res.played;
        const m = mistakes.get(k) || { repId: res.rep.id, line: res.line, played: res.played, expected: res.expected, color: g.color, games: [] };
        m.games.push(ref); mistakes.set(k, m);
      } else if (res.kind === 'gap') {
        const k = res.rep.id + '|' + res.line.join(' ');
        const m = gaps.get(k) || { repId: res.rep.id, line: res.line, color: g.color, games: [] };
        m.games.push(ref); gaps.set(k, m);
      }
    }
    state.gameReview = {
      when: Date.now(), games: games.length, avgDepth: games.length ? inBook / games.length / 2 : 0,
      mistakes: [...mistakes.values()].sort((a, b) => b.games.length - a.games.length),
      gaps: [...gaps.values()].sort((a, b) => b.games.length - a.games.length),
      perf: [...perf.values()].sort((a, b) => (b.w + b.d + b.l) - (a.w + a.d + a.l)),
    };
    save(); busy = ''; if (alive) render();
  }

  function render() {
    side.innerHTML = '';
    const gr = state.gameReview;
    const lu = h('input', { type: 'text', placeholder: 'Lichess username', value: s.lichessUser, onchange: e => { s.lichessUser = e.target.value.trim(); save(); } });
    const cu = h('input', { type: 'text', placeholder: 'Chess.com username', value: s.chesscomUser, onchange: e => { s.chesscomUser = e.target.value.trim(); save(); } });
    const root = h('div.view', h('h1', 'Review your online games'),
      h('p.sub', 'Finds the games where you left your own repertoire, and the moves your opponents played that you have no answer for yet.'),
      h('div.form', h('div.form-row', lu, cu), h('div.form-row', h('button.btn.primary', { disabled: !!busy, onclick: scan }, icon('bolt', 14), gr ? ' Rescan recent games' : ' Scan recent games'), gr && h('span.muted.small', `${gr.games} games scanned ${new Date(gr.when).toLocaleString()}`))),
      busy && h('div.loading', h('span.spinner'), ' ', busy));
    if (gr) {
      root.append(h('div.tabs', h('button' + (tab === 'mistakes' ? '.on' : ''), { onclick: () => { tab = 'mistakes'; render(); } }, `Mistakes (${gr.mistakes.length})`), h('button' + (tab === 'gaps' ? '.on' : ''), { onclick: () => { tab = 'gaps'; render(); } }, `Unprepared (${gr.gaps.length})`), h('button' + (tab === 'perf' ? '.on' : ''), { onclick: () => { tab = 'perf'; render(); } }, 'Performance')));
      if (tab === 'mistakes') {
        if (!gr.mistakes.length) root.append(h('p.muted.pad', 'No deviations from your repertoire in these games. Nice.'));
        for (const m of gr.mistakes) root.append(h('div.gcard', { onmouseenter: () => show([...m.line, m.played], m.color) },
          h('div.gline', lineText(m.line), ' ', h('b.bad', moveLabel(m.line.length, m.played)), h('span.muted', '  — your repertoire: '), h('b.ok', m.expected.join(' / ') || '(disabled move)')),
          h('div.gmeta', h('span.muted', `${m.games.length} game${m.games.length === 1 ? '' : 's'} · `, m.games.slice(0, 3).map((g, i) => [i ? ', ' : '', h('a', { href: g.url, target: '_blank', rel: 'noopener' }, `${g.result} vs ${g.opp}`)])),
            h('span.gactions', h('a.mini', { href: `#/rep/${m.repId}/practice/${encLine(m.line)}?mode=all` }, icon('play', 12), ' Practice'), h('a.mini', { href: `#/rep/${m.repId}/build/${encLine(m.line)}` }, 'Open in builder')))));
      } else if (tab === 'gaps') {
        if (!gr.gaps.length) root.append(h('p.muted.pad', 'Every game stayed inside your repertoire until you chose to deviate.'));
        for (const m of gr.gaps) root.append(h('div.gcard', { onmouseenter: () => show(m.line, m.color) },
          h('div.gline', lineText(m.line.slice(0, -1)), ' ', h('b.warn', moveLabel(m.line.length - 1, m.line[m.line.length - 1])), h('span.muted', '  — no reply prepared')),
          h('div.gmeta', h('span.muted', `${m.games.length} game${m.games.length === 1 ? '' : 's'} · `, m.games.slice(0, 3).map((g, i) => [i ? ', ' : '', h('a', { href: g.url, target: '_blank', rel: 'noopener' }, `${g.result} vs ${g.opp}`)])),
            h('span.gactions', h('a.mini', { href: `#/rep/${m.repId}/build/${encLine(m.line)}` }, icon('plus', 12), ' Add a reply')))));
      } else {
        root.append(h('p.muted.small', `On average you stayed in your repertoire for ${gr.avgDepth.toFixed(1)} moves.`));
        const tbl = h('div.table.perf', h('div.trow.thead', h('span', 'Opening'), h('span.c', 'Games'), h('span.c', 'Score'), h('span.c', 'W / D / L')));
        for (const p of gr.perf) {
          const n = p.w + p.d + p.l, sc = (p.w + p.d / 2) / n;
          tbl.append(h('div.trow', h('span', h('span.dot.' + (p.color === 'w' ? 'white' : 'black')), ' ', p.name), h('span.c.num', n), h('span.c', progressBar(sc, { cls: 'tiny ' + (sc >= 0.5 ? 'ok' : 'warn') }), h('span.num', ' ' + pct(sc))), h('span.c.num', `${p.w} / ${p.d} / ${p.l}`)));
        }
        root.append(tbl);
      }
    }
    side.append(root);
  }
  render();
  return () => { alive = false; };
}
