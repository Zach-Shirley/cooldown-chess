// The Cooldown Chess bot: a real-time agent, not a turn-based search.
//
// There are no turns to search over, so the bot scores the position it would be in after each
// move it could play right now (one move ahead) with an evaluation that understands cooldowns:
// a piece is "lost" when an enemy attacker will be ready before the piece can move away, and a
// king in that state is the end of the game. It then plays the best-scoring move, or waits.
//
// Difficulty is mostly timing. Each level has a reaction delay (the bot decides from the board
// as it was that long ago) and a minimum gap between its own moves. BotAgent.tick() is one
// decision: well under a millisecond, called a few times a second, so it never blocks the page.
import {
  cooldownLeft,
  findKing,
  getAttackers,
  getMoves,
  listPieces,
  makeMove,
  opponentOf,
  type GameState,
  type Move,
  type PieceKind,
  type Player
} from "./game";

export type BotLevel = "easy" | "medium" | "hard";

export const BOT_LEVELS: Record<BotLevel, { label: string; description: string }> = {
  easy: { label: "Easy", description: "Slow hands. Leaves pieces hanging." },
  medium: { label: "Medium", description: "Steady pace. Punishes loose pieces." },
  hard: { label: "Hard", description: "Fast and dangerous. Guard your king." }
};

export type LevelSettings = {
  // The bot decides from the board as it was this long ago.
  reactionMs: number;
  // Minimum time between two of its own moves (varied by +-20% each time).
  minGapMs: number;
  // Random score noise, in centipawns, so weaker bots pick imperfect moves.
  noise: number;
  // Chance that a decision is a random ready move instead of the best one.
  blunderChance: number;
  // How much of the danger to its own pieces it notices (1 = all of it).
  riskAwareness: number;
  // Taking a king and saving its own king skip the minimum gap.
  urgentSkipsGap: boolean;
};

export const LEVEL_SETTINGS: Record<BotLevel, LevelSettings> = {
  easy: { reactionMs: 1000, minGapMs: 2400, noise: 160, blunderChance: 0.2, riskAwareness: 0.35, urgentSkipsGap: false },
  medium: { reactionMs: 480, minGapMs: 1100, noise: 40, blunderChance: 0.02, riskAwareness: 0.9, urgentSkipsGap: true },
  hard: { reactionMs: 150, minGapMs: 330, noise: 6, blunderChance: 0, riskAwareness: 1, urgentSkipsGap: true }
};

// How often the page (or a simulation) should call BotAgent.tick().
export const BOT_TICK_MS = 90;

export const PIECE_VALUE: Record<PieceKind, number> = {
  pawn: 100,
  knight: 320,
  bishop: 330,
  rook: 500,
  queen: 900,
  king: 0
};

// A king that will be captured before it can move.
const KING_LOST = 20_000;
// A king that is attacked but still has time to step away.
const KING_PRESSURE = 250;
// The reaction time the bot assumes its opponent has.
const OPPONENT_REACTION_MS = 400;

// Small placement bonuses: develop the minor pieces, push pawns, keep the king at home.
function placement(kind: PieceKind, player: Player, row: number, col: number): number {
  const advance = player === "white" ? 7 - row : row;
  const centre = 3.5 - Math.max(Math.abs(row - 3.5), Math.abs(col - 3.5));
  switch (kind) {
    case "pawn":
      return advance * 7 + (col >= 2 && col <= 5 ? advance * 3 : 0);
    case "knight":
    case "bishop":
      return (advance > 0 ? 22 : 0) + centre * 7;
    case "queen":
      return centre * 2;
    case "king":
      return -advance * 28;
    default:
      return 0;
  }
}

// The position's worth to `me` at game time `now`, in centipawns: material, placement, and what
// each side is about to lose given who is ready when.
export function evaluate(state: GameState, me: Player, now: number, settings: LevelSettings = LEVEL_SETTINGS.hard): number {
  let score = 0;
  for (const { piece, square } of listPieces(state)) {
    const mine = piece.player === me;
    const sign = mine ? 1 : -1;
    score += sign * (PIECE_VALUE[piece.kind] + placement(piece.kind, piece.player, square.row, square.col));

    const attackers = getAttackers(state, square, opponentOf(piece.player));
    if (attackers.length === 0) continue;
    let threatIn = Infinity;
    let cheapest = Infinity;
    for (const attacker of attackers) {
      threatIn = Math.min(threatIn, Math.max(0, attacker.piece.readyAt - now));
      cheapest = Math.min(cheapest, PIECE_VALUE[attacker.piece.kind]);
    }
    const escapeIn = Math.max(0, piece.readyAt - now) + (mine ? settings.reactionMs : OPPONENT_REACTION_MS);
    const trapped = threatIn <= escapeIn;

    if (piece.kind === "king") {
      // Its own king in danger outweighs everything; a threat to the enemy king is worth half
      // as much when it is real, and little when the king can simply step away.
      if (mine) score -= trapped ? KING_LOST : KING_PRESSURE;
      else score += trapped ? KING_LOST * 0.5 : KING_PRESSURE * 0.2;
      continue;
    }
    const defended = getAttackers(state, square, piece.player).length > 0;
    let loss = defended ? Math.max(0, PIECE_VALUE[piece.kind] - cheapest) : PIECE_VALUE[piece.kind];
    // It can still step away in time, but it is under pressure.
    if (!trapped) loss *= 0.15;
    score -= sign * loss * (mine ? settings.riskAwareness : 0.7);
  }
  return score;
}

export type BotChoice = {
  moveId: string;
  // Taking a king, or saving its own.
  urgent: boolean;
};

// Picks a move for `player` from `state` at game time `now`, or null to wait.
export function chooseBotMove(
  state: GameState,
  player: Player,
  now: number,
  level: BotLevel,
  random: () => number = Math.random
): BotChoice | null {
  const settings = LEVEL_SETTINGS[level];
  const moves = getMoves(state, player, now);
  if (moves.length === 0) return null;

  const kingCapture = moves.find((move) => capturesKing(state, move));
  if (kingCapture) return { moveId: kingCapture.id, urgent: true };

  const baseline = evaluate(state, player, now, settings);
  // Its own king is about to be taken: nothing else matters, and nothing is left to chance.
  const kingInDanger = isKingTrapped(state, player, now, settings.reactionMs);

  if (!kingInDanger && random() < settings.blunderChance) {
    return { moveId: moves[Math.floor(random() * moves.length)].id, urgent: false };
  }

  let best: Move | null = null;
  let bestScore = -Infinity;
  for (const move of moves) {
    const next = makeMove(state, move, now);
    const noise = kingInDanger ? 0 : (random() - 0.5) * 2 * settings.noise;
    const score = evaluate(next, player, now, settings) - baseline + noise;
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  // Waiting is a move too: only act when something actually gets better.
  if (!best || bestScore <= 1) return null;
  return { moveId: best.id, urgent: kingInDanger };
}

function capturesKing(state: GameState, move: Move) {
  return move.captures.some((capture) => state.board[capture.row][capture.col]?.kind === "king");
}

// True when an enemy piece that attacks `player`'s king will be ready before the king can move
// (allowing `reactionMs` for the player to notice).
export function isKingTrapped(state: GameState, player: Player, now: number, reactionMs: number): boolean {
  const king = findKing(state, player);
  if (!king) return false;
  const escapeIn = cooldownLeft(state.board[king.row][king.col]!, now) + reactionMs;
  return getAttackers(state, king, opponentOf(player)).some((attacker) => cooldownLeft(attacker.piece, now) <= escapeIn);
}

// One bot playing one side of one game. Feed it the current state on every tick; it answers
// with a move id to play now, or null. Time is the game clock, so it pauses with the game.
export class BotAgent {
  private readonly settings: LevelSettings;
  // States the bot has been shown, oldest first, with the time each becomes "seen".
  private history: { seenAt: number; state: GameState }[] = [];
  private latest: GameState | null = null;
  private nextMoveAt = -Infinity;

  constructor(
    readonly player: Player,
    readonly level: BotLevel,
    private readonly random: () => number = Math.random
  ) {
    this.settings = LEVEL_SETTINGS[level];
  }

  tick(state: GameState, now: number): string | null {
    if (state !== this.latest) {
      this.latest = state;
      // The bot knows its own moves at once; everything else takes its reaction time to register.
      const own = state.moveLog[state.moveLog.length - 1]?.player === this.player;
      const previous = this.history[this.history.length - 1]?.seenAt ?? -Infinity;
      this.history.push({ seenAt: Math.max(previous, own ? now : now + this.settings.reactionMs), state });
    }
    if (state.status.phase !== "playing" || now < 0) return null;

    while (this.history.length > 1 && this.history[1].seenAt <= now) this.history.shift();
    const view = this.history[0];
    // Nothing but the starting position is known before the first reaction time has passed.
    if (view.seenAt > now && view.state.moveLog.length > 0) return null;

    const choice = chooseBotMove(view.state, this.player, now, this.level, this.random);
    if (!choice) return null;
    if (now < this.nextMoveAt && !(choice.urgent && this.settings.urgentSkipsGap)) return null;
    // The board may have changed since the view was taken; a move that no longer exists is dropped.
    if (!getMoves(state, this.player, now).some((move) => move.id === choice.moveId)) return null;

    this.nextMoveAt = now + this.settings.minGapMs * (0.8 + this.random() * 0.4);
    return choice.moveId;
  }
}
