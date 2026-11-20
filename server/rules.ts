// Everything the room server needs from the game. The rooms, matchmaking, reconnects and chat
// in game-server.ts are game-agnostic; a different game provides this file's exports.
//
// The engine has no clock of its own: the server owns one game clock per room
// (src/variant/clock.ts), stamps every incoming move with it and passes that time into the
// engine, so the server is the single authority on "is this piece ready yet".
// The state is sent to both clients as-is, so it must stay plain JSON.
export {
  createInitialState,
  describeReject,
  normalizeRules,
  resignGame,
  tryMove,
  type GameRules,
  type GameState,
  type Player
} from "../src/game";
export { clockNow, idleClock, isRunning, pauseClock, resumeClock, type GameClock } from "../src/variant/clock";
export { PAUSE_ON_DISCONNECT } from "../src/variant/interpretation";
import { normalizeRules, type GameRules } from "../src/game";

// Quick match only pairs players who asked for the same rules (the same cooldown length).
export function sameRules(a: GameRules, b: GameRules): boolean {
  return JSON.stringify(normalizeRules(a)) === JSON.stringify(normalizeRules(b));
}
