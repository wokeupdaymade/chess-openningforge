// Tiny DOM helpers, icons, toasts, dialogs, sounds.
import { state } from './store.js';

export function h(tag, attrs, ...children) {
  let cls = '';
  tag = tag.replace(/\.([\w-]+)/g, (_, c) => { cls += ' ' + c; return ''; }) || 'div';
  const el = document.createElement(tag);
  if (cls) el.className = cls.trim();
  if (attrs != null && (attrs instanceof Node || typeof attrs !== 'object' || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = (el.className + ' ' + v).trim();
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = c => {
    if (c == null || c === false || c === true) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

const ICONS = {
  back: 'M15 5l-7 7 7 7', next: 'M9 5l7 7-7 7', first: 'M18 5l-7 7 7 7M7 5v14', last: 'M6 5l7 7-7 7M17 5v14',
  plus: 'M12 5v14M5 12h14', check: 'M5 12.5l4.5 4.5L19 7.5', x: 'M6 6l12 12M18 6L6 18',
  gear: 'M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM19.4 13a7.5 7.5 0 000-2l2-1.5-2-3.5-2.4 1a7.5 7.5 0 00-1.7-1L15 3.5h-4l-.3 2.5a7.5 7.5 0 00-1.7 1l-2.4-1-2 3.5 2 1.5a7.5 7.5 0 000 2l-2 1.5 2 3.5 2.4-1a7.5 7.5 0 001.7 1l.3 2.5h4l.3-2.5a7.5 7.5 0 001.7-1l2.4 1 2-3.5z',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13', pause: 'M8 5v14M16 5v14', play: 'M7 5l12 7-12 7z',
  flip: 'M7 4v14M4 15l3 3 3-3M17 20V6M14 9l3-3 3 3', wand: 'M5 19L16 8M14 6l4 4M17 3v2M20 6h2M19 10v1M9 4v2', note: 'M5 4h14v12l-4 4H5zM15 20v-4h4',
  target: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 16a4 4 0 100-8 4 4 0 000 8zM12 12h.01', fire: 'M12 3c1 4 5 5 5 10a5 5 0 01-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6', clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2', book: 'M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2zM4 21V5M8 7h7',
  tree: 'M6 3v12M6 9h8a3 3 0 013 3v0M6 15h5a3 3 0 013 3v3M17 12v3', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  ban: 'M12 21a9 9 0 100-18 9 9 0 000 18zM5.6 5.6l12.8 12.8', star: 'M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9 6.6 19.8l1.1-6.1L3.2 9.4l6.1-.8z',
  down: 'M6 9l6 6 6-6', bolt: 'M13 2L4 14h7l-1 8 9-12h-7z', upload: 'M12 16V4M7 9l5-5 5 5M4 20h16', download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  chip: 'M8 4h8v16H8zM4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4', users: 'M9 11a4 4 0 100-8 4 4 0 000 8zM2 21a7 7 0 0114 0M17 11a3 3 0 100-6M22 21a6 6 0 00-4-5.6',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
};
export function icon(name, size = 16) {
  const el = h('span.icon');
  el.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ''}"/></svg>`;
  return el;
}

export function toast(msg, kind = 'info', ms = 3500) {
  const el = h('div.toast.' + kind, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

export function modal({ title, body, actions = [], wide = false }) {
  return new Promise(resolve => {
    const close = v => { root.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    const root = h('div.modal-backdrop', { onmousedown: e => { if (e.target === root) close(null); } },
      h('div.modal' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true' },
        title && h('h2', title),
        h('div.modal-body', typeof body === 'function' ? body(close) : body),
        h('div.modal-actions', actions.map(a => h('button.btn' + (a.kind ? '.' + a.kind : ''), { onclick: () => close(typeof a.value === 'function' ? a.value() : a.value) }, a.label)))));
    document.getElementById('modal-root').append(root);
    document.addEventListener('keydown', onKey, true);
    root.querySelector('input,textarea,select,button')?.focus();
  });
}
export function confirmDialog(title, text, okLabel = 'Confirm', danger = false) {
  return modal({ title, body: h('p', text), actions: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, kind: danger ? 'danger' : 'primary' }] });
}
export function promptDialog(title, { value = '', multiline = false, placeholder = '', okLabel = 'Save', help = '' } = {}) {
  const input = multiline ? h('textarea', { rows: 6, placeholder }) : h('input', { type: 'text', placeholder });
  input.value = value;
  return modal({ title, body: h('div', help && h('p.muted', help), input), actions: [{ label: 'Cancel', value: null }, { label: okLabel, value: () => input.value, kind: 'primary' }] });
}

// ---- sounds (synthesised, no audio files) ----
let actx = null;
function tone(freq, dur, type = 'sine', gain = 0.08, when = 0) {
  if (!state.settings.sound) return;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    const t = actx.currentTime + when;
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur);
  } catch { /* audio unavailable */ }
}
export const sfx = {
  move: () => tone(220, 0.07, 'triangle', 0.12),
  capture: () => { tone(160, 0.09, 'square', 0.06); tone(320, 0.05, 'triangle', 0.08, 0.02); },
  good: () => { tone(660, 0.09, 'sine', 0.07); tone(880, 0.14, 'sine', 0.07, 0.08); },
  bad: () => { tone(200, 0.18, 'sawtooth', 0.05); tone(150, 0.22, 'sawtooth', 0.05, 0.1); },
  done: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'sine', 0.07, i * 0.09)); },
};

export function pct(x, digits = 0) { return (100 * x).toFixed(digits) + '%'; }
export function oneIn(inc) {
  if (!inc || inc <= 0) return '—';
  if (inc >= 0.995) return '1 in 1';
  const n = 1 / inc;
  return '1 in ' + (n < 10 ? (Math.round(n * 10) / 10).toString() : Math.round(n).toLocaleString());
}
export function fmtCount(n) {
  if (n == null) return '';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(n);
}
export function relTime(ts) {
  const d = ts - Date.now();
  if (!isFinite(d)) return '—';
  if (d <= 0) return 'now';
  const m = d / 60e3;
  if (m < 60) return `${Math.max(1, Math.round(m))} min`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h`;
  const days = Math.round(m / 60 / 24);
  return days === 1 ? '1 day' : `${days} days`;
}
export function progressBar(frac, { goal = null, cls = '' } = {}) {
  return h('div.pbar', { class: cls }, h('div.pbar-fill', { style: { width: Math.max(0, Math.min(100, frac * 100)) + '%' } }), goal != null && h('div.pbar-goal', { style: { left: goal * 100 + '%' } }));
}
// White / draw / black result bar from the mover's perspective data.
export function resultBar(st) {
  if (!st || !st.total) return h('div.rbar.empty');
  const w = st.white / st.total, d = st.draws / st.total, b = st.black / st.total;
  return h('div.rbar', { title: `White wins ${pct(w)} · draws ${pct(d)} · Black wins ${pct(b)} (${st.total.toLocaleString()} games)` },
    h('span.w', { style: { width: w * 100 + '%' } }, w > 0.18 ? Math.round(w * 100) : ''),
    h('span.d', { style: { width: d * 100 + '%' } }),
    h('span.b', { style: { width: b * 100 + '%' } }, b > 0.18 ? Math.round(b * 100) : ''));
}
export function download(filename, text, type = 'text/plain') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
export function pickFile(accept) {
  return new Promise(resolve => {
    const i = h('input', { type: 'file', accept, onchange: async () => resolve(i.files[0] ? await i.files[0].text() : null) });
    i.click();
  });
}
