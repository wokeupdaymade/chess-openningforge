// Application shell: routing, board panel, top bar.
import { state, load, flush } from './store.js';
import { Board } from './board.js';
import { h, icon, toast } from './ui.js';
import { net } from './api.js';
import { engineStatus } from './engine.js';
import { START_FEN, moveLabel } from './chessutil.js';
import { homeView } from './views/home.js';
import { overviewView, repSettingsView, browseView, importView, learnView } from './views/overview.js';
import { builderView } from './views/builder.js';
import { practiceView } from './views/practice.js';
import { autofillView } from './views/autofill.js';
import { settingsView, newRepView, onboardingView } from './views/settings.js';
import { gamesView } from './views/games.js';
import { modelView } from './views/model.js';

const $ = id => document.getElementById(id);
let board, cleanup = null, lineState = null;

export const encLine = sans => sans.map(encodeURIComponent).join(',');
export const decLine = s => (s ? s.split(',').map(decodeURIComponent).filter(Boolean) : []);

const routes = [
  [/^\/?$/, homeView],
  [/^\/welcome$/, onboardingView],
  [/^\/new$/, newRepView],
  [/^\/settings$/, settingsView],
  [/^\/games$/, gamesView],
  [/^\/model(?:\/([\w]+))?$/, modelView, ['rep']],
  [/^\/practice$/, practiceView],
  [/^\/rep\/(\w+)$/, overviewView, ['rep']],
  [/^\/rep\/(\w+)\/build(?:\/(.*))?$/, builderView, ['rep', 'line']],
  [/^\/rep\/(\w+)\/learn(?:\/(.*))?$/, learnView, ['rep', 'line']],
  [/^\/rep\/(\w+)\/practice(?:\/(.*))?$/, practiceView, ['rep', 'line']],
  [/^\/rep\/(\w+)\/browse$/, browseView, ['rep']],
  [/^\/rep\/(\w+)\/settings$/, repSettingsView, ['rep']],
  [/^\/rep\/(\w+)\/import$/, importView, ['rep']],
  [/^\/rep\/(\w+)\/autofill(?:\/(.*))?$/, autofillView, ['rep', 'line']],
];

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const [re, view, names = []] of routes) {
    const m = path.match(re);
    if (m) { const params = { ...query }; names.forEach((n, i) => { params[n] = m[i + 1] || ''; }); return { view, params, path }; }
  }
  return { view: homeView, params: {}, path: '/' };
}

const ctx = {
  get board() { return board; },
  side: null,
  go(hash, replace = false) {
    if (replace) { history.replaceState(null, '', '#' + hash); render(); }
    else if (location.hash === '#' + hash) render(); else location.hash = hash;
  },
  // update the URL without re-mounting the view (used while stepping through lines)
  silent(hash) { history.replaceState(null, '', '#' + hash); },
  back() { if (history.length > 1) history.back(); else ctx.go('/'); },
  setCrumbs(items) {
    const el = $('crumbs'); el.innerHTML = '';
    el.append(h('a.logo', { href: '#/', title: 'Home' }, h('span.logo-mark', '♞'), h('span.logo-text', 'OpeningForge')));
    for (const it of items) { el.append(h('span.crumb-sep', '›')); el.append(it.href ? h('a', { href: '#' + it.href }, it.label) : h('span', it.label)); }
  },
  // Line under the board. {opening, sans, cur, saved:[bool], onJump(i), tools:[Node], fen}
  setLine(ls) { lineState = ls; renderLine(); },
  topActions: [],
};

function renderLine() {
  const el = $('lineinfo'); el.innerHTML = '';
  const ls = lineState; if (!ls) return;
  const moves = h('div.line-moves');
  (ls.sans || []).forEach((san, i) => {
    if (i % 2 === 0) moves.append(h('span.num', `${i / 2 + 1}.`));
    const cls = (i + 1 === ls.cur ? '.cur' : '') + (ls.saved && ls.saved[i] === false ? '.unsaved' : '') + (i + 1 > ls.cur ? '.future' : '');
    moves.append(h('button.mv' + cls, { onclick: () => ls.onJump?.(i + 1), title: ls.saved && ls.saved[i] === false ? 'Not saved yet' : '' }, san));
  });
  const fen = ls.fen || START_FEN;
  const tools = h('div.line-tools',
    ls.onJump && h('button.tool', { title: 'Start (Home)', onclick: () => ls.onJump(0) }, icon('first')),
    ls.onJump && h('button.tool', { title: 'Back (←)', onclick: () => ls.onJump(Math.max(0, ls.cur - 1)) }, icon('back')),
    ls.onJump && h('button.tool', { title: 'Forward (→)', onclick: () => ls.onJump(Math.min(ls.sans.length, ls.cur + 1)) }, icon('next')),
    h('button.tool', { title: 'Flip board (F)', onclick: () => board.flip() }, icon('flip')),
    h('button.tool', { title: 'Copy FEN', onclick: () => { navigator.clipboard?.writeText(fen); toast('FEN copied'); } }, 'FEN'),
    h('a.tool', { title: 'Analyse on Lichess', target: '_blank', rel: 'noopener', href: 'https://lichess.org/analysis/standard/' + fen.replace(/ /g, '_') }, icon('ext')),
    ...(ls.tools || []));
  el.append(h('div.line-head', h('div.opening-name', ls.opening || ''), tools), moves);
  moves.querySelector('.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderTop() {
  const el = $('topbar'); el.innerHTML = '';
  const status = h('div.netstatus');
  const upd = () => {
    status.innerHTML = '';
    if (net.lastError) status.append(h('span.warn', net.lastError));
    else if (engineStatus.running) status.append(h('span', icon('chip', 14), ' engine thinking…'));
    else if (net.pending) status.append(h('span', h('span.spinner'), ` loading Lichess data (${net.pending})`));
  };
  net.listeners.clear(); net.listeners.add(upd); upd();
  clearInterval(renderTop.t); renderTop.t = setInterval(upd, 700);
  el.append(
    h('button.linkbtn.backbtn', { onclick: () => ctx.back(), style: { visibility: parseHash().path === '/' ? 'hidden' : 'visible' } }, icon('back'), ' Back'),
    status,
    h('nav', h('a.linkbtn', { href: '#/' }, 'Home'), h('a.linkbtn', { href: '#/settings' }, icon('gear', 14), ' Settings')));
}

function render() {
  try { cleanup?.(); } catch (e) { console.error(e); }
  cleanup = null; lineState = null; $('lineinfo').innerHTML = '';
  board.onMove = null; ctx.onKey = null;
  const { view, params } = parseHash();
  ctx.params = params;
  const side = $('side'); side.innerHTML = ''; side.scrollTop = 0; ctx.side = side;
  renderTop();
  ctx.setCrumbs([]);
  try { cleanup = view(ctx) || null; }
  catch (e) { console.error(e); side.append(h('div.pad', h('h1', 'Something went wrong'), h('pre.err', String(e.stack || e)), h('a.btn', { href: '#/' }, 'Go home'))); }
}

document.addEventListener('keydown', e => {
  if (e.target.matches('input,textarea,select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('.modal-backdrop')) return;
  if (ctx.onKey?.(e)) { e.preventDefault(); return; }
  const ls = lineState;
  if (e.key === 'f' || e.key === 'F') { board.flip(); }
  else if (ls?.onJump && e.key === 'ArrowLeft') { ls.onJump(Math.max(0, ls.cur - 1)); e.preventDefault(); }
  else if (ls?.onJump && e.key === 'ArrowRight') { ls.onJump(Math.min(ls.sans.length, ls.cur + 1)); e.preventDefault(); }
  else if (ls?.onJump && e.key === 'Home') { ls.onJump(0); e.preventDefault(); }
  else if (ls?.onJump && e.key === 'End') { ls.onJump(ls.sans.length); e.preventDefault(); }
});

(async function main() {
  await load();
  board = new Board($('board'), $('promo'));
  board.applySettings();
  board.set({ fen: START_FEN, interactive: false });
  window.addEventListener('hashchange', render);
  window.addEventListener('resize', () => board.cg.redrawAll());
  if (!state.onboarded && !state.repertoires.some(r => Object.keys(r.positions).length)) history.replaceState(null, '', '#/welcome');
  render();
  window.__of = { state, ctx, flush, board }; // handy in the console
})();

export { ctx, moveLabel };
