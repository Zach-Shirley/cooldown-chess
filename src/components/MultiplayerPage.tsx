import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  BookOpen,
  ChevronLeft,
  Clipboard,
  ClipboardCheck,
  DoorOpen,
  Globe,
  Handshake,
  Home,
  LoaderCircle,
  LogIn,
  MessageSquare,
  Radio,
  RotateCcw,
  Swords,
  Trophy,
  WifiOff,
  Zap
} from "lucide-react";
import {
  DEFAULT_GAME_RULES,
  opponentOf,
  playerName,
  type GameRules,
  type Move,
  type Player
} from "../game";
import {
  QUICK_CHAT_MESSAGES,
  type ColorChoice,
  type PlayerSession,
  type QueueResult,
  type RoomConnection,
  type RoomSnapshot,
  type ServerResponse
} from "../multiplayer/protocol";
import { withoutFreeText } from "../multiplayer/nativeSafety";
import { getMultiplayerSocket } from "../multiplayer/socket";
import { type BotLevel } from "../bot";
import { getPlayerIdentity } from "../playerIdentity";
import { playSound } from "../sound";
import { Board } from "../ui/Board";
import { BotLevelPicker } from "../ui/BotLevelPicker";
import { ColorPicker, resolveColorChoice } from "../ui/ColorPicker";
import { CooldownPicker, MoveFeed, PlayerBar, RulesDialog, SoundToggle, StartCountdown, StatusBar, cooldownLabel } from "../ui/GameChrome";
import { resultDetail, resultTitle } from "../ui/GameOverDialog";
import { Modal } from "../ui/Modal";
import { pieceSprite } from "../ui/PieceToken";
import { useClockTick, useGameSounds, useKingDanger, useMoveEffects, useSelections, type ClockView } from "../ui/realtime";
import { LocalGamePage } from "./LocalGamePage";

const SESSION_KEY = "cooldown-chess:online-session:v1";
const WHITE_ONLY: readonly Player[] = ["white"];
const BLACK_ONLY: readonly Player[] = ["black"];

type LobbyMode = "create" | "join";
type GameDialog = "rules" | "resign" | "leave" | null;

export function MultiplayerPage({
  onExit,
  onPlayBot
}: {
  onExit: () => void;
  onPlayBot: (level: BotLevel, rules: GameRules, color: ColorChoice) => void;
}) {
  const identity = useMemo(getPlayerIdentity, []);
  // While quick match searches, the player can play a bot; a found match replaces that game.
  const [waitingBot, setWaitingBot] = useState<{ level: BotLevel; rules: GameRules; botPlayer: Player; session: number } | null>(null);
  const [queueRules, setQueueRules] = useState<GameRules>(DEFAULT_GAME_RULES);
  const [matchNotice, setMatchNotice] = useState(false);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [session, setSession] = useState<PlayerSession | null>(() => readSession());
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const socket = useMemo(getMultiplayerSocket, []);

  const showSnapshot = useCallback((next: RoomSnapshot) => {
    setSnapshot(withoutFreeText(next));
  }, []);

  const acceptConnection = useCallback((connection: RoomConnection) => {
    setWaitingBot((current) => {
      if (current) setMatchNotice(true);
      return null;
    });
    writeSession(connection.session);
    setSession(connection.session);
    showSnapshot(connection.snapshot);
    setQueued(false);
    setError(null);
    setConnecting(false);
  }, [showSnapshot]);

  useEffect(() => {
    function resumeSavedSession() {
      setConnected(true);
      setError(null);
      const savedSession = readSession();
      if (!savedSession) {
        setConnecting(false);
        return;
      }

      setConnecting(true);
      socket.emit("room:resume", savedSession, (response) => {
        if (response.ok) {
          acceptConnection(response.data);
          return;
        }

        clearSession();
        setSession(null);
        setSnapshot(null);
        setConnecting(false);
        setError(response.message);
      });
    }

    function handleDisconnect() {
      setConnected(false);
      setConnecting(false);
    }

    function handleConnectError() {
      setConnected(false);
      setConnecting(false);
      setError("Waking the game server. It sleeps when idle, so this can take up to a minute.");
    }

    function handleRoomClosed(message: string) {
      clearSession();
      setSession(null);
      setSnapshot(null);
      setQueued(false);
      setError(message);
    }

    socket.on("connect", resumeSavedSession);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("room:state", showSnapshot);
    socket.on("room:closed", handleRoomClosed);
    socket.on("matchmaking:matched", acceptConnection);
    socket.connect();

    return () => {
      socket.off("connect", resumeSavedSession);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("room:state", showSnapshot);
      socket.off("room:closed", handleRoomClosed);
      socket.off("matchmaking:matched", acceptConnection);
      socket.disconnect();
    };
  }, [acceptConnection, showSnapshot, socket]);

  function runRoomRequest<T>(
    emit: (ack: (response: ServerResponse<T>) => void) => void,
    onSuccess: (data: T) => void
  ) {
    if (!connected) {
      setError("The game server is disconnected.");
      return;
    }

    setBusy(true);
    setError(null);
    emit((response) => {
      setBusy(false);
      if (response.ok) {
        onSuccess(response.data);
      } else {
        setError(response.message);
      }
    });
  }

  function createRoom(rules: GameRules, color: ColorChoice) {
    runRoomRequest<RoomConnection>(
      (ack) => socket.emit("room:create", { name: identity.name, playerId: identity.id, rules, color }, ack),
      acceptConnection
    );
  }

  function joinRoom(code: string) {
    runRoomRequest<RoomConnection>(
      (ack) => socket.emit("room:join", { name: identity.name, playerId: identity.id, code }, ack),
      acceptConnection
    );
  }

  function joinQueue(rules: GameRules) {
    setQueueRules(rules);
    runRoomRequest<QueueResult>(
      (ack) => socket.emit("matchmaking:join", { name: identity.name, playerId: identity.id, rules }, ack),
      (result) => setQueued(result.queued)
    );
  }

  function cancelQueue(onCancelled?: () => void) {
    runRoomRequest(
      (ack) => socket.emit("matchmaking:leave", ack),
      () => {
        setQueued(false);
        setWaitingBot(null);
        onCancelled?.();
      }
    );
  }

  function leaveRoom(exitAfter = false) {
    if (!connected) {
      clearSession();
      setSession(null);
      setSnapshot(null);
      setQueued(false);
      if (exitAfter) onExit();
      return;
    }

    runRoomRequest(
      (ack) => socket.emit("room:leave", ack),
      () => {
        clearSession();
        setSession(null);
        setSnapshot(null);
        if (exitAfter) onExit();
      }
    );
  }

  if (connecting && session && !snapshot) {
    return <ConnectionScreen label="Rejoining game" />;
  }

  if (snapshot && session) {
    if (snapshot.stage === "waiting") {
      return (
        <WaitingRoom
          snapshot={snapshot}
          session={session}
          connected={connected}
          busy={busy}
          error={error}
          onLeave={() => leaveRoom(true)}
        />
      );
    }

    return (
      <>
        {matchNotice ? <MatchFoundNotice onDone={() => setMatchNotice(false)} /> : null}
        <OnlineGame
          snapshot={snapshot}
          session={session}
          connected={connected}
          error={error}
          onError={setError}
          onLeave={() => leaveRoom(true)}
        />
      </>
    );
  }

  if (queued && waitingBot) {
    return (
      <LocalGamePage
        key={`waiting-bot-${waitingBot.session}`}
        initialRules={waitingBot.rules}
        bot={{ player: waitingBot.botPlayer, level: waitingBot.level }}
        kicker="Still searching for a match"
        onExit={() => setWaitingBot(null)}
      />
    );
  }

  return (
    <MultiplayerLobby
      playerName={identity.name}
      connected={connected}
      busy={busy}
      queued={queued}
      queueRules={queueRules}
      error={error}
      onExit={onExit}
      onCreate={createRoom}
      onJoin={joinRoom}
      onQueue={joinQueue}
      onCancelQueue={() => cancelQueue()}
      onBotWhileWaiting={(level, color) =>
        setWaitingBot({ level, rules: queueRules, botPlayer: opponentOf(resolveColorChoice(color)), session: Date.now() })
      }
      onBotInstead={(level, color) => cancelQueue(() => onPlayBot(level, queueRules, color))}
    />
  );
}

function MatchFoundNotice({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, 4500);
    return () => window.clearTimeout(timer);
  }, [onDone]);
  return (
    <p className="match-toast" role="status">
      Match found! Your bot game was closed.
    </p>
  );
}

function MultiplayerLobby({
  playerName: ownName,
  connected,
  busy,
  queued,
  queueRules,
  error,
  onExit,
  onCreate,
  onJoin,
  onQueue,
  onCancelQueue,
  onBotWhileWaiting,
  onBotInstead
}: {
  playerName: string;
  connected: boolean;
  busy: boolean;
  queued: boolean;
  queueRules: GameRules;
  error: string | null;
  onExit: () => void;
  onCreate: (rules: GameRules, color: ColorChoice) => void;
  onJoin: (code: string) => void;
  onQueue: (rules: GameRules) => void;
  onCancelQueue: () => void;
  onBotWhileWaiting: (level: BotLevel, color: ColorChoice) => void;
  onBotInstead: (level: BotLevel, color: ColorChoice) => void;
}) {
  const [mode, setMode] = useState<LobbyMode>("create");
  const [code, setCode] = useState("");
  // The cooldown for a room this player creates, and the one quick match searches for.
  const [rules, setRules] = useState<GameRules>(DEFAULT_GAME_RULES);
  const [botLevel, setBotLevel] = useState<BotLevel>("medium");
  const [roomColor, setRoomColor] = useState<ColorChoice>("random");
  const [botColor, setBotColor] = useState<ColorChoice>("white");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === "create") {
      onCreate(rules, roomColor);
    } else {
      onJoin(code);
    }
  }

  if (queued) {
    return (
      <main className="multiplayer-page">
        <section className="queue-screen" aria-live="polite">
          <div className="radar" aria-hidden="true">
            <img src={pieceSprite("white", "knight")} alt="" draggable="false" />
          </div>
          <p className="section-kicker">Quick match</p>
          <h1>Looking for a player</h1>
          <p>You will be matched with the next player who searches for a game with a {cooldownLabel(queueRules)}.</p>
          <div className="queue-bot">
            <strong>Play a bot meanwhile?</strong>
            <BotLevelPicker value={botLevel} onChange={setBotLevel} />
            <ColorPicker value={botColor} onChange={setBotColor} />
            <div className="queue-bot-actions">
              <button className="button primary" type="button" onClick={() => onBotWhileWaiting(botLevel, botColor)}>
                Play while I wait
              </button>
              <button className="button secondary" type="button" onClick={() => onBotInstead(botLevel, botColor)} disabled={busy}>
                Play a bot instead
              </button>
            </div>
            <small>While you wait, a found match takes over right away.</small>
          </div>
          <button className="button ghost" type="button" onClick={onCancelQueue} disabled={busy}>
            Cancel search
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="multiplayer-page">
      <button className="back-button" type="button" onClick={onExit}>
        <ChevronLeft aria-hidden="true" size={20} />
        Back
      </button>

      <section className="multiplayer-lobby" aria-labelledby="multiplayer-title">
        <header className="multiplayer-heading">
          <div className="multiplayer-icon" aria-hidden="true"><Globe size={26} /></div>
          <div>
            <p className="section-kicker">Online play</p>
            <h1 id="multiplayer-title">Play online</h1>
          </div>
          <span className={`server-state ${connected ? "online" : "offline"}`}>
            <Radio aria-hidden="true" size={14} />
            {connected ? "Server online" : "Connecting..."}
          </span>
        </header>

        <p className="playing-as">
          Playing as <strong>{ownName}</strong>
        </p>

        {error ? <p className="lobby-error" role="alert">{error}</p> : null}

        <div className="lobby-setting">
          <CooldownPicker value={rules} onChange={setRules} />
          <small>Used for the room you create and for quick match. A room you join uses its host's choice.</small>
        </div>

        <div className="lobby-cards">
          <div className="lobby-card">
            <div className="lobby-card-heading">
              <Swords aria-hidden="true" size={18} />
              <h2>Private room</h2>
            </div>
            <div className="segmented lobby-tabs" role="tablist" aria-label="Room action">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "create"}
                className={mode === "create" ? "active" : ""}
                onClick={() => setMode("create")}
              >
                Create room
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "join"}
                className={mode === "join" ? "active" : ""}
                onClick={() => setMode("join")}
              >
                Join room
              </button>
            </div>

            <form className="lobby-form" onSubmit={submit}>
              {mode === "create" ? (
                <ColorPicker value={roomColor} onChange={setRoomColor} />
              ) : (
                <label className="field-label">
                  <span className="field-caption">Room code</span>
                  <input
                    className="room-code-input"
                    type="text"
                    value={code}
                    maxLength={6}
                    autoCapitalize="characters"
                    autoComplete="off"
                    placeholder="ABC123"
                    onChange={(event) => setCode(normalizeRoomCode(event.currentTarget.value))}
                  />
                </label>
              )}

              <button className="button primary lobby-submit" type="submit" disabled={busy || !connected || (mode === "join" && code.length !== 6)}>
                {busy ? <LoaderCircle className="button-spinner" aria-hidden="true" size={18} /> : mode === "create" ? <Swords aria-hidden="true" size={18} /> : <LogIn aria-hidden="true" size={18} />}
                {mode === "create" ? "Create private room" : "Join room"}
              </button>
            </form>
          </div>

          <div className="lobby-card quick-card">
            <div className="lobby-card-heading">
              <Zap aria-hidden="true" size={18} />
              <h2>Quick match</h2>
            </div>
            <p>Pair with the next player searching for the same cooldown. Sides are random, and you can play a bot while you wait.</p>
            <button
              className="button secondary"
              type="button"
              disabled={busy || !connected}
              onClick={() => onQueue(rules)}
            >
              Find match
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

function WaitingRoom({
  snapshot,
  session,
  connected,
  busy,
  error,
  onLeave
}: {
  snapshot: RoomSnapshot;
  session: PlayerSession;
  connected: boolean;
  busy: boolean;
  error: string | null;
  onLeave: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const ownSide = playerName(session.player);

  async function copyCode() {
    // The clipboard API only exists on secure (https) pages.
    try {
      await navigator.clipboard.writeText(snapshot.code);
    } catch {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <main className="multiplayer-page">
      <button className="back-button" type="button" onClick={onLeave} disabled={busy}>
        <ChevronLeft aria-hidden="true" size={20} />
        Leave
      </button>

      <section className="waiting-room" aria-labelledby="waiting-title">
        <p className="section-kicker">Private room</p>
        <h1 id="waiting-title">Waiting for an opponent</h1>
        <p className="waiting-copy">Share this code with your opponent. They choose Join room and enter it. You play {ownSide}, with a {cooldownLabel(snapshot.rules)}.</p>

        <button className="room-code-display" type="button" onClick={copyCode} title="Copy room code">
          <span>{snapshot.code}</span>
          <small>
            {copied ? <ClipboardCheck aria-hidden="true" size={14} /> : <Clipboard aria-hidden="true" size={14} />}
            {copied ? "Copied" : "Copy code"}
          </small>
        </button>

        <div className="waiting-seats">
          <WaitingSeat player="white" name={snapshot.players.white?.name} connected={Boolean(snapshot.players.white?.connected)} />
          <span aria-hidden="true">vs</span>
          <WaitingSeat player="black" name={snapshot.players.black?.name} connected={Boolean(snapshot.players.black?.connected)} />
        </div>

        {!connected ? <p className="lobby-error" role="alert">Reconnecting to multiplayer server...</p> : null}
        {error ? <p className="lobby-error" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}

function WaitingSeat({ player, name, connected }: { player: Player; name: string | undefined; connected: boolean }) {
  return (
    <div className={`waiting-seat ${connected ? "occupied" : ""}`}>
      <img src={pieceSprite(player, "king")} alt="" draggable="false" />
      <small>{playerName(player)}</small>
      <strong>{name ?? "Open seat"}</strong>
    </div>
  );
}

// How often the client asks the server for its time, and how small a correction is ignored.
const CLOCK_SYNC_EVERY_MS = 4000;
const CLOCK_SYNC_SAMPLES = 5;
const CLOCK_JITTER_MS = 25;
// A move refused as "cooling" with this little left was only the two clocks disagreeing: resend it.
const RETRY_WITHIN_MS = 250;

// The room's game clock as this client sees it. Every snapshot carries the clock's value and the
// server's wall time; the offset between the server's wall clock and ours is measured with
// small ping/pong requests (the reply is assumed to have been sent halfway through the round
// trip, and the quickest of the last few round trips is trusted most).
function useServerClock(snapshot: RoomSnapshot, connected: boolean): ClockView {
  const socket = useMemo(getMultiplayerSocket, []);
  // Until the first ping returns, assume the snapshot arrived instantly. That estimate is late
  // by the network delay, which only ever makes this client a little slow, never early.
  const offsetRef = useRef<number | null>(null);
  if (offsetRef.current === null) offsetRef.current = snapshot.serverTime - Date.now();
  const samples = useRef<{ rtt: number; offset: number }[]>([]);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const ping = () => {
      const sentAt = Date.now();
      socket.emit("clock:sync", (serverTime) => {
        if (cancelled || typeof serverTime !== "number") return;
        const receivedAt = Date.now();
        samples.current = [...samples.current, { rtt: receivedAt - sentAt, offset: serverTime - (sentAt + receivedAt) / 2 }].slice(-CLOCK_SYNC_SAMPLES);
        const best = samples.current.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        if (Math.abs(best.offset - (offsetRef.current ?? 0)) > CLOCK_JITTER_MS) {
          offsetRef.current = best.offset;
          // Restart the cooldown rings from the corrected clock.
          setEpoch((current) => current + 1);
        }
      });
    };
    ping();
    const fast = window.setTimeout(ping, 600);
    const timer = window.setInterval(ping, CLOCK_SYNC_EVERY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(fast);
      window.clearInterval(timer);
    };
  }, [connected, socket]);

  const { value, running: serverRunning } = snapshot.clock;
  const { serverTime } = snapshot;
  // Without a connection nothing can be trusted to be advancing; hold the picture still.
  const running = serverRunning && connected;
  const frozenAt = useRef(value);
  return useMemo(() => {
    const now = () => {
      if (!serverRunning) return value;
      if (!connected) return frozenAt.current;
      const current = value + Math.max(0, Date.now() + (offsetRef.current ?? 0) - serverTime);
      frozenAt.current = current;
      return current;
    };
    return { now, running, epoch: epoch * 4 + (running ? 1 : 0) + (connected ? 2 : 0) };
  }, [value, serverTime, serverRunning, connected, running, epoch]);
}

function OnlineGame({
  snapshot,
  session,
  connected,
  error,
  onError,
  onLeave
}: {
  snapshot: RoomSnapshot;
  session: PlayerSession;
  connected: boolean;
  error: string | null;
  onError: (message: string | null) => void;
  onLeave: () => void;
}) {
  const [dialog, setDialog] = useState<GameDialog>(null);
  const socket = useMemo(getMultiplayerSocket, []);
  const state = snapshot.game;
  const you = session.player;
  const opponent = opponentOf(you);
  const opponentConnected = snapshot.players[opponent]?.connected ?? false;
  const playing = state.status.phase === "playing";
  const sides = you === "white" ? WHITE_ONLY : BLACK_ONLY;

  const clock = useServerClock(snapshot, connected);
  const now = useClockTick(state, clock);
  const { animations, onAnimationEnd } = useMoveEffects(state, you);
  const dangerSquares = useKingDanger(state, now, sides);
  useGameSounds(state, now, you);

  // An error from a refused request clears itself; the game does not stop to be read.
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => onError(null), 2600);
    return () => window.clearTimeout(timer);
  }, [error, onError]);

  function request(
    action: (ack: (response: ServerResponse<null>) => void) => void,
    onSuccess?: () => void
  ) {
    if (!connected) {
      onError("The game server is disconnected.");
      return;
    }

    onError(null);
    action((response) => {
      if (response.ok) {
        onSuccess?.();
      } else {
        onError(response.message);
      }
    });
  }

  const notifyRef = useRef<(pieceId: string, text: string) => void>(() => undefined);

  // Sends a move intent. The server decides: it stamps the intent with its own clock when it
  // arrives and either applies it (the new state comes back as a snapshot) or says why not.
  const sendMove = useCallback(
    (_player: Player, move: Move, retried = false) => {
      socket.emit("room:move", move.id, (response) => {
        if (response.ok) return;
        if (response.reason === "cooling") {
          const left = response.readyInMs ?? 0;
          if (!retried && left <= RETRY_WITHIN_MS) {
            window.setTimeout(() => sendMove(_player, move, true), left + 15);
            return;
          }
          notifyRef.current(move.pieceId, `${(left / 1000).toFixed(1)}s`);
          playSound("deny");
          return;
        }
        if (response.reason === "no-piece" || response.reason === "illegal") {
          playSound("deny");
          onError("Too late: the board changed before your move arrived.");
          return;
        }
        onError(response.message);
      });
    },
    [onError, socket]
  );

  const { selections, notices, notify, onSquareDown, onSquareUp } = useSelections({
    state,
    now,
    clock,
    sides,
    enabled: playing && connected && opponentConnected,
    onMove: sendMove
  });
  notifyRef.current = notify;

  const ownRematchVote = snapshot.rematchVotes.includes(you);
  const opponentRematchVote = snapshot.rematchVotes.includes(opponent);
  const paused = playing && (!connected || !opponentConnected);
  const live = playing && !paused && now >= 0;

  function requestRematch() {
    request((ack) => socket.emit("room:rematch", ack));
  }

  return (
    <main className="game-page online-game-page">
      <section className="game-workspace" aria-label="Online game">
        <div className="board-column">
          <PlayerBar
            player={opponent}
            name={snapshot.players[opponent]?.name ?? "Open seat"}
            tag={playerName(opponent)}
            state={state}
            now={now}
            live={live}
            offline={!opponentConnected}
          />

          <Board
            state={state}
            perspective={you}
            label={`Chess board, ${playerName(you)} side`}
            now={now}
            clock={clock}
            selections={selections}
            sides={sides}
            animations={animations}
            onAnimationEnd={onAnimationEnd}
            onSquareDown={onSquareDown}
            onSquareUp={onSquareUp}
            dangerSquares={dangerSquares}
            notices={notices}
            overlay={paused ? null : <StartCountdown state={state} now={now} paused={false} />}
          />

          <PlayerBar
            player={you}
            name={snapshot.players[you]?.name ?? "You"}
            tag={`You · ${playerName(you)}`}
            state={state}
            now={now}
            live={live}
            offline={!connected}
          />

          <GameEventOverlay
            snapshot={snapshot}
            session={session}
            connected={connected}
            onLeave={onLeave}
            onRematch={requestRematch}
          />
        </div>

        <aside className="game-panel" aria-label="Online game controls and move feed">
          <header className="game-panel-header">
            <button className="icon-button" type="button" onClick={() => setDialog("leave")} aria-label="Leave game" title="Leave game">
              <Home aria-hidden="true" size={19} />
            </button>
            <div>
              <p className="section-kicker">Room {snapshot.code} · {cooldownLabel(snapshot.rules)}</p>
              <strong>Online match</strong>
            </div>
            <SoundToggle />
            <span className={`connection-indicator ${connected ? "online" : "offline"}`} title={connected ? "Connected" : "Disconnected"}>
              <Radio aria-hidden="true" size={16} />
            </span>
          </header>

          <StatusBar
            state={state}
            now={now}
            paused={paused}
            danger={dangerSquares.length > 0}
            message={
              !connected
                ? "Reconnecting to the game server..."
                : playing && !opponentConnected
                  ? "Waiting for your opponent to reconnect. Every cooldown is frozen."
                  : undefined
            }
          />

          <MoveFeed state={state} />

          <ChatPanel
            snapshot={snapshot}
            session={session}
            connected={connected}
            onSend={(message, onSent) =>
              request((ack) => socket.emit("room:chat", message, ack), onSent)
            }
          />

          <footer className="game-actions online-actions">
            <button
              className="danger-action"
              type="button"
              onClick={() => setDialog("resign")}
              disabled={!playing || !connected}
              title="Resign game"
            >
              <DoorOpen aria-hidden="true" size={19} />
              <span>Resign</span>
            </button>
            <button
              className={opponentRematchVote ? "rematch-action requested" : "rematch-action"}
              type="button"
              onClick={requestRematch}
              disabled={playing || ownRematchVote || !connected || !opponentConnected}
              title="Request a rematch"
            >
              <RotateCcw aria-hidden="true" size={19} />
              <span>{ownRematchVote ? "Waiting" : opponentRematchVote ? "Accept" : "Rematch"}</span>
            </button>
            <button type="button" onClick={() => setDialog("rules")} title="View rules">
              <BookOpen aria-hidden="true" size={19} />
              <span>Rules</span>
            </button>
          </footer>
        </aside>
      </section>

      {error ? <div className="game-toast" role="alert">{error}</div> : null}

      {dialog === "rules" ? <RulesDialog onClose={() => setDialog(null)} /> : null}

      {dialog === "resign" ? (
        <Modal title="Resign this game?" description="Your opponent will win the current match. The game keeps running while this is open." tone="danger" onClose={() => setDialog(null)}>
          <div className="modal-actions">
            <button className="button secondary" type="button" onClick={() => setDialog(null)}>Cancel</button>
            <button className="button danger" type="button" data-autofocus onClick={() => { setDialog(null); request((ack) => socket.emit("room:resign", ack)); }}>Resign</button>
          </div>
        </Modal>
      ) : null}

      {dialog === "leave" ? (
        <Modal title="Leave this room?" description={playing ? "Leaving an active match counts as a resignation." : "You will return to the home screen."} tone="danger" onClose={() => setDialog(null)}>
          <div className="modal-actions">
            <button className="button secondary" type="button" onClick={() => setDialog(null)}>Stay</button>
            <button className="button danger" type="button" data-autofocus onClick={onLeave}>Leave room</button>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}

function GameEventOverlay({
  snapshot,
  session,
  connected,
  onLeave,
  onRematch
}: {
  snapshot: RoomSnapshot;
  session: PlayerSession;
  connected: boolean;
  onLeave: () => void;
  onRematch: () => void;
}) {
  const state = snapshot.game;
  const opponent = opponentOf(session.player);
  const opponentName = snapshot.players[opponent]?.name ?? playerName(opponent);
  const opponentConnected = snapshot.players[opponent]?.connected ?? false;
  const ownRematchVote = snapshot.rematchVotes.includes(session.player);
  const opponentRematchVote = snapshot.rematchVotes.includes(opponent);
  const disconnectSeconds = useCountdownSeconds(snapshot.disconnectDeadlines[opponent]);
  // "View board" hides the result card; a rematch (a new game) brings it back next time.
  const [resultHidden, setResultHidden] = useState(false);
  const isOver = state.status.phase !== "playing";
  useEffect(() => {
    if (!isOver) setResultHidden(false);
  }, [isOver]);

  if (connected && opponentConnected && state.status.phase === "playing") {
    return null;
  }

  if (!connected || (state.status.phase === "playing" && !opponentConnected)) {
    const serverOffline = !connected;
    return (
      <div className="game-event-layer" role="status" aria-live="assertive">
        <section className="game-event-card disconnected-event">
          <span className="game-event-icon" aria-hidden="true"><WifiOff size={28} /></span>
          <p className="section-kicker">Match paused</p>
          <h2>{serverOffline ? "Connection lost" : `${opponentName} disconnected`}</h2>
          {serverOffline || disconnectSeconds === null ? null : (
            <strong className="disconnect-countdown" aria-label={`${disconnectSeconds} seconds remaining`}>{disconnectSeconds}</strong>
          )}
          <p>{serverOffline ? "Reconnecting to the game server..." : `Every cooldown is frozen. Their seat is being held for ${disconnectSeconds ?? 30} seconds; if they do not reconnect, they forfeit.`}</p>
          <button className="button secondary" type="button" onClick={onLeave}>Leave room</button>
        </section>
      </div>
    );
  }

  if (state.status.phase === "playing" || resultHidden) {
    return null;
  }

  const drawn = state.status.phase === "draw";
  const didWin = state.status.phase === "won" && state.status.winner === session.player;
  const resigned = state.status.phase === "won" && state.status.reason === "resignation";
  const kingCaptured = state.status.phase === "won" && state.status.reason === "king-captured";
  const opponentLeft = didWin && resigned && !opponentConnected;
  const resultLabel = drawn ? "Draw" : didWin ? "Victory" : "Defeat";
  const outcomeTitle = drawn
    ? resultTitle(state, session.player)
    : opponentLeft
      ? `${opponentName} left the match`
      : resigned
        ? didWin
          ? `${opponentName} resigned`
          : "You resigned"
        : kingCaptured
          ? resultTitle(state, session.player)
          : didWin
            ? "You won"
            : `${opponentName} won`;
  const title = ownRematchVote
    ? "Rematch requested"
    : opponentRematchVote
      ? `${opponentName} wants a rematch`
      : outcomeTitle;
  const description = ownRematchVote
    ? `Waiting for ${opponentName} to accept.`
    : opponentRematchVote
      ? "Accept to reset the board and play again with the same cooldown."
      : resultDetail(state, session.player);

  return (
    <div className="game-event-layer" role="status" aria-live="assertive">
      <section className={`game-event-card result-event ${drawn ? "drawn" : didWin ? "won" : "lost"}`}>
        <span className="game-event-icon" aria-hidden="true">{drawn ? <Handshake size={28} /> : <Trophy size={28} />}</span>
        <p className="section-kicker">{resultLabel}</p>
        <h2>{title}</h2>
        <p>{description}</p>
        <div className="game-event-actions">
          <button
            className="button primary"
            type="button"
            onClick={onRematch}
            disabled={ownRematchVote || !connected || !opponentConnected}
          >
            <RotateCcw aria-hidden="true" size={17} />
            {!opponentConnected ? "Opponent left" : ownRematchVote ? "Waiting for opponent" : opponentRematchVote ? "Accept rematch" : "Request rematch"}
          </button>
          <button className="button secondary" type="button" onClick={onLeave}>Leave room</button>
          <button className="button ghost" type="button" onClick={() => setResultHidden(true)}>View board</button>
        </div>
      </section>
    </div>
  );
}

function useCountdownSeconds(deadline: number | null) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!deadline) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [deadline]);

  return deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
}

function ChatPanel({
  snapshot,
  session,
  connected,
  onSend
}: {
  snapshot: RoomSnapshot;
  session: PlayerSession;
  connected: boolean;
  onSend: (message: string, onSent: () => void) => void;
}) {
  const messageListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const messageList = messageListRef.current;
    if (messageList) messageList.scrollTop = messageList.scrollHeight;
  }, [snapshot.chat.length]);

  return (
    <section className="chat-section" aria-labelledby="chat-title">
      <div className="chat-heading">
        <MessageSquare aria-hidden="true" size={15} />
        <h2 id="chat-title">Room chat</h2>
      </div>
      <div className="chat-messages" ref={messageListRef} aria-live="polite">
        {snapshot.chat.length === 0 ? (
          <p className="empty-chat">Say hello with a quick message.</p>
        ) : (
          snapshot.chat.map((chatMessage) => {
            const isYou = chatMessage.player === session.player;
            const sender = isYou ? "You" : snapshot.players[chatMessage.player]?.name ?? playerName(chatMessage.player);
            return (
              <div className={`chat-message ${isYou ? "own" : "opponent"}`} key={chatMessage.id}>
                <strong>{sender}</strong>
                <p>{chatMessage.text}</p>
              </div>
            );
          })
        )}
      </div>
      <div className="quick-chat" aria-label="Quick messages">
        {QUICK_CHAT_MESSAGES.map((quickMessage) => (
          <button
            key={quickMessage}
            type="button"
            disabled={!connected}
            onClick={() => onSend(quickMessage, () => undefined)}
          >
            {quickMessage}
          </button>
        ))}
      </div>
    </section>
  );
}

function ConnectionScreen({ label }: { label: string }) {
  return (
    <main className="multiplayer-page">
      <section className="queue-screen" aria-live="polite">
        <LoaderCircle className="queue-spinner" aria-hidden="true" size={34} />
        <h1>{label}</h1>
      </section>
    </main>
  );
}

function normalizeRoomCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function writeSession(session: PlayerSession) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function readSession(): PlayerSession | null {
  try {
    const value = sessionStorage.getItem(SESSION_KEY);
    return value ? JSON.parse(value) as PlayerSession : null;
  } catch {
    return null;
  }
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}
