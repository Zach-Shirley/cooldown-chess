# Architecture

Cooldown Chess is real-time chess: no turns, a cooldown on each piece after it moves, and a win by capturing the king. This page says where each part lives and how time flows through it.

## Layers

```
src/variant/interpretation.ts  every rule decision the creator left open, as named constants
src/variant/clock.ts           the game clock: plain data, pausable, never reads a real clock
src/game.ts                    rules engine (pure TypeScript, time passed in as `now`)
src/bot.ts                     real-time bot: evaluation + BotAgent (reaction delay, move gap)
server/rules.ts                the rules surface the room server uses (thin adapter)
server/game-server.ts          rooms, matchmaking, reconnects, chat, and the authoritative clock
src/multiplayer/               protocol types, socket client, name generator
src/ui/realtime.ts             clock view, re-render scheduler, animations, sounds, selection
src/ui/                        board, pieces with cooldown rings, bars, feed, dialogs, pickers
src/components/                the three screens: home, local (bot / same screen), online
src/theme/                     all CSS; tokens.css holds every design token
art/                           3D studio that renders the sprites, hero and icon source
scripts/                       browser end-to-end checks and screenshots
```

## Time

There are three kinds of time, and they are kept apart on purpose.

- **Wall time** is whatever real clock the owner of a game has: `Date.now()` on the server, `performance.now()` in a local game, a counter in tests.
- **The game clock** (`GameClock` in `clock.ts`) is `{ base, anchor }`: the game time when it was last started or stopped, and the wall time of that moment (null while paused). `clockNow(clock, wallNow)` reads it. It starts at `-START_COUNTDOWN_MS` and the game is live from 0.
- **`now`** is a game-clock reading passed into the engine.

Every `readyAt` is a game-clock time. Pausing the clock therefore freezes every cooldown without touching a single piece, and resuming continues them. `wallTimeOf(clock, readyAt)` gives the real moment a piece becomes ready (null while paused).

## The rules engine (`src/game.ts`)

`GameState` is plain JSON (the server sends it to both clients as-is):

| Field | Meaning |
|---|---|
| `board` | 8×8 array of `Piece \| null`. Row 0 is rank 8, column 0 is the a-file. |
| `rules` | `{ cooldownMs }`, one of 3000, 5000, 7000, 12000 |
| `moveLog` | one `MoveLogEntry` per move with its game time `at` and its `notation` |
| `status` | `playing`, `won` (`king-captured` or `resignation`) or `draw` (`bare-kings`) |

There is no `currentPlayer`. A `Piece` is `{ id, player, kind, readyAt, moved, enPassantUntil }`: `moved` is what castling checks, and `enPassantUntil` is set on a pawn that just advanced two squares.

| Function | What it does |
|---|---|
| `getMoves(state, player, now)` | moves of the pieces that are ready; empty before 0 and after the game ends |
| `getMovesIgnoringCooldown(state, player, now)` | how pieces move regardless of cooldown (the UI's lined-up moves, the bot's view) |
| `tryMove(state, player, moveId, now)` | never throws: `{ ok, state }` or `{ ok: false, reason, readyInMs? }` |
| `applyMove(state, player, moveId, now)` | the same, throwing on an illegal move |
| `makeMove(state, move, now)` | the raw board change with cooldowns, no log or status (the bot's look-ahead) |
| `getAttackers`, `isSquareAttacked`, `getKingInDanger` | attack queries; the last is the UI's king warning |
| `fromFen(placement [castling], rules)` | builds a position for tests |

Move ids are origin and destination (`"e2e4"`). Promotion is automatic, so there is no suffix. There is no legality filter: piece movement is the whole of move generation.

To change a rule decision, edit the constant in `src/variant/interpretation.ts`. Most are read directly by the engine (castling, the en passant window, the promotion piece, what starts a cooldown, the bare-kings draw, the countdown, pause on disconnect, the king-warning lead time). Three describe structure rather than a switch and say so in their comments: enforced piece movement, arrival-order conflict resolution, and the absence of premoves.

## The server (`server/game-server.ts`)

Each room has a `GameState` and a `GameClock`. The clock runs exactly while a game is in progress and both players are connected (`syncClock`).

A `room:move` intent is handled in this order: membership, rate limit (token bucket per socket), both seats filled, game still on, clock running, then `tryMove(room.game, player, moveId, clockNow(room.clock, wallNow()))`. Node processes socket events one at a time, so arrival order is the order of application. A refusal is acknowledged with `{ ok: false, message, reason, readyInMs? }` and changes nothing.

Every `room:state` snapshot carries `clock: { value, running }` and `serverTime`. `clock:sync` answers with the server's wall time for the client's offset estimate.

`createGameServer(httpServer, { now, disconnectGraceMs })` takes the wall clock as an option; the multiplayer tests pass a counter and advance it by hand.

Also here, unchanged from the shell: private rooms, quick match (`sameRules` pairs only equal cooldowns), colour choice, reconnect tokens, the 30-second disconnect grace, rematch votes, quick-message-only chat, generated-name enforcement and private player IDs.

## The client

### Clock views

Screens see the clock as a `ClockView`: `{ now(), running, epoch }`. `epoch` changes whenever the clock is paused, resumed or re-synchronised.

- `useLocalClock` (in `LocalGamePage.tsx`) owns a `GameClock` on `performance.now()` and pauses it for the Pause button, any open dialog, a hidden tab and the end of the game.
- `useServerClock` (in `MultiplayerPage.tsx`) derives the clock from the latest snapshot plus an offset measured by `clock:sync` round trips (the quickest of the last five wins; corrections under 25 ms are ignored).

### Rendering without a frame loop

`useClockTick(state, clock)` returns the game time of the current render and sets one timeout for the next moment the picture changes: a countdown second, a piece becoming ready, the end of a ready flash, or a king warning switching on.

A cooling piece renders a `CooldownRing` (`PieceToken.tsx`): an SVG circle with `animation: cooldown-drain var(--cd-total) linear var(--cd-delay)`. The negative delay is how far into the cooldown the piece already is. `Board` keys each token by `piece.id:readyAt:epoch`, so the values are read again exactly when a cooldown starts or the clock changes; in between, the browser animates alone. While the clock is paused the animation is paused.

During the countdown every piece is "cooling" until 0, so the rings double as the countdown.

### Input

`Board` reports pointer presses and releases per pointer (`onSquareDown`, `onSquareUp`); the board has `touch-action: none`, so two fingers are two independent pointers. `useSelections` keeps one selection per player at the device (`sides`): one in a bot or online game, two in a same-screen game. A press on a target plays the move; a press on a piece then a release on a target is a drag. A move for a cooling piece is not sent: the piece shakes and shows the time left.

### Screens

- `LocalGamePage`: same screen (both sides) or a bot. Moves go through `tryMove` with the local clock. The bot is a `BotAgent` ticked every `BOT_TICK_MS`.
- `MultiplayerPage`: lobby (with the cooldown picker), waiting room, and `OnlineGame`, which draws the server's state directly and sends intents. Nothing is applied optimistically.

## The bot (`src/bot.ts`)

`evaluate(state, me, now)` is material, small placement bonuses, and exposure: for every attacked piece it compares when the earliest attacker is ready with when the piece could move away (its own cooldown plus a reaction time). A trapped king is worth more than everything else.

`chooseBotMove` takes a capturable king at once, otherwise scores each ready move by the evaluation after it, adds level noise, and returns the best if it is an improvement; otherwise it waits.

`BotAgent.tick(state, now)` adds the timing: it decides from the state as it was `reactionMs` ago (it knows its own moves at once), keeps `minGapMs` between its moves, and at Medium and Hard lets urgent moves (taking a king, saving its own) skip the gap. `LEVEL_SETTINGS` holds the numbers.

## Theme tokens

All colours, radii, fonts, shadows and timings are CSS custom properties in `src/theme/tokens.css`. `--accent*` is the ice-blue brand colour, amber marks selections and the newest move, `--cool-white` and `--cool-black` are the two sides' cooldown colours, and `--danger` is the king warning.

Two things live outside CSS and are kept in step by hand: the board texture (`art/board.mjs`) and the icon colours (`scripts/make-app-icon.mjs`).

## Identity

- name `cooldown-chess`; storage keys prefixed `cooldown-chess:`
- `PRODUCTION_GAME_SERVER_URL` in `src/platform.ts`; service name and client origin in `render.yaml` (the origin is still a placeholder)
- `capacitor.config.ts`, `android/`, `ios/`, `codemagic.yaml`: bundle ID placeholder `com.example.cooldownchess`
- dev ports 4374 (web) and 4375 (game server); the art studio renders on 4191
