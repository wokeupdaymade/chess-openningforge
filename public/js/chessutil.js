// Chess helpers: position keys, line replay, PGN import/export with variations.
import { Chess } from '/vendor/chess.js';
export { Chess };

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Position key: board, turn, castling, en-passant (chess.js only reports e.p. when a capture is legal).
export function epdOf(fen) { return fen.split(' ').slice(0, 4).join(' '); }
export const START_EPD = epdOf(START_FEN);
export function fenOfEpd(epd) { return epd + ' 0 1'; }
export function turnOfEpd(epd) { return epd.split(' ')[1]; }

// Replays SAN moves; returns [{san, uci, from, to, fenBefore, fenAfter, epdBefore, epdAfter, color}]
export function replay(sans, startFen = START_FEN) {
  const c = new Chess(startFen);
  const out = [];
  for (const san of sans) {
    const fenBefore = c.fen();
    let m;
    try { m = c.move(san); } catch { m = null; }
    if (!m) break;
    out.push({ san: m.san, uci: m.from + m.to + (m.promotion || ''), from: m.from, to: m.to, color: m.color, fenBefore, fenAfter: c.fen(), epdBefore: epdOf(fenBefore), epdAfter: epdOf(c.fen()) });
  }
  return out;
}

export function fenAfter(sans) {
  const c = new Chess();
  for (const s of sans) c.move(s);
  return c.fen();
}

// Legal destinations map for chessground.
export function dests(chess) {
  const d = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!d.has(m.from)) d.set(m.from, []);
    d.get(m.from).push(m.to);
  }
  return d;
}

// Lichess UCI uses king-takes-rook for castling; normalise to standard UCI.
export function normUci(uci, chess) {
  const map = { e1h1: 'e1g1', e1a1: 'e1c1', e8h8: 'e8g8', e8a8: 'e8c8' };
  if (map[uci]) {
    const p = chess.get(uci.slice(0, 2));
    if (p && p.type === 'k') return map[uci];
  }
  return uci;
}

export function uciToSan(fen, uci) {
  const c = new Chess(fen);
  uci = normUci(uci, c);
  try { return c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; } catch { return null; }
}

// "1. e4 e5 2. Nf3" style text for a list of SANs.
export function lineText(sans, startPly = 0) {
  let s = '';
  sans.forEach((san, i) => {
    const ply = startPly + i;
    if (ply % 2 === 0) s += `${ply / 2 + 1}. `;
    else if (i === 0) s += `${(ply + 1) / 2}… `;
    s += san + ' ';
  });
  return s.trim();
}
export function moveLabel(ply, san) { return (ply % 2 === 0 ? `${ply / 2 + 1}. ` : `${(ply + 1) / 2}… `) + san; }

// ---------- PGN parsing (multiple games, nested variations, comments, NAGs) ----------
export function parsePgnMoves(body, startFen = START_FEN) {
  const root = { children: [], fen: startFen, parent: null };
  const tokens = body.match(/\{[^}]*\}|;[^\n]*|\(|\)|\$\d+|[^\s(){};]+/g) || [];
  const stack = [];
  let cur = root; // node after which the next move is appended
  for (const tok of tokens) {
    if (tok[0] === '{') {
      const c = tok.slice(1, -1).replace(/\[%[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
      if (c && cur !== root) cur.comment = cur.comment ? cur.comment + ' ' + c : c;
      continue;
    }
    if (tok[0] === ';' || tok[0] === '$') continue;
    if (tok === '(') { stack.push(cur); cur = cur.parent || root; continue; }
    if (tok === ')') { if (stack.length) cur = stack.pop(); continue; }
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) continue;
    let san = tok.replace(/^\d+\.+/, '');
    if (!san || /^\.+$/.test(san)) continue;
    san = san.replace(/[!?]+$/, '').replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O');
    if (san === '--' || san === 'Z0' || !/^[a-hKQRBNO]/.test(san)) continue;
    const node = { san, children: [], parent: cur };
    cur.children.push(node);
    cur = node;
  }
  return root;
}

export function parsePgnGames(text) {
  text = text.replace(/\r/g, '').replace(/^﻿/, '');
  const chunks = [];
  let cur = null, inMoves = false;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*\[(\w+)\s+"(.*)"\]\s*$/);
    if (m) {
      if (!cur || inMoves) { cur = { headers: {}, body: '' }; chunks.push(cur); inMoves = false; }
      cur.headers[m[1]] = m[2];
    } else {
      if (!cur) { cur = { headers: {}, body: '' }; chunks.push(cur); }
      if (line.trim()) inMoves = true;
      cur.body += line + '\n';
    }
  }
  return chunks.filter(c => c.body.trim()).map(c => ({ headers: c.headers, root: parsePgnMoves(c.body, c.headers.FEN || START_FEN) }));
}

// Flattens a parsed game tree into every root-to-leaf line: [{sans:[...], comments:[...]}]
export function pgnLines(root) {
  const out = [];
  const walk = (node, sans, comments) => {
    if (!node.children.length) { if (sans.length) out.push({ sans, comments }); return; }
    for (const ch of node.children) walk(ch, [...sans, ch.san], [...comments, ch.comment || '']);
  };
  walk(root, [], []);
  return out;
}

// Mainline SAN list of a parsed game.
export function mainline(root) {
  const sans = [];
  let n = root;
  while (n.children.length) { n = n.children[0]; sans.push(n.san); }
  return sans;
}
