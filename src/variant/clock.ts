// The game clock. Every cooldown is measured on it, never on wall time, so the whole game can
// pause (a dialog in a local game, a disconnected player online) and every `readyAt` stays valid.
//
// A clock is plain data: `base` is the game time at the moment it was last started or stopped,
// `anchor` is the wall time of that moment while it runs, or null while it is paused. The wall
// time is whatever the owner passes in (Date.now() on the server, performance.now() in a local
// game, a counter in tests); the functions here never read a real clock.

import { START_COUNTDOWN_MS } from "./interpretation";

export type GameClock = {
  base: number;
  anchor: number | null;
};

// A running clock that reaches zero (both sides go live) after the start countdown.
export function startClock(wallNow: number, countdownMs: number = START_COUNTDOWN_MS): GameClock {
  return { base: -countdownMs, anchor: wallNow };
}

// A stopped clock at the start of the countdown.
export function idleClock(countdownMs: number = START_COUNTDOWN_MS): GameClock {
  return { base: -countdownMs, anchor: null };
}

export function clockNow(clock: GameClock, wallNow: number): number {
  return clock.anchor === null ? clock.base : clock.base + (wallNow - clock.anchor);
}

export function isRunning(clock: GameClock): boolean {
  return clock.anchor !== null;
}

export function pauseClock(clock: GameClock, wallNow: number): GameClock {
  return clock.anchor === null ? clock : { base: clockNow(clock, wallNow), anchor: null };
}

export function resumeClock(clock: GameClock, wallNow: number): GameClock {
  return clock.anchor === null ? { base: clock.base, anchor: wallNow } : clock;
}

// The wall time at which the game clock will read `gameTime` (for example a piece's readyAt).
// Null while the clock is paused: nothing becomes ready until it resumes.
export function wallTimeOf(clock: GameClock, gameTime: number): number | null {
  return clock.anchor === null ? null : clock.anchor + (gameTime - clock.base);
}

// "0:07", "12:40". Times before the start are shown as 0:00.
export function formatClock(gameTime: number): string {
  const seconds = Math.max(0, Math.floor(gameTime / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
