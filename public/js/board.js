// Chessground wrapper with legal-move handling, promotion picker and arrows.
import { Chessground } from '/vendor/chessground.js';
import { Chess, dests } from './chessutil.js';
import { state } from './store.js';
import { sfx } from './ui.js';

export class Board {
  constructor(el, promoEl) {
    this.el = el; this.promoEl = promoEl;
    this.chess = new Chess();
    this.onMove = null;     // (moveObj, fenBefore) => void
    this.orientation = 'white';
    this.cg = Chessground(el, {
      animation: { enabled: true, duration: state.settings.animation },
      coordinates: state.settings.showCoords,
      highlight: { lastMove: true, check: true },
      movable: { free: false, color: 'both', showDests: true, events: { after: (from, to) => this.userMove(from, to) } },
      premovable: { enabled: false },
      draggable: { showGhost: true },
      drawable: { enabled: true, eraseOnClick: false },
    });
  }
  applySettings() {
    this.cg.set({ animation: { enabled: state.settings.animation > 0, duration: state.settings.animation }, coordinates: state.settings.showCoords });
    document.body.dataset.board = state.settings.boardTheme;
    this.cg.redrawAll();
  }
  // Show a position. lastMove: [from,to]; interactive: false | 'both' | 'white' | 'black'
  set({ fen, lastMove = null, orientation, interactive = 'both', shapes = [], animate = true }) {
    this.chess = new Chess(fen);
    if (orientation) this.orientation = orientation;
    const turn = this.chess.turn() === 'w' ? 'white' : 'black';
    const canMove = interactive === 'both' || interactive === turn;
    if (!animate) this.cg.set({ animation: { enabled: false } });
    this.cg.set({
      fen, orientation: this.orientation, turnColor: turn, lastMove: lastMove || undefined,
      check: this.chess.inCheck(),
      movable: { color: canMove ? turn : undefined, dests: canMove ? dests(this.chess) : new Map() },
    });
    if (!animate) this.cg.set({ animation: { enabled: state.settings.animation > 0, duration: state.settings.animation } });
    this.setShapes(shapes);
    this.hidePromo();
  }
  setShapes(shapes) { this.cg.setAutoShapes(shapes.map(s => ({ orig: s.from, dest: s.to, brush: s.brush || 'green', modifiers: { lineWidth: s.width || 7 } }))); }
  flip() { this.orientation = this.orientation === 'white' ? 'black' : 'white'; this.cg.set({ orientation: this.orientation }); }
  async userMove(from, to) {
    const piece = this.chess.get(from);
    let promotion;
    if (piece?.type === 'p' && (to[1] === '8' || to[1] === '1')) {
      promotion = await this.askPromo(to, piece.color);
      if (!promotion) { this.cg.set({ fen: this.chess.fen() }); this.set({ fen: this.chess.fen(), lastMove: this.cg.state.lastMove }); return; }
    }
    const fenBefore = this.chess.fen();
    let m;
    try { m = this.chess.move({ from, to, promotion }); } catch { m = null; }
    if (!m) { this.cg.set({ fen: fenBefore }); return; }
    (m.captured ? sfx.capture : sfx.move)();
    // sync special moves (castling, en passant, promotion)
    this.cg.set({ fen: this.chess.fen(), check: this.chess.inCheck(), turnColor: this.chess.turn() === 'w' ? 'white' : 'black', movable: { dests: new Map() } });
    this.onMove?.(m, fenBefore);
  }
  askPromo(to, color) {
    return new Promise(resolve => {
      const el = this.promoEl; el.innerHTML = ''; el.classList.add('open');
      const c = color === 'w' ? 'white' : 'black';
      for (const [p, name] of [['q', 'queen'], ['n', 'knight'], ['r', 'rook'], ['b', 'bishop']]) {
        const b = document.createElement('button'); b.className = 'promo-choice'; b.title = name;
        const piece = document.createElement('piece'); piece.className = `${name} ${c}`; b.append(piece);
        b.onclick = () => { this.hidePromo(); resolve(p); };
        el.append(b);
      }
      el.onclick = e => { if (e.target === el) { this.hidePromo(); resolve(null); } };
    });
  }
  hidePromo() { this.promoEl.classList.remove('open'); this.promoEl.innerHTML = ''; }
  // Animate a move given in SAN from the current position (used for opponent replies in practice).
  playSan(san) {
    const fenBefore = this.chess.fen();
    const m = this.chess.move(san);
    (m.captured ? sfx.capture : sfx.move)();
    this.cg.move(m.from, m.to);
    this.cg.set({ fen: this.chess.fen(), lastMove: [m.from, m.to], check: this.chess.inCheck(), turnColor: this.chess.turn() === 'w' ? 'white' : 'black' });
    return { m, fenBefore };
  }
}
