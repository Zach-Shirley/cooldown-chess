// The room server with real Socket.IO clients. The server's wall clock is a counter the tests
// control (`serverNow`), so cooldowns are exercised without any real waiting.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { io as createClient, type Socket } from "socket.io-client";
import { MOVE_BURST, createGameServer } from "../server/game-server";
import { getPieceAt, parseSquare } from "../src/game";
import type {
  ClientToServerEvents,
  CreateRoomPayload,
  JoinRoomPayload,
  MatchmakingPayload,
  PlayerSession,
  QueueResult,
  RoomConnection,
  RoomSnapshot,
  ServerResponse,
  ServerToClientEvents
} from "../src/multiplayer/protocol";

type TestClient = Socket<ServerToClientEvents, ClientToServerEvents>;
type GameServer = ReturnType<typeof createGameServer>;

const CD = 5000;
const COUNTDOWN = 3000;
const RULES = { cooldownMs: CD };
const OK = { ok: true, data: null };

describe("multiplayer game server", () => {
  let gameServer: GameServer;
  let serverUrl: string;
  let clients: TestClient[];
  let serverNow: number;

  async function startServer(options: { disconnectGraceMs?: number } = {}) {
    gameServer = createGameServer(undefined, { ...options, now: () => serverNow });
    const port = await gameServer.listen(0);
    serverUrl = `http://127.0.0.1:${port}`;
  }

  beforeEach(async () => {
    serverNow = 1_700_000_000_000;
    clients = [];
    await startServer();
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await gameServer.close();
  });

  async function newClient() {
    const client = createClient(serverUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false
    }) as TestClient;
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    });
    return client;
  }

  // A private room with both seats filled and the countdown over: both sides are live.
  async function liveRoom(rules = RULES) {
    const white = await newClient();
    const black = await newClient();
    const created = await createRoom(white, { name: "SwiftFalcon27", rules });
    const joined = await joinRoom(black, { name: "BraveOtter42", code: created.snapshot.code });
    serverNow += COUNTDOWN;
    return { white, black, created, joined };
  }

  it("starts the countdown when the second player joins and tells both the cooldown length", async () => {
    const white = await newClient();
    const black = await newClient();
    const created = await createRoom(white, { name: "SwiftFalcon27", rules: { cooldownMs: 7000 } });
    expect(created.snapshot.stage).toBe("waiting");
    expect(created.snapshot.clock).toEqual({ value: -COUNTDOWN, running: false });

    const whiteSaw = waitForState(white, (state) => state.players.black?.name === "BraveOtter42");
    const joined = await joinRoom(black, { name: "BraveOtter42", code: created.snapshot.code });
    expect(joined.snapshot.stage).toBe("playing");
    expect(joined.snapshot.rules).toEqual({ cooldownMs: 7000 });
    expect(joined.snapshot.clock).toEqual({ value: -COUNTDOWN, running: true });
    expect(joined.snapshot.serverTime).toBe(serverNow);
    expect((await whiteSaw).clock).toEqual({ value: -COUNTDOWN, running: true });

    // Nobody can move during the countdown.
    serverNow += COUNTDOWN - 1;
    expect(await move(white, "e2e4")).toEqual({ ok: false, reason: "not-started", message: "Wait for the countdown." });
    serverNow += 1;
    expect(await move(black, "e7e5")).toEqual(OK);
    expect(await move(white, "e2e4")).toEqual(OK);
  });

  it("applies concurrent moves from both players and gives both the same state", async () => {
    const { white, black } = await liveRoom();
    const whiteDone = waitForState(white, (state) => state.game.moveLog.length === 4);
    const blackDone = waitForState(black, (state) => state.game.moveLog.length === 4);
    const responses = await Promise.all([move(white, "e2e4"), move(black, "e7e5"), move(white, "g1f3"), move(black, "b8c6")]);
    expect(responses).toEqual([OK, OK, OK, OK]);

    const [whiteState, blackState] = await Promise.all([whiteDone, blackDone]);
    expect(whiteState.game).toEqual(blackState.game);
    expect(whiteState.game.moveLog.map((entry) => entry.notation).sort()).toEqual(["Nc6", "Nf3", "e4", "e5"]);
    // Every move was stamped with the server's clock at arrival: game time 0.
    expect(whiteState.game.moveLog.every((entry) => entry.at === 0)).toBe(true);
    expect(getPieceAt(whiteState.game, parseSquare("e4"))?.readyAt).toBe(CD);
    expect(whiteState.clock).toEqual({ value: 0, running: true });
  });

  it("rejects a move for a cooling piece with the time left, then accepts it at readyAt", async () => {
    const { white, black } = await liveRoom();
    expect(await move(white, "e2e4")).toEqual(OK);
    expect(await move(white, "e4e5")).toEqual({ ok: false, reason: "cooling", readyInMs: CD, message: "Still cooling down: 5.0 s" });
    // The opponent is not affected by White's cooldown.
    expect(await move(black, "d7d5")).toEqual(OK);
    serverNow += CD - 1;
    expect(await move(white, "e4e5")).toMatchObject({ ok: false, reason: "cooling", readyInMs: 1 });
    serverNow += 1;
    const updated = waitForState(black, (state) => state.game.moveLog.length === 3);
    expect(await move(white, "e4e5")).toEqual(OK);
    const state = await updated;
    expect(state.game.moveLog.at(-1)).toMatchObject({ notation: "e5", at: CD });
    expect(state.clock.value).toBe(CD);
  });

  it("resolves two intents that conflict in arrival order and rejects the loser", async () => {
    const { white, black } = await liveRoom();
    expect(await move(white, "e2e4")).toEqual(OK);
    expect(await move(black, "d7d5")).toEqual(OK);
    serverNow += CD;

    // Each pawn can take the other. Both intents are sent at once; exactly one can win.
    const [whiteTakes, blackTakes] = await Promise.all([move(white, "e4d5"), move(black, "d5e4")]);
    expect([whiteTakes.ok, blackTakes.ok].filter(Boolean)).toHaveLength(1);
    const loser = whiteTakes.ok ? blackTakes : whiteTakes;
    expect(loser).toEqual({ ok: false, reason: "no-piece", message: "That piece is gone." });

    // The same again with a known order: Black's queen recaptures first, so White's knight,
    // which wanted the same square, finds it changed but still legal, and takes the queen.
    const winner = whiteTakes.ok ? "white" : "black";
    if (winner === "white") {
      expect(await move(black, "d8d5")).toEqual(OK);
      expect(await move(white, "b1c3")).toEqual(OK);
      serverNow += CD;
      const done = waitForState(black, (state) => state.game.moveLog.at(-1)?.notation === "Nxd5");
      expect(await move(white, "c3d5")).toEqual(OK);
      expect((await done).game.moveLog.at(-1)?.captured).toEqual(["queen"]);
      // Black's queen is gone, so its queued move is refused without penalty.
      expect(await move(black, "d5a5")).toMatchObject({ ok: false, reason: "no-piece" });
    }
  });

  it("ends the game when a king is captured and rejects later intents", async () => {
    const { white, black } = await liveRoom();
    expect(await move(white, "e2e4")).toEqual(OK);
    expect(await move(white, "d1h5")).toEqual(OK);
    serverNow += CD;
    expect(await move(white, "h5f7")).toEqual(OK);
    // No check: Black may ignore the queen next to its king.
    expect(await move(black, "a7a6")).toEqual(OK);
    serverNow += CD;
    const finishedWhite = waitForState(white, (state) => state.stage === "finished");
    const finishedBlack = waitForState(black, (state) => state.stage === "finished");
    expect(await move(white, "f7e8")).toEqual(OK);

    const finished = await finishedWhite;
    expect(finished.game.status).toMatchObject({ phase: "won", winner: "white", reason: "king-captured" });
    expect(finished.game.moveLog.at(-1)).toMatchObject({ notation: "Qxe8", captured: ["king"], at: 2 * CD });
    // The clock stops with the game.
    expect(finished.clock).toEqual({ value: 2 * CD, running: false });
    expect((await finishedBlack).game).toEqual(finished.game);
    expect(await move(black, "a6a5")).toEqual({ ok: false, reason: "game-over", message: "That game is already over." });
    expect(await move(white, "e8d8")).toMatchObject({ ok: false, reason: "game-over" });
    expect(await resign(white)).toEqual({ ok: false, message: "That game is already over." });
  });

  it("rejects illegal moves and moves of the opponent's pieces without changing the game", async () => {
    const { white, black, joined } = await liveRoom();
    expect(await move(white, "e2e5")).toMatchObject({ ok: false, reason: "illegal" });
    expect(await move(white, "e1g1")).toMatchObject({ ok: false, reason: "illegal" });
    expect(await move(white, "e7e5")).toMatchObject({ ok: false, reason: "no-piece" });
    expect(await move(white, "nonsense")).toMatchObject({ ok: false, reason: "illegal" });
    const updated = waitForState(black, (state) => state.game.moveLog.length === 1);
    expect(await move(white, "e2e4")).toEqual(OK);
    expect((await updated).revision).toBe(joined.snapshot.revision + 1);
  });

  it("freezes every cooldown while a player is disconnected and resyncs them on reconnect", async () => {
    const { white, black, joined } = await liveRoom();
    expect(await move(white, "e2e4")).toEqual(OK);
    expect(await move(black, "g8f6")).toEqual(OK);
    serverNow += 1000;

    const pausedState = waitForState(white, (state) => state.players.black?.connected === false);
    black.close();
    const paused = await pausedState;
    expect(paused.disconnectDeadlines.black).not.toBeNull();
    expect(paused.clock).toEqual({ value: 1000, running: false });

    // 20 s pass in the real world. The game clock does not move and nobody can play.
    serverNow += 20_000;
    expect(await move(white, "d2d4")).toEqual({
      ok: false,
      reason: "paused",
      message: "The game is paused until your opponent reconnects."
    });

    const resumedClient = await newClient();
    const whiteSawReturn = waitForState(white, (state) => state.players.black?.connected === true);
    const resumed = await resumeRoom(resumedClient, joined.session);
    const whiteView = await whiteSawReturn;
    expect(resumed.snapshot.players.black?.name).toBe("BraveOtter42");
    expect(resumed.snapshot.disconnectDeadlines.black).toBeNull();
    // The returning client gets the whole state, on the same clock, with nothing lost.
    expect(resumed.snapshot.clock).toEqual({ value: 1000, running: true });
    expect(resumed.snapshot.game).toEqual(whiteView.game);
    expect(resumed.snapshot.game.moveLog.map((entry) => entry.notation)).toEqual(["e4", "Nf6"]);
    expect(getPieceAt(resumed.snapshot.game, parseSquare("f6"))?.readyAt).toBe(CD);

    // The pawn still owes exactly the 4 s it owed when the pause began.
    expect(await move(white, "e4e5")).toMatchObject({ ok: false, reason: "cooling", readyInMs: CD - 1000 });
    serverNow += CD - 1000;
    expect(await move(white, "e4e5")).toEqual(OK);
    expect(await move(resumedClient, "f6e4")).toEqual(OK);
  });

  it("ends the game by resignation when a disconnected player misses the grace period", async () => {
    await gameServer.close();
    await startServer({ disconnectGraceMs: 60 });
    const { white, black } = await liveRoom();

    const pausedState = waitForState(white, (state) => state.disconnectDeadlines.black !== null);
    const finishedState = waitForState(white, (state) => state.stage === "finished");
    black.close();

    const paused = await pausedState;
    expect(paused.game.status.phase).toBe("playing");
    expect(paused.clock.running).toBe(false);

    const finished = await finishedState;
    expect(finished.disconnectDeadlines.black).toBeNull();
    expect(finished.game.status).toMatchObject({ phase: "won", winner: "white", reason: "resignation" });
  });

  it("records a resignation, and a rematch resets the board, the cooldowns and the clock", async () => {
    const { white, black } = await liveRoom();
    expect(await move(white, "e2e4")).toEqual(OK);
    serverNow += 1234;

    const finishedState = waitForState(white, (state) => state.stage === "finished");
    expect(await resign(white)).toEqual(OK);
    const finished = await finishedState;
    expect(finished.game.status).toMatchObject({ phase: "won", winner: "black", reason: "resignation" });
    expect(finished.clock).toEqual({ value: 1234, running: false });

    const requestedState = waitForState(black, (state) => state.rematchVotes.includes("white"));
    expect(await rematch(white)).toEqual(OK);
    expect((await requestedState).rematchVotes).toEqual(["white"]);
    serverNow += 9000;
    const restartedState = waitForState(white, (state) => state.stage === "playing" && state.rematchVotes.length === 0);
    expect(await rematch(black)).toEqual(OK);
    const restarted = await restartedState;
    expect(restarted.game.moveLog).toHaveLength(0);
    expect(restarted.game.board.flat().every((piece) => !piece || (piece.readyAt === 0 && !piece.moved))).toBe(true);
    expect(restarted.clock).toEqual({ value: -COUNTDOWN, running: true });
    expect(restarted.rules).toEqual(RULES);
    // A new countdown: no moves until it ends.
    expect(await move(black, "e7e5")).toMatchObject({ ok: false, reason: "not-started" });
    serverNow += COUNTDOWN;
    expect(await move(black, "e7e5")).toEqual(OK);
  });

  it("limits how fast one socket can send moves, without touching normal play", async () => {
    const { white, black } = await liveRoom();
    // A burst far beyond anything a hand can do.
    const burst = await Promise.all(Array.from({ length: MOVE_BURST + 10 }, () => move(white, "e2e5")));
    expect(burst.filter((response) => !response.ok && response.reason === "illegal")).toHaveLength(MOVE_BURST);
    expect(burst.filter((response) => !response.ok && response.reason === "rate-limited")).toHaveLength(10);
    expect(await move(white, "e2e4")).toMatchObject({ ok: false, reason: "rate-limited" });
    // The other player has a bucket of their own.
    expect(await move(black, "e7e5")).toEqual(OK);
    // A second later the first player can move again.
    serverNow += 1000;
    expect(await move(white, "e2e4")).toEqual(OK);
    // Sixteen moves in one instant (every piece a player has) is well inside the limit.
    serverNow += 60_000;
    const opening = ["a2a4", "b2b4", "c2c4", "d2d4", "f2f4", "g2g4", "h2h4", "g1f3", "b1c3", "a1a2", "h1h2", "c1b2", "f1g2", "d1d2", "e1f2"];
    expect(await Promise.all(opening.map((id) => move(white, id)))).toEqual(opening.map(() => OK));
  });

  it("answers clock sync requests with the server's time", async () => {
    const client = await newClient();
    const serverTime = await new Promise<number>((resolve) => client.emit("clock:sync", resolve));
    expect(serverTime).toBe(serverNow);
  });

  it("shows only generated names and keeps player IDs private", async () => {
    const white = await newClient();
    const black = await newClient();
    const room = await createRoom(white, {
      name: "anything typed",
      playerId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
      rules: RULES
    });
    const joined = await joinRoom(black, { name: "CalmHeron31", code: room.snapshot.code });

    expect(joined.snapshot.players.white?.name).toBe("Guest");
    expect(joined.snapshot.players.black?.name).toBe("CalmHeron31");
    expect(JSON.stringify(joined.snapshot)).not.toContain("1b9d6bcd");
  });

  it("synchronizes quick-message chat and rejects free text", async () => {
    const { white, black } = await liveRoom();
    const whiteChatState = waitForState(white, (state) => state.chat.length === 1);
    const blackChatState = waitForState(black, (state) => state.chat.length === 1);
    expect(await sendChat(white, "  Good   luck!  ")).toEqual(OK);

    const [whiteState, blackState] = await Promise.all([whiteChatState, blackChatState]);
    expect(whiteState.chat).toEqual(blackState.chat);
    expect(whiteState.chat[0]).toMatchObject({ player: "white", text: "Good luck!" });
    expect(await sendChat(black, "anything a stranger might type")).toEqual({ ok: false, message: "Choose one of the quick messages." });
    expect(await sendChat(black, "   ")).toEqual({ ok: false, message: "Choose one of the quick messages." });
  });

  it("records an active departure and prevents an orphaned rematch request", async () => {
    const { white, black } = await liveRoom();
    const departedState = waitForState(white, (state) => state.stage === "finished" && state.players.black?.connected === false);
    expect(await leaveRoom(black)).toEqual(OK);
    const departed = await departedState;
    expect(departed.game.status).toMatchObject({ phase: "won", winner: "white", reason: "resignation" });
    expect(departed.clock.running).toBe(false);
    expect(await rematch(white)).toEqual({ ok: false, message: "Your opponent is no longer in the room." });
  });

  it("pairs quick-match players only when they chose the same cooldown", async () => {
    const first = await newClient();
    const second = await newClient();
    const third = await newClient();
    const queued = { ok: true, data: { queued: true } };

    expect(await joinMatchmaking(first, { name: "SwiftFalcon27", rules: { cooldownMs: 3000 } })).toEqual(queued);
    // A different cooldown does not match; that player waits in the queue too.
    expect(await joinMatchmaking(second, { name: "BraveOtter42", rules: { cooldownMs: 7000 } })).toEqual(queued);

    const firstMatched = waitForMatch(first);
    const thirdMatched = waitForMatch(third);
    expect(await joinMatchmaking(third, { name: "CalmHeron31", rules: { cooldownMs: 3000 } })).toEqual({ ok: true, data: { queued: false } });

    const [a, b] = await Promise.all([firstMatched, thirdMatched]);
    expect(a.snapshot.code).toBe(b.snapshot.code);
    expect(a.snapshot.rules).toEqual({ cooldownMs: 3000 });
    expect(a.snapshot.clock).toEqual({ value: -COUNTDOWN, running: true });
    // Colors are random, but the two players always get opposite ones.
    expect([a.session.player, b.session.player].sort()).toEqual(["black", "white"]);
  });

  it("lets the room creator choose Black and seats the joiner as White", async () => {
    const host = await newClient();
    const guest = await newClient();
    const room = await createRoom(host, { name: "CalmHeron31", rules: RULES, color: "black" });
    expect(room.session.player).toBe("black");

    const joined = await joinRoom(guest, { name: "BoldOtter12", code: room.snapshot.code });
    expect(joined.session.player).toBe("white");
    expect(joined.snapshot.stage).toBe("playing");
    expect(await joinRoom(await newClient(), { name: "WiseLynx44", code: room.snapshot.code }).catch((error: Error) => error.message)).toBe(
      "That room is already full."
    );
  });

  it("falls back to the default cooldown when a client sends rules it does not offer", async () => {
    const host = await newClient();
    const room = await createRoom(host, { name: "CalmHeron31", rules: { cooldownMs: 50 } });
    expect(room.snapshot.rules).toEqual({ cooldownMs: 5000 });
  });
});

function createRoom(client: TestClient, payload: CreateRoomPayload) {
  return emitWithAck<RoomConnection>((ack) => client.emit("room:create", payload, ack));
}

function joinRoom(client: TestClient, payload: JoinRoomPayload) {
  return emitWithAck<RoomConnection>((ack) => client.emit("room:join", payload, ack));
}

function resumeRoom(client: TestClient, session: PlayerSession) {
  return emitWithAck<RoomConnection>((ack) => client.emit("room:resume", session, ack));
}

function move(client: TestClient, moveId: string) {
  return emitResponse<null>((ack) => client.emit("room:move", moveId, ack));
}

function resign(client: TestClient) {
  return emitResponse<null>((ack) => client.emit("room:resign", ack));
}

function rematch(client: TestClient) {
  return emitResponse<null>((ack) => client.emit("room:rematch", ack));
}

function sendChat(client: TestClient, message: string) {
  return emitResponse<null>((ack) => client.emit("room:chat", message, ack));
}

function leaveRoom(client: TestClient) {
  return emitResponse<null>((ack) => client.emit("room:leave", ack));
}

function joinMatchmaking(client: TestClient, payload: MatchmakingPayload) {
  return emitResponse<QueueResult>((ack) => client.emit("matchmaking:join", payload, ack));
}

function emitWithAck<T>(emit: (ack: (response: ServerResponse<T>) => void) => void) {
  return new Promise<T>((resolve, reject) => {
    emit((response) => response.ok ? resolve(response.data) : reject(new Error(response.message)));
  });
}

function emitResponse<T>(emit: (ack: (response: ServerResponse<T>) => void) => void) {
  return new Promise<ServerResponse<T>>((resolve) => emit(resolve));
}

function waitForState(client: TestClient, predicate: (state: RoomSnapshot) => boolean) {
  return new Promise<RoomSnapshot>((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off("room:state", handler);
      reject(new Error("Timed out waiting for room state."));
    }, 2_000);
    const handler = (state: RoomSnapshot) => {
      if (!predicate(state)) return;
      clearTimeout(timeout);
      client.off("room:state", handler);
      resolve(state);
    };
    client.on("room:state", handler);
  });
}

function waitForMatch(client: TestClient) {
  return new Promise<RoomConnection>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for a match.")), 2_000);
    client.once("matchmaking:matched", (connection) => {
      clearTimeout(timeout);
      resolve(connection);
    });
  });
}
