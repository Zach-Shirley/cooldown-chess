// Cooldown Chess rules engine. Pure TypeScript: no UI, no DOM, no randomness and no clock of
// its own. Every function that depends on time takes `now`, the game clock in milliseconds
// (src/variant/clock.ts), so the same state, move and time always give the same result.
//
// There are no turns and no check rules. A piece may move whenever the game clock has reached
// its `readyAt`; moving it sets `readyAt` to now + the cooldown. Capturing the king wins.
// The decisions the game's creator did not specify live in src/variant/interpretation.ts.

import {
  AUTO_PROMOTION,
  CASTLING_ALLOWED,
  CASTLING_COOLS_ROOK,
  CASTLING_NEEDS_SAFE_SQUARES,
  COOLDOWN_AFTER_CAPTURE,
  COOLDOWN_AFTER_PROMOTION,
  COOLDOWN_CHOICES_MS,
  DEFAULT_COOLDOWN_MS,
  DRAW_ON_BARE_KINGS,
  EN_PASSANT_WINDOW,
  KING_DANGER_SOON_MS
} from "./variant/interpretation";

export const BOARD_SIZE = 8;

export const PLAYERS = ["white", "black"] as const;
export type Player = (typeof PLAYERS)[number];
export const PIECE_KINDS = ["pawn", "knight", "bishop", "rook", "queen", "king"] as const;
export type PieceKind = (typeof PIECE_KINDS)[number];
export const PROMOTION_KINDS = ["queen", "rook", "bishop", "knight"] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

// row 0 is rank 8 (Black's back rank), row 7 is rank 1. col 0 is the a-file.
export type Square = {
  row: number;
  col: number;
};

export type Piece = {
  // Stable for the whole game, including through promotion.
  id: string;
  player: Player;
  kind: PieceKind;
  // Game-clock time from which this piece may move again. 0 for a piece that has not moved.
  readyAt: number;
  // True once the piece has moved (castling needs an unmoved king and rook).
  moved: boolean;
  // Set on a pawn that just advanced two squares: it can be taken en passant until this time.
  enPassantUntil: number | null;
};

export type Capture = Square & {
  pieceId: string;
};

export type CastleSide = "king" | "queen";

export type Move = {
  // Long algebraic, origin then destination: "e2e4". Unique among a player's moves.
  id: string;
  pieceId: string;
  pieceKind: PieceKind;
  player: Player;
  from: Square;
  to: Square;
  // Zero or one entry. The captured square differs from `to` only for en passant.
  captures: Capture[];
  promotion?: PromotionKind;
  castle?: CastleSide;
  // The rook's half of a castling move.
  rook?: { pieceId: string; from: Square; to: Square };
  enPassant?: boolean;
};

export type MoveLogEntry = {
  // Game-clock time the move was applied at.
  at: number;
  player: Player;
  pieceId: string;
  pieceKind: PieceKind;
  from: Square;
  to: Square;
  captured: PieceKind[];
  // Algebraic notation without check marks (there is no check): "Nbd7", "exd8=Q", "O-O".
  notation: string;
  promotion?: PromotionKind;
  rook?: { pieceId: string; from: Square; to: Square };
};

export type DrawReason = "bare-kings";

export type GameStatus =
  | { phase: "playing"; message: string }
  | { phase: "won"; winner: Player; reason: "king-captured" | "resignation"; message: string }
  | { phase: "draw"; reason: DrawReason; message: string };

// Options a game is created with: the cooldown every piece gets after it moves.
export type GameRules = {
  cooldownMs: number;
};

export const DEFAULT_GAME_RULES: GameRules = { cooldownMs: DEFAULT_COOLDOWN_MS };

// Sanitises rules that came from storage or from another player's client.
export function normalizeRules(rules: unknown): GameRules {
  const value = (rules as { cooldownMs?: unknown } | null | undefined)?.cooldownMs;
  const allowed = (COOLDOWN_CHOICES_MS as readonly number[]).includes(value as number);
  return { cooldownMs: allowed ? (value as number) : DEFAULT_COOLDOWN_MS };
}

export type GameState = {
  board: (Piece | null)[][];
  rules: GameRules;
  moveLog: MoveLogEntry[];
  status: GameStatus;
};

export type LocatedPiece = {
  piece: Piece;
  square: Square;
};

export type AttackOptions = {
  // Which pieces count as attackers. Default: every piece. A piece that cannot attack still blocks.
  canAttack?: (piece: Piece, from: Square, state: GameState) => boolean;
};

// Why a move was refused. The server sends this back to the client that asked.
export type RejectReason = "game-over" | "not-started" | "no-piece" | "cooling" | "illegal";

export type MoveResult =
  | { ok: true; state: GameState; move: Move }
  | { ok: false; reason: RejectReason; readyInMs?: number };

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

export const START_PLACEMENT = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";

const FEN_KINDS: Record<string, PieceKind> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const KIND_LETTERS: Record<PieceKind, string> = { pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k" };

const KNIGHT_OFFSETS: readonly (readonly [number, number])[] = [
  [-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]
];
const DIAGONALS: readonly (readonly [number, number])[] = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ORTHOGONALS: readonly (readonly [number, number])[] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const ALL_DIRECTIONS = [...DIAGONALS, ...ORTHOGONALS];

const SQUARE_NAMES: string[][] = Array.from({ length: BOARD_SIZE }, (_, row) =>
  Array.from({ length: BOARD_SIZE }, (_, col) => `${String.fromCharCode(97 + col)}${BOARD_SIZE - row}`)
);

const PLAYING: GameStatus = { phase: "playing", message: "" };

export function createInitialState(rules: GameRules = DEFAULT_GAME_RULES): GameState {
  return fromFen(START_PLACEMENT, rules);
}

// Builds a position from the piece-placement field of a FEN string (tests and tools use this).
// An optional second field gives castling rights ("KQkq", "-"); without it, kings and rooks on
// their home squares count as unmoved. Every piece starts ready. Piece ids come from the squares.
export function fromFen(fen: string, rules: GameRules = DEFAULT_GAME_RULES): GameState {
  const [placement, second, third] = fen.trim().split(/\s+/);
  // Accept a full FEN too: its second field is the side to move, which this game does not have.
  const castlingField = second === "w" || second === "b" ? third : second;
  const rows = placement.split("/");
  if (rows.length !== BOARD_SIZE) throw new Error(`Invalid FEN board: ${fen}`);

  const board = createEmptyBoard();
  rows.forEach((text, row) => {
    let col = 0;
    for (const char of text) {
      if (/\d/.test(char)) {
        col += Number(char);
        continue;
      }
      const kind = FEN_KINDS[char.toLowerCase()];
      if (!kind || col >= BOARD_SIZE) throw new Error(`Invalid FEN board: ${fen}`);
      const player: Player = char === char.toLowerCase() ? "black" : "white";
      board[row][col] = {
        id: `${player}-${kind}-${SQUARE_NAMES[row][col]}`,
        player,
        kind,
        readyAt: 0,
        moved: !isHomeSquare(kind, player, row, col, castlingField),
        enPassantUntil: null
      };
      col += 1;
    }
    if (col !== BOARD_SIZE) throw new Error(`Invalid FEN board: ${fen}`);
  });

  const state: GameState = { board, rules: normalizeRules(rules), moveLog: [], status: PLAYING };
  return { ...state, status: evaluateStatus(state) };
}

function isHomeSquare(kind: PieceKind, player: Player, row: number, col: number, castling: string | undefined) {
  const homeRow = player === "white" ? BOARD_SIZE - 1 : 0;
  const has = (letter: string) =>
    castling === undefined || castling.includes(player === "white" ? letter.toUpperCase() : letter);
  if (kind === "king") return row === homeRow && col === 4 && (has("k") || has("q"));
  if (kind === "rook") return row === homeRow && ((col === 0 && has("q")) || (col === BOARD_SIZE - 1 && has("k")));
  if (kind === "pawn") return row === (player === "white" ? BOARD_SIZE - 2 : 1);
  return row === homeRow;
}

// The piece placement as a FEN field, for tests and debugging.
export function toPlacement(state: GameState): string {
  return state.board
    .map((row) => {
      let text = "";
      let empty = 0;
      for (const piece of row) {
        if (!piece) {
          empty += 1;
          continue;
        }
        if (empty) text += empty;
        empty = 0;
        const letter = KIND_LETTERS[piece.kind];
        text += piece.player === "white" ? letter.toUpperCase() : letter;
      }
      return empty ? text + empty : text;
    })
    .join("/");
}

// ---------------------------------------------------------------------------------------------
// Piece movement
// ---------------------------------------------------------------------------------------------

type MoveGenOptions = {
  // Only pieces that are ready at this time move. Undefined: cooldowns are ignored.
  readyAt?: number;
  // The time used for the en passant window. Undefined: any pawn that still carries its mark.
  now?: number;
};

function addPieceMoves(state: GameState, piece: Piece, row: number, col: number, options: MoveGenOptions, out: Move[]) {
  if (options.readyAt !== undefined && options.readyAt < piece.readyAt) return;
  switch (piece.kind) {
    case "pawn":
      addPawnMoves(state, piece, row, col, options, out);
      break;
    case "knight":
      addStepMoves(state, piece, row, col, KNIGHT_OFFSETS, out);
      break;
    case "bishop":
      addSlideMoves(state, piece, row, col, DIAGONALS, out);
      break;
    case "rook":
      addSlideMoves(state, piece, row, col, ORTHOGONALS, out);
      break;
    case "queen":
      addSlideMoves(state, piece, row, col, ALL_DIRECTIONS, out);
      break;
    case "king":
      addStepMoves(state, piece, row, col, ALL_DIRECTIONS, out);
      addCastlingMoves(state, piece, row, col, options, out);
      break;
  }
}

function makeMoveRecord(
  piece: Piece,
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number,
  captured: Piece | null
): Move {
  return {
    id: SQUARE_NAMES[fromRow][fromCol] + SQUARE_NAMES[toRow][toCol],
    pieceId: piece.id,
    pieceKind: piece.kind,
    player: piece.player,
    from: { row: fromRow, col: fromCol },
    to: { row: toRow, col: toCol },
    captures: captured ? [{ row: toRow, col: toCol, pieceId: captured.id }] : []
  };
}

function addStepMoves(
  state: GameState,
  piece: Piece,
  row: number,
  col: number,
  offsets: readonly (readonly [number, number])[],
  out: Move[]
) {
  for (const [dr, dc] of offsets) {
    const r = row + dr;
    const c = col + dc;
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) continue;
    const target = state.board[r][c];
    if (!target || target.player !== piece.player) out.push(makeMoveRecord(piece, row, col, r, c, target));
  }
}

function addSlideMoves(
  state: GameState,
  piece: Piece,
  row: number,
  col: number,
  directions: readonly (readonly [number, number])[],
  out: Move[]
) {
  for (const [dr, dc] of directions) {
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE) {
      const target = state.board[r][c];
      if (target) {
        if (target.player !== piece.player) out.push(makeMoveRecord(piece, row, col, r, c, target));
        break;
      }
      out.push(makeMoveRecord(piece, row, col, r, c, null));
      r += dr;
      c += dc;
    }
  }
}

function addPawnMoves(state: GameState, piece: Piece, row: number, col: number, options: MoveGenOptions, out: Move[]) {
  const forward = pawnDirection(piece.player);
  const startRow = piece.player === "white" ? BOARD_SIZE - 2 : 1;
  const promotionRow = piece.player === "white" ? 0 : BOARD_SIZE - 1;
  const r = row + forward;
  if (r < 0 || r >= BOARD_SIZE) return;

  const push = (toRow: number, toCol: number, captured: Piece | null) => {
    const move = makeMoveRecord(piece, row, col, toRow, toCol, captured);
    if (toRow === promotionRow) move.promotion = AUTO_PROMOTION;
    out.push(move);
  };

  if (!state.board[r][col]) {
    push(r, col, null);
    if (row === startRow && !state.board[r + forward][col]) push(r + forward, col, null);
  }

  for (const dc of [-1, 1]) {
    const c = col + dc;
    if (c < 0 || c >= BOARD_SIZE) continue;
    const target = state.board[r][c];
    if (target) {
      if (target.player !== piece.player) push(r, c, target);
      continue;
    }
    // En passant: the pawn beside this one double-stepped and its window is still open.
    const victim = state.board[row][c];
    if (
      EN_PASSANT_WINDOW === "while-cooling" &&
      victim &&
      victim.kind === "pawn" &&
      victim.player !== piece.player &&
      victim.enPassantUntil !== null &&
      (options.now === undefined || options.now < victim.enPassantUntil)
    ) {
      const move = makeMoveRecord(piece, row, col, r, c, null);
      move.captures = [{ row, col: c, pieceId: victim.id }];
      move.enPassant = true;
      out.push(move);
    }
  }
}

// Castling: the king and that rook have never moved and the squares between them are empty.
function addCastlingMoves(state: GameState, king: Piece, row: number, col: number, options: MoveGenOptions, out: Move[]) {
  if (!CASTLING_ALLOWED || king.moved) return;
  const homeRow = king.player === "white" ? BOARD_SIZE - 1 : 0;
  if (row !== homeRow || col !== 4) return;
  const boardRow = state.board[row];
  const enemy = opponentOf(king.player);

  const add = (side: CastleSide, rookCol: number, kingTo: number, rookTo: number, empty: number[]) => {
    const rook = boardRow[rookCol];
    if (!rook || rook.kind !== "rook" || rook.player !== king.player || rook.moved) return;
    if (options.readyAt !== undefined && options.readyAt < rook.readyAt) return;
    if (empty.some((c) => boardRow[c])) return;
    if (CASTLING_NEEDS_SAFE_SQUARES && [col, (col + kingTo) / 2, kingTo].some((c) => isSquareAttacked(state, { row, col: c }, enemy))) return;
    const move = makeMoveRecord(king, row, col, row, kingTo, null);
    move.castle = side;
    move.rook = { pieceId: rook.id, from: { row, col: rookCol }, to: { row, col: rookTo } };
    out.push(move);
  };

  add("king", 7, 6, 5, [5, 6]);
  add("queen", 0, 2, 3, [1, 2, 3]);
}

function collectMoves(state: GameState, player: Player, options: MoveGenOptions): Move[] {
  const moves: Move[] = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const piece = state.board[row][col];
      if (piece && piece.player === player) addPieceMoves(state, piece, row, col, options, moves);
    }
  }
  return moves;
}

// The moves `player` may play at game time `now`: those of the pieces that are ready.
// Empty before the start countdown ends (now < 0) and once the game is over.
export function getMoves(state: GameState, player: Player, now: number): Move[] {
  if (state.status.phase !== "playing" || now < 0) return [];
  return collectMoves(state, player, { readyAt: now, now });
}

// How `player`'s pieces move right now, ignoring cooldowns and the start countdown. The UI uses
// this to let a cooling piece be selected and its move lined up; the bot uses it to see threats.
export function getMovesIgnoringCooldown(state: GameState, player: Player, now: number): Move[] {
  if (state.status.phase !== "playing") return [];
  return collectMoves(state, player, { now });
}

export function isReady(piece: Piece, now: number): boolean {
  return now >= piece.readyAt;
}

// Milliseconds until the piece may move (0 when it is ready).
export function cooldownLeft(piece: Piece, now: number): number {
  return Math.max(0, piece.readyAt - now);
}

// ---------------------------------------------------------------------------------------------
// Attacks
// ---------------------------------------------------------------------------------------------

// The pieces of `byPlayer` that attack `square` (could capture a piece standing there), whether
// or not they are ready.
export function getAttackers(state: GameState, square: Square, byPlayer: Player): LocatedPiece[] {
  const { row, col } = square;
  const board = state.board;
  const found: LocatedPiece[] = [];

  for (const [dr, dc] of KNIGHT_OFFSETS) {
    const r = row + dr;
    const c = col + dc;
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) continue;
    const piece = board[r][c];
    if (piece && piece.player === byPlayer && piece.kind === "knight") found.push({ piece, square: { row: r, col: c } });
  }

  // A pawn attacks one row ahead of itself, so the attacker sits one row behind the square.
  const pawnRow = row - pawnDirection(byPlayer);
  if (pawnRow >= 0 && pawnRow < BOARD_SIZE) {
    for (const dc of [-1, 1]) {
      const c = col + dc;
      if (c < 0 || c >= BOARD_SIZE) continue;
      const piece = board[pawnRow][c];
      if (piece && piece.player === byPlayer && piece.kind === "pawn") found.push({ piece, square: { row: pawnRow, col: c } });
    }
  }

  for (let index = 0; index < ALL_DIRECTIONS.length; index += 1) {
    const [dr, dc] = ALL_DIRECTIONS[index];
    const diagonal = index < DIAGONALS.length;
    let r = row + dr;
    let c = col + dc;
    let distance = 1;
    while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE) {
      const piece = board[r][c];
      if (piece) {
        if (piece.player === byPlayer) {
          const slides = piece.kind === "queen" || (diagonal ? piece.kind === "bishop" : piece.kind === "rook");
          if (slides || (distance === 1 && piece.kind === "king")) found.push({ piece, square: { row: r, col: c } });
        }
        break;
      }
      r += dr;
      c += dc;
      distance += 1;
    }
  }

  return found;
}

export function isSquareAttacked(state: GameState, square: Square, byPlayer: Player, options: AttackOptions = {}): boolean {
  const attackers = getAttackers(state, square, byPlayer);
  if (!options.canAttack) return attackers.length > 0;
  return attackers.some(({ piece, square: from }) => options.canAttack?.(piece, from, state));
}

export function findKing(state: GameState, player: Player): Square | null {
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const piece = state.board[row][col];
      if (piece && piece.kind === "king" && piece.player === player) return { row, col };
    }
  }
  return null;
}

// UI aid, not a rule: the square of `player`'s king when an enemy piece that attacks it is ready
// or will be within `soonMs`. Null when the king is safe for now, or the game is not running.
export function getKingInDanger(
  state: GameState,
  player: Player,
  now: number,
  soonMs: number = KING_DANGER_SOON_MS
): Square | null {
  if (state.status.phase !== "playing" || now < 0) return null;
  const king = findKing(state, player);
  if (!king) return null;
  const threatened = isSquareAttacked(state, king, opponentOf(player), {
    canAttack: (piece) => piece.readyAt - now <= soonMs
  });
  return threatened ? king : null;
}

// ---------------------------------------------------------------------------------------------
// Making moves
// ---------------------------------------------------------------------------------------------

// Plays a move with no checks, no move log and no status: the board, the cooldowns, the "moved"
// flags and the en passant mark. The bot uses this to look one move ahead.
export function makeMove(state: GameState, move: Move, now: number): GameState {
  const board = state.board.slice();
  const touch = (row: number) => {
    if (board[row] === state.board[row]) board[row] = board[row].slice();
  };
  const { from, to } = move;
  const piece = state.board[from.row][from.col];
  if (!piece) throw new Error(`No piece on ${squareName(from)}`);

  const cooldown = state.rules.cooldownMs;
  const skipCooldown =
    (move.captures.length > 0 && !COOLDOWN_AFTER_CAPTURE) || (Boolean(move.promotion) && !COOLDOWN_AFTER_PROMOTION);
  const readyAt = skipCooldown ? now : now + cooldown;
  const doubleStep = piece.kind === "pawn" && Math.abs(to.row - from.row) === 2;

  touch(from.row);
  board[from.row][from.col] = null;
  for (const capture of move.captures) {
    touch(capture.row);
    board[capture.row][capture.col] = null;
  }
  touch(to.row);
  board[to.row][to.col] = {
    ...piece,
    kind: move.promotion ?? piece.kind,
    readyAt,
    moved: true,
    enPassantUntil: doubleStep ? readyAt : null
  };

  if (move.rook) {
    const rook = board[move.rook.from.row][move.rook.from.col];
    board[move.rook.from.row][move.rook.from.col] = null;
    board[move.rook.to.row][move.rook.to.col] = rook
      ? { ...rook, moved: true, readyAt: CASTLING_COOLS_ROOK ? now + cooldown : rook.readyAt }
      : null;
  }

  return { ...state, board };
}

// Tries to play `moveId` for `player` at game time `now`. Never throws: an input that is not
// legal at that instant comes back with the reason, and the state is unchanged.
export function tryMove(state: GameState, player: Player, moveId: string, now: number): MoveResult {
  if (state.status.phase !== "playing") return { ok: false, reason: "game-over" };
  if (now < 0) return { ok: false, reason: "not-started" };

  let from: Square;
  try {
    from = parseSquare(String(moveId).slice(0, 2));
  } catch {
    return { ok: false, reason: "illegal" };
  }
  const piece = state.board[from.row][from.col];
  if (!piece || piece.player !== player) return { ok: false, reason: "no-piece" };
  if (!isReady(piece, now)) return { ok: false, reason: "cooling", readyInMs: piece.readyAt - now };

  const pieceMoves: Move[] = [];
  addPieceMoves(state, piece, from.row, from.col, { readyAt: now, now }, pieceMoves);
  const move = pieceMoves.find((candidate) => candidate.id === moveId);
  if (!move) return { ok: false, reason: "illegal" };

  const captured = move.captures
    .map((capture) => state.board[capture.row][capture.col]?.kind)
    .filter((kind): kind is PieceKind => Boolean(kind));

  const entry: MoveLogEntry = {
    at: now,
    player,
    pieceId: move.pieceId,
    pieceKind: move.pieceKind,
    from: move.from,
    to: move.to,
    captured,
    notation: notationFor(state, move, now)
  };
  if (move.promotion) entry.promotion = move.promotion;
  if (move.rook) entry.rook = move.rook;

  const moved = makeMove(state, move, now);
  const next: GameState = { ...moved, moveLog: [...state.moveLog, entry] };
  return { ok: true, state: { ...next, status: evaluateStatus(next) }, move };
}

// Plays one move and returns the new state (the input is not changed). Throws when the move is
// not legal for `player` at `now`; use tryMove to get the reason instead.
export function applyMove(state: GameState, player: Player, moveId: string, now: number): GameState {
  const result = tryMove(state, player, moveId, now);
  if (!result.ok) throw new Error(`Illegal move ${moveId}: ${result.reason}`);
  return result.state;
}

export function resignGame(state: GameState, player: Player): GameState {
  if (state.status.phase !== "playing") return state;
  const winner = opponentOf(player);
  return {
    ...state,
    status: { phase: "won", winner, reason: "resignation", message: `${playerName(winner)} wins by resignation` }
  };
}

export function isGameOver(state: GameState): boolean {
  return state.status.phase !== "playing";
}

// What a player is told when their move was refused.
export function describeReject(reason: RejectReason, readyInMs = 0): string {
  switch (reason) {
    case "game-over":
      return "That game is already over.";
    case "not-started":
      return "Wait for the countdown.";
    case "no-piece":
      return "That piece is gone.";
    case "cooling":
      return `Still cooling down: ${(Math.max(0, readyInMs) / 1000).toFixed(1)} s`;
    case "illegal":
      return "That move is no longer possible.";
  }
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

export function evaluateStatus(state: GameState): GameStatus {
  let whiteKing = false;
  let blackKing = false;
  let others = 0;
  for (const row of state.board) {
    for (const piece of row) {
      if (!piece) continue;
      if (piece.kind !== "king") others += 1;
      else if (piece.player === "white") whiteKing = true;
      else blackKing = true;
    }
  }
  if (!whiteKing || !blackKing) {
    // Positions built for tests may lack a king on both sides; that is simply still "playing".
    if (!whiteKing && !blackKing) return PLAYING;
    const winner: Player = whiteKing ? "white" : "black";
    return { phase: "won", winner, reason: "king-captured", message: `King captured. ${playerName(winner)} wins` };
  }
  if (DRAW_ON_BARE_KINGS && others === 0) {
    return { phase: "draw", reason: "bare-kings", message: "Draw: only the two kings are left" };
  }
  return PLAYING;
}

// ---------------------------------------------------------------------------------------------
// Notation
// ---------------------------------------------------------------------------------------------

const SAN_LETTERS: Record<PieceKind, string> = { pawn: "", knight: "N", bishop: "B", rook: "R", queen: "Q", king: "K" };

function notationFor(state: GameState, move: Move, now: number): string {
  if (move.castle) return move.castle === "king" ? "O-O" : "O-O-O";

  const capture = move.captures.length > 0;
  const destination = SQUARE_NAMES[move.to.row][move.to.col];
  const fromName = SQUARE_NAMES[move.from.row][move.from.col];

  if (move.pieceKind === "pawn") {
    const promotion = move.promotion ? `=${SAN_LETTERS[move.promotion]}` : "";
    return `${capture ? `${fromName[0]}x` : ""}${destination}${promotion}`;
  }

  // Disambiguate when another piece of the same kind could also reach the square (ready or
  // not): by file if that is enough, otherwise by rank, otherwise by both.
  const rivals = collectMoves(state, move.player, { now }).filter(
    (other) =>
      other.pieceId !== move.pieceId &&
      other.pieceKind === move.pieceKind &&
      other.to.row === move.to.row &&
      other.to.col === move.to.col
  );
  let origin = "";
  if (rivals.length > 0) {
    if (!rivals.some((other) => other.from.col === move.from.col)) origin = fromName[0];
    else if (!rivals.some((other) => other.from.row === move.from.row)) origin = fromName[1];
    else origin = fromName;
  }
  return `${SAN_LETTERS[move.pieceKind]}${origin}${capture ? "x" : ""}${destination}`;
}

// ---------------------------------------------------------------------------------------------
// Helpers the UI calls
// ---------------------------------------------------------------------------------------------

export function getPieceAt(state: GameState, square: Square): Piece | null {
  if (!isInside(square)) return null;
  return state.board[square.row][square.col];
}

export function findPiece(state: GameState, pieceId: string): LocatedPiece | null {
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const piece = state.board[row][col];
      if (piece?.id === pieceId) return { piece, square: { row, col } };
    }
  }
  return null;
}

export function listPieces(state: GameState, player?: Player): LocatedPiece[] {
  const pieces: LocatedPiece[] = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const piece = state.board[row][col];
      if (piece && (!player || piece.player === player)) pieces.push({ piece, square: { row, col } });
    }
  }
  return pieces;
}

export function isDarkSquare(square: Square): boolean {
  return (square.row + square.col) % 2 === 1;
}

export function isInside(square: Square): boolean {
  return square.row >= 0 && square.row < BOARD_SIZE && square.col >= 0 && square.col < BOARD_SIZE;
}

export function squareName(square: Square): string {
  return SQUARE_NAMES[square.row][square.col];
}

export function parseSquare(name: string): Square {
  const col = name.charCodeAt(0) - 97;
  const row = BOARD_SIZE - Number(name.slice(1));
  const square = { row, col };
  if (!Number.isInteger(row) || !isInside(square)) throw new Error(`Invalid square: ${name}`);
  return square;
}

export function opponentOf(player: Player): Player {
  return player === "white" ? "black" : "white";
}

export function playerName(player: Player): string {
  return player === "white" ? "White" : "Black";
}

export function pieceName(kind: PieceKind): string {
  return kind;
}

// Rows a pawn of `player` advances per move: White moves up the board (toward row 0).
export function pawnDirection(player: Player): number {
  return player === "white" ? -1 : 1;
}

// Standard material values. The king has none.
export const PIECE_POINTS: Record<PieceKind, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };

export type Material = {
  // Points still on the board for each side.
  score: Record<Player, number>;
  // Enemy pieces each side has captured, as they were when taken.
  captured: Record<Player, PieceKind[]>;
};

export function getMaterial(state: GameState): Material {
  const score: Record<Player, number> = { white: 0, black: 0 };
  for (const row of state.board) {
    for (const piece of row) {
      if (piece) score[piece.player] += PIECE_POINTS[piece.kind];
    }
  }
  const captured: Record<Player, PieceKind[]> = { white: [], black: [] };
  for (const entry of state.moveLog) captured[entry.player].push(...entry.captured);
  return { score, captured };
}

function createEmptyBoard(): (Piece | null)[][] {
  return Array.from({ length: BOARD_SIZE }, () => Array<Piece | null>(BOARD_SIZE).fill(null));
}
