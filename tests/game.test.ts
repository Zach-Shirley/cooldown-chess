import { describe, expect, it } from "vitest";
import {
  applyMove,
  createInitialState,
  findPiece,
  fromFen,
  getKingInDanger,
  getMaterial,
  getMoves,
  getMovesIgnoringCooldown,
  getPieceAt,
  normalizeRules,
  parseSquare,
  resignGame,
  toPlacement,
  tryMove,
  type GameState,
  type Player
} from "../src/game";
import {
  clockNow,
  formatClock,
  idleClock,
  isRunning,
  pauseClock,
  resumeClock,
  startClock,
  wallTimeOf
} from "../src/variant/clock";
import { AUTO_PROMOTION, COOLDOWN_CHOICES_MS, DEFAULT_COOLDOWN_MS, START_COUNTDOWN_MS } from "../src/variant/interpretation";

const CD = DEFAULT_COOLDOWN_MS;
const at = (state: GameState, name: string) => getPieceAt(state, parseSquare(name));
const ids = (state: GameState, player: Player, now: number) => getMoves(state, player, now).map((move) => move.id);

describe("no turns", () => {
  it("has no moves during the countdown and twenty for each side the instant it ends", () => {
    const state = createInitialState();
    expect(getMoves(state, "white", -1)).toHaveLength(0);
    expect(tryMove(state, "white", "e2e4", -1)).toEqual({ ok: false, reason: "not-started" });
    expect(getMoves(state, "white", 0)).toHaveLength(20);
    expect(getMoves(state, "black", 0)).toHaveLength(20);
    expect("currentPlayer" in state).toBe(false);
  });

  it("lets both sides move at the same instant, and one side move several pieces in a row", () => {
    let state = createInitialState();
    state = applyMove(state, "black", "e7e5", 0);
    state = applyMove(state, "white", "e2e4", 0);
    state = applyMove(state, "white", "g1f3", 0);
    state = applyMove(state, "white", "d2d4", 1);
    expect(state.moveLog.map((entry) => `${entry.player[0]}:${entry.notation}@${entry.at}`)).toEqual([
      "b:e5@0",
      "w:e4@0",
      "w:Nf3@0",
      "w:d4@1"
    ]);
    expect(toPlacement(state)).toBe("rnbqkbnr/pppp1ppp/8/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R");
  });

  it("refuses to move the other side's piece", () => {
    const state = createInitialState();
    expect(tryMove(state, "white", "e7e5", 0)).toEqual({ ok: false, reason: "no-piece" });
    expect(tryMove(state, "black", "e2e4", 0)).toEqual({ ok: false, reason: "no-piece" });
    expect(tryMove(state, "white", "e2e5", 0)).toEqual({ ok: false, reason: "illegal" });
    expect(tryMove(state, "white", "zz", 0)).toEqual({ ok: false, reason: "illegal" });
  });
});

describe("cooldown", () => {
  it("puts only the moved piece on cooldown for the chosen length", () => {
    const state = applyMove(createInitialState(), "white", "e2e4", 100);
    expect(at(state, "e4")?.readyAt).toBe(100 + CD);
    expect(at(state, "d2")?.readyAt).toBe(0);
    expect(ids(state, "white", 200)).not.toContain("e4e5");
    expect(ids(state, "white", 200)).toContain("d2d4");
    expect(getMovesIgnoringCooldown(state, "white", 200).map((move) => move.id)).toContain("e4e5");
  });

  it("rejects a move before readyAt and accepts it exactly at and after readyAt", () => {
    const state = applyMove(createInitialState(), "white", "e2e4", 0);
    expect(tryMove(state, "white", "e4e5", CD - 1)).toEqual({ ok: false, reason: "cooling", readyInMs: 1 });
    expect(tryMove(state, "white", "e4e5", CD).ok).toBe(true);
    expect(tryMove(state, "white", "e4e5", CD + 1).ok).toBe(true);
    // A rejected move changes nothing and costs nothing.
    expect(at(state, "e4")?.readyAt).toBe(CD);
  });

  it("uses the cooldown length the game was created with", () => {
    for (const cooldownMs of COOLDOWN_CHOICES_MS) {
      const state = applyMove(createInitialState({ cooldownMs }), "white", "g1f3", 40);
      expect(at(state, "f3")?.readyAt).toBe(40 + cooldownMs);
    }
    expect(normalizeRules({ cooldownMs: 7000 })).toEqual({ cooldownMs: 7000 });
    expect(normalizeRules({ cooldownMs: 1 })).toEqual({ cooldownMs: DEFAULT_COOLDOWN_MS });
    expect(normalizeRules(null)).toEqual({ cooldownMs: DEFAULT_COOLDOWN_MS });
    expect(normalizeRules({})).toEqual({ cooldownMs: 5000 });
  });

  it("lets a cooling piece be captured, and the capturing piece cools down too", () => {
    let state = fromFen("4k3/8/8/3p4/4P3/8/8/4K3");
    state = applyMove(state, "black", "d5d4", 0);
    expect(at(state, "d4")?.readyAt).toBe(CD);
    state = fromFen("4k3/8/8/8/3pP3/8/8/3RK3");
    state = applyMove(state, "black", "d4d3", 10);
    // The pawn on d3 is cooling; the rook takes it anyway.
    state = applyMove(state, "white", "d1d3", 20);
    expect(at(state, "d3")).toMatchObject({ kind: "rook", player: "white", readyAt: 20 + CD });
    expect(state.moveLog.at(-1)).toMatchObject({ notation: "Rxd3", captured: ["pawn"], at: 20 });
    expect(getMaterial(state).captured.white).toEqual(["pawn"]);
  });
});

describe("conflicts are resolved in arrival order", () => {
  it("rejects the queued move of a piece that was captured first", () => {
    // White's knight and Black's bishop attack each other's squares; whoever arrives first wins.
    const state = fromFen("4k3/8/8/3b4/8/4N3/8/4K3");
    const afterBlack = applyMove(state, "black", "d5e4", 0);
    const blackFirst = applyMove(state, "white", "e3d5", 0);
    // Black's intent arrives a moment after White took the bishop.
    expect(tryMove(blackFirst, "black", "d5e4", 1)).toEqual({ ok: false, reason: "no-piece" });
    // The other order: the bishop moved away, so White's capture is no longer a capture.
    const whiteSecond = applyMove(afterBlack, "white", "e3d5", 1);
    expect(whiteSecond.moveLog.at(-1)?.captured).toEqual([]);
  });

  it("gives a contested empty square to the first arrival; the second mover captures it", () => {
    const state = fromFen("4k3/8/8/8/R6r/8/8/4K3");
    const first = applyMove(state, "white", "a4d4", 0);
    const second = tryMove(first, "black", "h4d4", 0);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(at(second.state, "d4")).toMatchObject({ player: "black", kind: "rook" });
      expect(second.state.moveLog.at(-1)?.notation).toBe("Rxd4");
    }
  });

  it("rejects the second of two pawns pushing to the same square", () => {
    const state = fromFen("4k3/8/4p3/8/4P3/8/8/4K3");
    const first = applyMove(state, "black", "e6e5", 0);
    expect(tryMove(first, "white", "e4e5", 0)).toEqual({ ok: false, reason: "illegal" });
    const other = applyMove(state, "white", "e4e5", 0);
    expect(tryMove(other, "black", "e6e5", 0)).toEqual({ ok: false, reason: "illegal" });
  });
});

describe("the king", () => {
  it("has no check: a king may stay in attack, move into attack, and pins do not exist", () => {
    // White's king is attacked by the rook; White plays something else, then walks into the queen.
    let state = fromFen("4k3/8/8/8/4r2q/8/3N4/4K3");
    expect(state.status.phase).toBe("playing");
    state = applyMove(state, "white", "d2b3", 0);
    expect(tryMove(state, "white", "e1f2", 0).ok).toBe(true);
  });

  it("ends the game when a king is captured and rejects every later intent", () => {
    let state = fromFen("4k3/8/8/8/4r3/8/8/4K2R");
    state = applyMove(state, "black", "e4e1", 5);
    expect(state.status).toEqual({ phase: "won", winner: "black", reason: "king-captured", message: "King captured. Black wins" });
    expect(state.moveLog.at(-1)).toMatchObject({ notation: "Rxe1", captured: ["king"] });
    expect(tryMove(state, "white", "h1h8", 6)).toEqual({ ok: false, reason: "game-over" });
    expect(tryMove(state, "black", "e8d8", 6)).toEqual({ ok: false, reason: "game-over" });
    expect(getMoves(state, "black", 10_000)).toHaveLength(0);
    expect(resignGame(state, "black")).toBe(state);
  });

  it("can be captured while it is cooling down", () => {
    let state = fromFen("4k3/8/8/8/7r/8/8/4K3");
    state = applyMove(state, "white", "e1e2", 0);
    state = applyMove(state, "black", "h4h2", 0);
    // Both cooled down at the same time; the king is still on the rook's rank and Black is first.
    state = applyMove(state, "black", "h2e2", CD);
    expect(state.status).toMatchObject({ phase: "won", winner: "black", reason: "king-captured" });
  });

  it("flags a king as in danger only when an attacker is ready or nearly ready", () => {
    let state = fromFen("4k3/8/8/8/7r/8/8/4K3");
    expect(getKingInDanger(state, "white", 0)).toBeNull();
    state = applyMove(state, "black", "h4e4", 0);
    // The rook attacks e1 but is cooling for 5 s.
    expect(getKingInDanger(state, "white", 100, 1500)).toBeNull();
    expect(getKingInDanger(state, "white", CD - 1500, 1500)).toEqual(parseSquare("e1"));
    expect(getKingInDanger(state, "white", CD + 10, 1500)).toEqual(parseSquare("e1"));
    expect(getKingInDanger(state, "black", CD + 10, 1500)).toBeNull();
  });

  it("is won by resignation too", () => {
    const state = resignGame(createInitialState(), "white");
    expect(state.status).toMatchObject({ phase: "won", winner: "black", reason: "resignation" });
  });
});

describe("castling", () => {
  const position = "r3k2r/8/8/8/8/8/8/R3K2R";

  it("moves king and rook together and puts both on cooldown", () => {
    let state = fromFen(position);
    expect(ids(state, "white", 0)).toEqual(expect.arrayContaining(["e1g1", "e1c1"]));
    state = applyMove(state, "white", "e1g1", 300);
    expect(at(state, "g1")).toMatchObject({ kind: "king", readyAt: 300 + CD, moved: true });
    expect(at(state, "f1")).toMatchObject({ kind: "rook", readyAt: 300 + CD, moved: true });
    expect(state.moveLog.at(-1)?.notation).toBe("O-O");
    state = applyMove(state, "black", "e8c8", 400);
    expect(at(state, "c8")).toMatchObject({ kind: "king", readyAt: 400 + CD });
    expect(at(state, "d8")).toMatchObject({ kind: "rook", readyAt: 400 + CD });
    expect(state.moveLog.at(-1)?.notation).toBe("O-O-O");
    // The rook that castled cannot move until its cooldown ends.
    expect(tryMove(state, "white", "f1f8", 301)).toMatchObject({ ok: false, reason: "cooling" });
  });

  it("needs an unmoved king and rook and empty squares between them", () => {
    let state = fromFen(position);
    state = applyMove(state, "white", "h1h2", 0);
    state = applyMove(state, "white", "h2h1", CD);
    expect(ids(state, "white", 3 * CD)).not.toContain("e1g1");
    expect(ids(state, "white", 3 * CD)).toContain("e1c1");
    state = applyMove(state, "black", "e8e7", 0);
    state = applyMove(state, "black", "e7e8", CD);
    expect(ids(state, "black", 3 * CD).filter((id) => id === "e8g8" || id === "e8c8")).toEqual([]);
    expect(ids(fromFen("r3k2r/8/8/8/8/8/8/RN2K1NR"), "white", 0).filter((id) => id === "e1g1" || id === "e1c1")).toEqual([]);
    // Castling rights given in the FEN are respected.
    expect(ids(fromFen(`${position} Kq`), "white", 0)).toContain("e1g1");
    expect(ids(fromFen(`${position} Kq`), "white", 0)).not.toContain("e1c1");
  });

  it("has no attack conditions: out of, through and into attack are all allowed", () => {
    const state = fromFen("4kr2/8/8/8/4r1r1/8/8/4K2R");
    expect(tryMove(state, "white", "e1g1", 0).ok).toBe(true);
  });
});

describe("en passant", () => {
  it("is open exactly while the pawn that double-stepped is cooling from that step", () => {
    let state = fromFen("4k3/3p4/8/4P3/8/8/8/4K3");
    state = applyMove(state, "black", "d7d5", 1000);
    expect(at(state, "d5")?.enPassantUntil).toBe(1000 + CD);
    expect(ids(state, "white", 1000)).toContain("e5d6");
    expect(ids(state, "white", 1000 + CD - 1)).toContain("e5d6");
    // The window closes the moment the pawn is ready again.
    expect(ids(state, "white", 1000 + CD)).not.toContain("e5d6");
    expect(tryMove(state, "white", "e5d6", 1000 + CD)).toEqual({ ok: false, reason: "illegal" });

    const taken = applyMove(state, "white", "e5d6", 2000);
    expect(at(taken, "d5")).toBeNull();
    expect(at(taken, "d6")).toMatchObject({ kind: "pawn", player: "white" });
    expect(taken.moveLog.at(-1)).toMatchObject({ notation: "exd6", captured: ["pawn"] });
  });

  it("does not apply to a pawn that advanced one square at a time", () => {
    let state = fromFen("4k3/3p4/8/4P3/8/8/8/4K3");
    state = applyMove(state, "black", "d7d6", 0);
    expect(ids(state, "white", 10)).toContain("e5d6");
    state = fromFen("4k3/8/3p4/4P3/8/8/8/4K3");
    state = applyMove(state, "black", "d6d5", 0);
    expect(ids(state, "white", 10)).not.toContain("e5d6");
  });
});

describe("promotion", () => {
  it("is automatic and the new piece cools down like any piece that moved", () => {
    let state = fromFen("4k3/P7/8/8/8/8/8/4K3");
    const moves = getMoves(state, "white", 0).filter((move) => move.from.col === 0);
    expect(moves).toHaveLength(1);
    expect(moves[0].promotion).toBe(AUTO_PROMOTION);
    state = applyMove(state, "white", "a7a8", 70);
    expect(at(state, "a8")).toMatchObject({ kind: "queen", player: "white", readyAt: 70 + CD });
    expect(state.moveLog.at(-1)).toMatchObject({ notation: "a8=Q", promotion: "queen" });
    // The piece keeps its id through promotion.
    expect(findPiece(state, "white-pawn-a7")?.piece.kind).toBe("queen");
  });
});

describe("draws", () => {
  it("draws when only the two kings are left, and not before", () => {
    let state = fromFen("4k3/8/8/8/8/8/4p3/4K3");
    expect(state.status.phase).toBe("playing");
    state = applyMove(state, "white", "e1e2", 0);
    expect(state.status).toMatchObject({ phase: "draw", reason: "bare-kings" });
    expect(tryMove(state, "black", "e8e7", 1)).toEqual({ ok: false, reason: "game-over" });
  });

  it("has no stalemate: a side with no move simply waits", () => {
    const state = fromFen("7k/5Q2/6K1/8/8/8/8/8");
    expect(state.status.phase).toBe("playing");
  });
});

describe("notation", () => {
  it("disambiguates by file or rank and never adds check marks", () => {
    let state = fromFen("4k3/8/8/8/8/8/8/RN2KN1R");
    state = applyMove(state, "white", "b1d2", 0);
    expect(state.moveLog.at(-1)?.notation).toBe("Nbd2");
    state = fromFen("4k3/4r3/8/8/8/8/4R3/4K3");
    state = applyMove(state, "white", "e2e7", 0);
    expect(state.moveLog.at(-1)?.notation).toBe("Rxe7");
  });
});

describe("the game clock", () => {
  it("counts down to zero, runs, and formats as minutes and seconds", () => {
    const clock = startClock(10_000);
    expect(clockNow(clock, 10_000)).toBe(-START_COUNTDOWN_MS);
    expect(clockNow(clock, 10_000 + START_COUNTDOWN_MS)).toBe(0);
    expect(clockNow(clock, 20_000)).toBe(7000);
    expect(formatClock(7000)).toBe("0:07");
    expect(formatClock(7999)).toBe("0:07");
    expect(formatClock(125_000)).toBe("2:05");
    expect(formatClock(-500)).toBe("0:00");
    expect(isRunning(idleClock())).toBe(false);
  });

  it("pauses and resumes: every readyAt lands later in wall time by exactly the pause", () => {
    let wall = 50_000;
    let clock = resumeClock({ base: 0, anchor: null }, wall);
    let state = createInitialState();
    state = applyMove(state, "white", "e2e4", clockNow(clock, (wall += 1000)));
    state = applyMove(state, "black", "g8f6", clockNow(clock, (wall += 500)));
    const pawn = at(state, "e4")!;
    const knight = at(state, "f6")!;
    expect([pawn.readyAt, knight.readyAt]).toEqual([1000 + CD, 1500 + CD]);
    const before = [wallTimeOf(clock, pawn.readyAt), wallTimeOf(clock, knight.readyAt)];
    expect(before).toEqual([50_000 + 1000 + CD, 50_000 + 1500 + CD]);

    // Pause 2 s into the pawn's cooldown, for 30 s.
    wall = 53_000;
    clock = pauseClock(clock, wall);
    expect(isRunning(clock)).toBe(false);
    expect(wallTimeOf(clock, pawn.readyAt)).toBeNull();
    expect(clockNow(clock, wall + 12_345)).toBe(3000);
    // Nothing becomes ready while paused, however long it lasts.
    expect(tryMove(state, "white", "e4e5", clockNow(clock, wall + 30_000))).toMatchObject({ ok: false, reason: "cooling", readyInMs: CD - 2000 });
    wall += 30_000;
    clock = resumeClock(clock, wall);
    expect([wallTimeOf(clock, pawn.readyAt), wallTimeOf(clock, knight.readyAt)]).toEqual(before.map((time) => time! + 30_000));
    // The pieces themselves are untouched: the same remaining cooldown as when the pause began.
    expect(tryMove(state, "white", "e4e5", clockNow(clock, wall + CD - 2001))).toMatchObject({ ok: false, reason: "cooling", readyInMs: 1 });
    expect(tryMove(state, "white", "e4e5", clockNow(clock, wall + CD - 2000)).ok).toBe(true);
    // Pausing twice or resuming twice changes nothing.
    expect(resumeClock(clock, wall + 99)).toBe(clock);
    const paused = pauseClock(clock, wall + 10);
    expect(pauseClock(paused, wall + 500)).toBe(paused);
  });
});
