# OpeningForge

A local opening-repertoire builder and trainer for personal use. It runs entirely on your
computer; the only outside traffic is to Lichess (and Chess.com if you import games from there).

## Run it

Requires Node.js 18 or newer.

```bash
npm install
```

```bash
npm start
```

Then open http://127.0.0.1:5173. Set `PORT=…` to use another port.

### Lichess token (needed)

Lichess's opening explorer requires sign-in. Create a personal token (no scopes needed) at
https://lichess.org/account/oauth/token and paste it into **Settings → Lichess API token**
(or start the server with `LICHESS_TOKEN=…`). It is stored only in `data/store.json`.

## What it does

- **Build** — walk your repertoire tree move by move.
  - Opponent's turn: Lichess statistics for players at your rating show each reply's frequency,
    how often the resulting position occurs in your games ("1 in N"), and which replies you
    still need to prepare to reach your **coverage goal** (default 90% per position). Replies
    under a **minimum frequency** are never required; individual moves can be excluded.
  - Your turn: candidates with masters share, peer results and **evaluation** (Lichess cloud
    eval, falling back to a local Stockfish). Moves within your **eval threshold** of the best
    move are marked sound; one is recommended. You always make the final choice.
  - "Go to your biggest gap" (G) jumps to the most frequent unprepared position; Enter saves.
- **Autofill** — optionally fill gaps automatically in a chosen style; undoable, tagged.
- **Practice** — spaced repetition over your moves, hints, retries, daily goal and streak.
- **Model games** — guess-the-move through master / strong online games in your lines.
- **Online games** — scan your Lichess / Chess.com games for deviations from your repertoire,
  unprepared opponent moves, and results by opening.
- Import (PGN with variations, Lichess studies, your own games), PGN export, line browser,
  notes, alternative and disabled moves, multiple repertoires, trim, JSON backup/restore.

## Data

Everything is in `data/`: `store.json` (repertoires, progress, settings; daily copies in
`data/backups/`) and `cache.jsonl` (cached Lichess responses — safe to delete).

## Credits

Uses chess.js, Chessground and Stockfish.js (the latter two GPL-3.0), and data from the
Lichess opening explorer and cloud evaluations.
