// Local Stockfish (WASM, in a Web Worker) used when Lichess has no cloud evaluation for a position.
import { Chess, normUci } from './chessutil.js';

let worker = null, ready = null, busy = Promise.resolve(), failed = false;
const cache = new Map(); // `${fen}|${multiPv}|${depth}` -> result
export const engineStatus = { running: 0, failed: false };

function start() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    try {
      worker = new Worker('/vendor/stockfish.js');
      const onMsg = e => {
        if (String(e.data).startsWith('uciok')) { worker.removeEventListener('message', onMsg); worker.postMessage('setoption name Hash value 64'); resolve(); }
      };
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', e => { failed = engineStatus.failed = true; reject(e); });
      worker.postMessage('uci');
      setTimeout(() => reject(new Error('engine start timeout')), 20000);
    } catch (e) { failed = engineStatus.failed = true; reject(e); }
  });
  return ready;
}

// Returns {depth, pvs:[{uci, cp (white POV), line}]} — same shape as the cloud eval.
export function analyse(fen, { multiPv = 1, depth = 16 } = {}) {
  const key = `${fen}|${multiPv}|${depth}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (failed) return Promise.resolve(null);
  const job = busy.then(async () => {
    if (cache.has(key)) return cache.get(key);
    try { await start(); } catch { return null; }
    engineStatus.running++;
    const white = fen.split(' ')[1] === 'w';
    const chess = new Chess(fen);
    const res = await new Promise(resolve => {
      const pvs = {};
      let d = 0;
      const timer = setTimeout(() => worker.postMessage('stop'), 25000);
      const onMsg = e => {
        const line = String(e.data);
        if (line.startsWith('info') && line.includes(' pv ')) {
          const m = line.match(/depth (\d+).*?multipv (\d+).*?score (cp|mate) (-?\d+).*? pv (.+)$/);
          if (m) {
            const v = +m[4];
            let cp = m[3] === 'cp' ? v : (v > 0 ? 100000 - v : -100000 - v);
            if (!white) cp = -cp;
            d = Math.max(d, +m[1]);
            pvs[m[2]] = { uci: normUci(m[5].split(' ')[0], chess), cp, line: m[5], depth: +m[1] };
          }
        } else if (line.startsWith('bestmove')) {
          clearTimeout(timer);
          worker.removeEventListener('message', onMsg);
          resolve({ depth: d, local: true, pvs: Object.keys(pvs).sort((a, b) => a - b).map(k => pvs[k]) });
        }
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage('setoption name MultiPV value ' + multiPv);
      worker.postMessage('position fen ' + fen);
      worker.postMessage('go depth ' + depth);
    });
    engineStatus.running--;
    if (res.pvs.length) cache.set(key, res);
    return res.pvs.length ? res : null;
  });
  busy = job.catch(() => {});
  return job;
}
