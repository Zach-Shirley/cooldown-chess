// THIS APP'S INTERPRETATION of real-time chess.
//
// The creator of the game (Xander Naumenko, "I Made Chess Without Turns", From Scratch) states
// four rules: no turns, a per-piece cooldown after each move, a cooling piece can still be
// captured, and you lose when your king is captured. His physical board does not check move
// legality, so everything below is a decision this app made. Each one is a named constant; the
// engine (src/game.ts), the server and the UI read them from here and nowhere else.

import type { PromotionKind } from "../game";

// --- Cooldown length -------------------------------------------------------------------------
// VERIFIED, not interpretation: one value for every piece type. The creator's spoken example is
// 5 seconds; his firmware offers 3, 7 and 12 with 7 as its default. This app offers all four.
export const COOLDOWN_CHOICES_MS = [3_000, 5_000, 7_000, 12_000] as const;
export const DEFAULT_COOLDOWN_MS = 5_000;

// --- Piece movement --------------------------------------------------------------------------
// Pieces move as in chess and the app enforces it. There are no check rules at all: a king may
// move into or stay in attack, and pins do not exist. (Structural: the engine only has the
// piece-movement layer, so this is not a switch.)

// --- Castling --------------------------------------------------------------------------------
// Allowed when the king and that rook have never moved and the squares between them are empty.
export const CASTLING_ALLOWED = true;
// True would add chess's "not out of, through or into attack" conditions. Off: no check rules.
export const CASTLING_NEEDS_SAFE_SQUARES = false;
// The rook goes on cooldown together with the king.
export const CASTLING_COOLS_ROOK = true;

// --- En passant ------------------------------------------------------------------------------
// "while-cooling": a pawn that advanced two squares can be taken en passant only while it is
// still on the cooldown from that double step. "never" removes en passant.
export const EN_PASSANT_WINDOW: "while-cooling" | "never" = "while-cooling";

// --- Promotion -------------------------------------------------------------------------------
// Automatic, because a picker would stop a game that never stops.
export const AUTO_PROMOTION: PromotionKind = "queen";

// --- What starts a cooldown ------------------------------------------------------------------
// A capturing piece and a freshly promoted piece cool down like any other piece that moved.
export const COOLDOWN_AFTER_CAPTURE = true;
export const COOLDOWN_AFTER_PROMOTION = true;

// --- Conflicts -------------------------------------------------------------------------------
// The server applies inputs strictly in arrival order, stamped with its own clock. A move that
// is no longer legal when it arrives (its piece was captured, the square changed, the piece is
// still cooling) is rejected. There is no lag compensation. (Structural, see server/.)
// A rejected move costs nothing: this many milliseconds are added to the piece's cooldown.
export const REJECTED_MOVE_PENALTY_MS = 0;

// --- Premoves --------------------------------------------------------------------------------
// None in this version: a cooling piece can be selected to line a move up, but the move is only
// sent once the piece is ready. (Structural: there is no queue to switch on.)
export const PREMOVES = false;

// --- Draws -----------------------------------------------------------------------------------
// The only automatic draw: both sides are down to a bare king. There is no stalemate, repetition
// or fifty-move rule, and this version has no draw offer.
export const DRAW_ON_BARE_KINGS = true;

// --- Start -----------------------------------------------------------------------------------
// A 3-2-1 countdown, then both sides are live at the same instant. Nobody "moves first".
export const START_COUNTDOWN_MS = 3_000;

// --- Online disconnect -----------------------------------------------------------------------
// The game clock stops (every cooldown freezes) while a seated player is disconnected, for the
// room server's grace period; after that the absent player forfeits.
export const PAUSE_ON_DISCONNECT = true;

// --- UI aid, not a rule ----------------------------------------------------------------------
// With no check, the app pulses your king's square when an enemy piece that attacks it is ready
// or will be ready within this many milliseconds.
export const KING_DANGER_SOON_MS = 1_500;
