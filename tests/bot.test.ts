import { describe, expect, it } from "vitest";
import { BOT_TICK_MS, BotAgent, LEVEL_SETTINGS, chooseBotMove, evaluate, isKingTrapped, type BotLevel } from "../src/bot";
import { applyMove, createInitialState, fromFen, getMoves, type GameState, type Player } from "../src/game";

// A small seeded generator so every bot decision in these tests is repeatable.
function seeded(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

// Plays two bots against each other on a simulated game clock (no real waiting).
function simulate(white: BotLevel, black: BotLevel, seed: number, cooldownMs = 3000, maxMs = 240_000) {
  const random = seeded(seed);
  const agents = { white: new BotAgent("white", white, random), black: new BotAgent("black", black, random) };
  let state = createInitialState({ cooldownMs });
  let now = -500;
  for (; now < maxMs && state.status.phase === "playing"; now += BOT_TICK_MS / 2) {
    // Alternate who is asked first so neither side gets the earlier slot every tick.
    const order: Player[] = Math.floor(now / BOT_TICK_MS) % 2 === 0 ? ["white", "black"] : ["black", "white"];
    for (const player of order) {
      const moveId = agents[player].tick(state, now);
      if (moveId) state = applyMove(state, player, moveId, now);
    }
  }
  return { state, now };
}

describe("bot decisions", () => {
  it("takes a king that can be captured, at every level", () => {
    const state = fromFen("4k3/8/8/8/8/8/4q3/R3K3");
    for (const level of ["easy", "medium", "hard"] as const) {
      expect(chooseBotMove(state, "black", 0, level, seeded(3))).toEqual({ moveId: "e2e1", urgent: true });
      expect(chooseBotMove(state, "white", 0, level, seeded(3))).toMatchObject({ moveId: "e1e2" });
    }
  });

  it("moves an attacked king out of danger, or removes the attacker", () => {
    // The rook attacks the king down the e-file and is ready.
    const attacked = fromFen("4k3/8/8/8/4r3/8/8/3QK3");
    expect(isKingTrapped(attacked, "white", 0, 150)).toBe(true);
    for (const level of ["easy", "medium", "hard"] as const) {
      const choice = chooseBotMove(attacked, "white", 0, level, seeded(11));
      expect(choice?.urgent).toBe(true);
      const next = applyMove(attacked, "white", choice!.moveId, 0);
      expect(isKingTrapped(next, "white", 0, 150)).toBe(false);
    }
    // When the attacker can simply be taken, that is the answer.
    const takeable = fromFen("7k/8/8/8/Q3r3/8/8/4K3");
    expect(chooseBotMove(takeable, "white", 0, "hard", seeded(1))).toEqual({ moveId: "a4e4", urgent: true });
  });

  it("knows a cooling attacker is not yet a threat, and when it becomes one", () => {
    let state = fromFen("4k3/8/8/8/7r/8/8/4K3", { cooldownMs: 5000 });
    state = applyMove(state, "black", "h4e4", 0);
    // The rook needs 5 s; the king is ready and has time.
    expect(isKingTrapped(state, "white", 100, 150)).toBe(false);
    // With 100 ms left on the rook, a 150 ms reaction is too slow: now it is urgent.
    expect(isKingTrapped(state, "white", 4900, 150)).toBe(true);
    const choice = chooseBotMove(state, "white", 4900, "hard", seeded(5));
    expect(choice?.urgent).toBe(true);
    expect(choice?.moveId.startsWith("e1")).toBe(true);
  });

  it("grabs free material and prefers the bigger prize", () => {
    const state = fromFen("4k3/8/8/3q4/8/2n5/1P6/4K1B1 -");
    // The pawn can take the knight; nothing defends it.
    expect(chooseBotMove(state, "white", 0, "hard", seeded(2))?.moveId).toBe("b2c3");
    const queen = fromFen("4k3/8/8/3q4/8/2n1B3/1P6/4K3 -");
    const both = fromFen("4k3/8/8/8/3q4/2n1B3/1P6/4K3 -");
    expect(chooseBotMove(queen, "white", 0, "hard", seeded(2))?.moveId).toBe("b2c3");
    expect(chooseBotMove(both, "white", 0, "hard", seeded(2))?.moveId).toBe("e3d4");
  });

  it("does not move onto a square a ready enemy piece attacks, but will if that piece is cooling long enough", () => {
    // The pawn on d5 is defended by the pawn on e6.
    const defended = fromFen("4k3/8/4p3/3p4/8/8/8/3QK3 -");
    expect(chooseBotMove(defended, "white", 0, "hard", seeded(4))?.moveId).not.toBe("d1d5");
    const loose = fromFen("4k3/8/8/3p4/8/8/8/3QK3 -");
    expect(chooseBotMove(loose, "white", 0, "hard", seeded(4))?.moveId).toBe("d1d5");
    // Evaluation: a queen standing where a ready pawn can take it is worth far less.
    const hanging = fromFen("4k3/8/4p3/3Q4/8/8/8/4K3 -");
    const safe = fromFen("4k3/8/4p3/8/3Q4/8/8/4K3 -");
    expect(evaluate(safe, "white", 0) - evaluate(hanging, "white", 0)).toBeGreaterThan(500);
  });

  it("only ever returns a move that is legal right now", () => {
    const random = seeded(9);
    let state = createInitialState();
    let now = 0;
    for (let step = 0; step < 300 && state.status.phase === "playing"; step += 1, now += 120) {
      const player: Player = step % 2 === 0 ? "white" : "black";
      const choice = chooseBotMove(state, player, now, step % 3 === 0 ? "easy" : "hard", random);
      if (!choice) continue;
      expect(getMoves(state, player, now).map((move) => move.id)).toContain(choice.moveId);
      state = applyMove(state, player, choice.moveId, now);
    }
    expect(state.moveLog.length).toBeGreaterThan(30);
  });
});

describe("the bot as a real-time agent", () => {
  it("waits for the countdown, then respects its reaction time and minimum gap", () => {
    for (const level of ["easy", "medium", "hard"] as const) {
      const settings = LEVEL_SETTINGS[level];
      const agent = new BotAgent("black", level, seeded(21));
      let state: GameState = createInitialState();
      const times: number[] = [];
      for (let now = -3000; now < 20_000; now += 30) {
        const moveId = agent.tick(state, now);
        if (!moveId) continue;
        expect(now).toBeGreaterThanOrEqual(0);
        state = applyMove(state, "black", moveId, now);
        // Taking the king skips the gap (and ends the game), so it is not part of this check.
        if (state.status.phase !== "playing") break;
        times.push(now);
      }
      expect(times.length).toBeGreaterThan(2);
      const gaps = times.slice(1).map((time, index) => time - times[index]);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(settings.minGapMs * 0.8 - 30);
    }
  });

  it("is faster at higher levels", () => {
    const count = (level: BotLevel) => {
      const agent = new BotAgent("white", level, seeded(8));
      let state: GameState = createInitialState();
      for (let now = 0; now < 12_000; now += 45) {
        const moveId = agent.tick(state, now);
        if (moveId) state = applyMove(state, "white", moveId, now);
      }
      return state.moveLog.length;
    };
    const [easy, medium, hard] = [count("easy"), count("medium"), count("hard")];
    expect(easy).toBeLessThan(medium);
    expect(medium).toBeLessThan(hard);
    expect(easy).toBeLessThanOrEqual(7);
  });

  it("notices a capturable king only after its reaction time, and medium and hard then take it at once", () => {
    for (const level of ["medium", "hard"] as const) {
      const reaction = LEVEL_SETTINGS[level].reactionMs;
      const agent = new BotAgent("black", level, seeded(13));
      // Black's rook is ready on the e-file; White's king stands safely on d1.
      const before = fromFen("4k3/8/8/8/4r3/8/3P4/3K4");
      agent.tick(before, 0);
      agent.tick(before, 900);
      // At 1000 ms White blunders onto the rook's file.
      const blundered = applyMove(before, "white", "d1e1", 1000);
      let takenAt: number | null = null;
      for (let now = 1000; now < 4000 && takenAt === null; now += 10) {
        if (agent.tick(blundered, now) === "e4e1") takenAt = now;
      }
      expect(takenAt).not.toBeNull();
      expect(takenAt! - 1000).toBeGreaterThanOrEqual(reaction);
      expect(takenAt! - 1000).toBeLessThanOrEqual(reaction + 10);
    }
  });

  it("decides in well under a millisecond on average", () => {
    const state = applyMove(applyMove(createInitialState(), "white", "e2e4", 0), "black", "d7d5", 0);
    const started = performance.now();
    for (let index = 0; index < 400; index += 1) chooseBotMove(state, "white", 6000, "hard", seeded(index + 1));
    expect((performance.now() - started) / 400).toBeLessThan(2);
  });

  it("hard beats easy over several simulated games", () => {
    const results = [101, 202, 303, 404, 505, 606].map((seed, index) => {
      const hardSide: Player = index % 2 === 0 ? "white" : "black";
      const { state } = hardSide === "white" ? simulate("hard", "easy", seed) : simulate("easy", "hard", seed);
      return state.status.phase === "won" ? (state.status.winner === hardSide ? "hard" : "easy") : "none";
    });
    expect(results.filter((result) => result === "easy")).toHaveLength(0);
    expect(results.filter((result) => result === "hard").length).toBeGreaterThanOrEqual(5);
  });

  it("medium beats easy more often than not", () => {
    const results = [11, 22, 33, 44, 55, 66].map((seed, index) => {
      const side: Player = index % 2 === 0 ? "white" : "black";
      const { state } = side === "white" ? simulate("medium", "easy", seed) : simulate("easy", "medium", seed);
      return state.status.phase === "won" ? (state.status.winner === side ? "medium" : "easy") : "none";
    });
    expect(results.filter((result) => result === "medium").length).toBeGreaterThan(results.filter((result) => result === "easy").length);
  });
});
