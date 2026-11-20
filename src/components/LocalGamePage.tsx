import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, FlipVertical2, Home, Pause, Play, RotateCcw } from "lucide-react";
import {
  type GameRules,
  type Move,
  type Player,
  createInitialState,
  opponentOf,
  playerName,
  tryMove
} from "../game";
import { BOT_LEVELS, BOT_TICK_MS, BotAgent, type BotLevel } from "../bot";
import { getPlayerIdentity } from "../playerIdentity";
import { clockNow, pauseClock, resumeClock, startClock, type GameClock } from "../variant/clock";
import { Board } from "../ui/Board";
import { MoveFeed, PlayerBar, RulesDialog, SoundToggle, StartCountdown, StatusBar, cooldownLabel } from "../ui/GameChrome";
import { GameOverDialog } from "../ui/GameOverDialog";
import { Modal } from "../ui/Modal";
import { useClockTick, useGameSounds, useKingDanger, useMoveEffects, useSelections, type ClockView } from "../ui/realtime";

type GameDialog = "new-game" | "rules" | null;

export type BotOpponent = { player: Player; level: BotLevel };

type LocalGamePageProps = {
  initialRules: GameRules;
  onExit: () => void;
  // Without a bot this is a same-screen game: two people at one device.
  bot?: BotOpponent;
  // Replaces the panel's "Same screen" / "Vs bot" label, e.g. while a quick match is searching.
  kicker?: string;
  // Same-screen only: draw Black's pieces upside down for the player sitting opposite.
  initialFlipBlack?: boolean;
};

const BOTH_SIDES: readonly Player[] = ["white", "black"];
const ONLY: Record<Player, readonly Player[]> = { white: ["white"], black: ["black"] };

// The game clock of a local game. It runs on performance.now() and stops whenever `paused` is
// true, so opening a dialog or hiding the tab freezes every cooldown.
function useLocalClock(paused: boolean) {
  const clockRef = useRef<GameClock | null>(null);
  if (!clockRef.current) clockRef.current = startClock(performance.now());
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const wall = performance.now();
    clockRef.current = paused ? pauseClock(clockRef.current!, wall) : resumeClock(clockRef.current!, wall);
    setEpoch((current) => current + 1);
  }, [paused]);

  const restart = useCallback(() => {
    clockRef.current = startClock(performance.now());
    setEpoch((current) => current + 1);
  }, []);

  const view: ClockView = useMemo(
    () => ({ now: () => clockNow(clockRef.current!, performance.now()), running: !paused, epoch }),
    [paused, epoch]
  );
  return { clock: view, restart };
}

function useTabHidden() {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return hidden;
}

export function LocalGamePage({ initialRules, onExit, bot, kicker, initialFlipBlack = false }: LocalGamePageProps) {
  const [state, setState] = useState(() => createInitialState(initialRules));
  const [gameNumber, setGameNumber] = useState(0);
  const [dialog, setDialog] = useState<GameDialog>(null);
  const [userPaused, setUserPaused] = useState(false);
  const [flipBlack, setFlipBlack] = useState(initialFlipBlack);
  const tabHidden = useTabHidden();

  const botPlayer = bot?.player ?? null;
  const botLevel = bot?.level ?? null;
  const humanPlayer = botPlayer ? opponentOf(botPlayer) : null;
  // The human's pieces sit at the bottom; a same-screen game keeps White at the bottom.
  const perspective: Player = humanPlayer ?? "white";
  const topPlayer = opponentOf(perspective);
  const sides = humanPlayer ? ONLY[humanPlayer] : BOTH_SIDES;
  const playing = state.status.phase === "playing";

  const paused = !playing || userPaused || dialog !== null || tabHidden;
  const { clock, restart } = useLocalClock(paused);
  const now = useClockTick(state, clock);
  const { animations, onAnimationEnd } = useMoveEffects(state, perspective);
  const dangerSquares = useKingDanger(state, now, sides);
  useGameSounds(state, now, humanPlayer);

  const stateRef = useRef(state);
  stateRef.current = state;

  // Every move, from either player or the bot, goes through the engine with the clock's time.
  const playMove = useCallback(
    (player: Player, moveId: string) => {
      const result = tryMove(stateRef.current, player, moveId, clock.now());
      if (!result.ok) return;
      stateRef.current = result.state;
      setState(result.state);
    },
    [clock]
  );

  const { selections, notices, onSquareDown, onSquareUp, clear } = useSelections({
    state,
    now,
    clock,
    sides,
    enabled: playing && !paused,
    onMove: useCallback((player: Player, move: Move) => playMove(player, move.id), [playMove])
  });

  // The bot: one small decision every tick, on the game clock (so it pauses with the game).
  const agent = useMemo(
    () => (botPlayer && botLevel ? new BotAgent(botPlayer, botLevel) : null),
    // A new game (gameNumber) gets a new agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [botPlayer, botLevel, gameNumber]
  );
  useEffect(() => {
    if (!agent || !botPlayer || paused) return;
    const timer = window.setInterval(() => {
      const moveId = agent.tick(stateRef.current, clock.now());
      if (moveId) playMove(botPlayer, moveId);
    }, BOT_TICK_MS);
    return () => window.clearInterval(timer);
  }, [agent, botPlayer, paused, clock, playMove]);

  function resetBoard() {
    const fresh = createInitialState(state.rules);
    stateRef.current = fresh;
    setState(fresh);
    setGameNumber((current) => current + 1);
    setUserPaused(false);
    setDialog(null);
    clear();
    restart();
  }

  const botName = botLevel ? `${BOT_LEVELS[botLevel].label} bot` : null;
  const ownName = bot ? getPlayerIdentity().name : "Player 1";
  const started = state.moveLog.length > 0;
  const showPauseCard = playing && userPaused && dialog === null;

  return (
    <main className="game-page">
      <section className="game-workspace" aria-label={bot ? "Game against a bot" : "Same-screen game"}>
        <div className="board-column">
          <PlayerBar
            player={topPlayer}
            name={botName ?? "Player 2"}
            tag={bot ? `Bot · ${playerName(topPlayer)}` : playerName(topPlayer)}
            state={state}
            now={now}
            live={playing && !paused && now >= 0}
            isBot={Boolean(bot)}
            flipped={!bot && flipBlack}
          />

          <Board
            state={state}
            perspective={perspective}
            label="Chess board"
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
            flipBlack={!bot && flipBlack}
            overlay={<StartCountdown state={state} now={now} paused={paused} />}
          />

          <PlayerBar
            player={perspective}
            name={ownName}
            tag={bot ? `You · ${playerName(perspective)}` : playerName(perspective)}
            state={state}
            now={now}
            live={playing && !paused && now >= 0}
          />

          {showPauseCard ? (
            <div className="game-event-layer" role="status">
              <section className="game-event-card">
                <span className="game-event-icon" aria-hidden="true"><Pause size={28} /></span>
                <p className="section-kicker">Paused</p>
                <h2>Every cooldown is frozen</h2>
                <p>The board is hidden while the game is paused.</p>
                <div className="game-event-actions">
                  <button className="button primary" type="button" onClick={() => setUserPaused(false)}>
                    <Play aria-hidden="true" size={17} />
                    Resume
                  </button>
                </div>
              </section>
            </div>
          ) : null}
        </div>

        <aside className="game-panel" aria-label="Game controls and move feed">
          <header className="game-panel-header">
            <button className="icon-button" type="button" onClick={onExit} aria-label="Return home" title="Home">
              <Home aria-hidden="true" size={19} />
            </button>
            <div>
              <p className="section-kicker">{kicker ?? `${bot ? "Vs bot" : "Same screen"} · ${cooldownLabel(state.rules)}`}</p>
              <strong>{botName ?? "Two players, one board"}</strong>
            </div>
            <SoundToggle />
          </header>

          <StatusBar
            state={state}
            now={now}
            paused={playing && paused}
            danger={Boolean(humanPlayer) && dangerSquares.length > 0}
            message={!bot && playing && !paused && now >= 0 ? "No turns. Both of you can move at once." : undefined}
          />

          <MoveFeed state={state} />

          <footer className={`game-actions ${bot ? "" : "four-actions"}`}>
            <button
              type="button"
              onClick={() => (!started || !playing ? resetBoard() : setDialog("new-game"))}
              title="Start a new game"
            >
              <RotateCcw aria-hidden="true" size={19} />
              <span>New game</span>
            </button>
            <button type="button" onClick={() => setUserPaused((current) => !current)} disabled={!playing} title="Pause the game">
              {userPaused ? <Play aria-hidden="true" size={19} /> : <Pause aria-hidden="true" size={19} />}
              <span>{userPaused ? "Resume" : "Pause"}</span>
            </button>
            {bot ? null : (
              <button
                type="button"
                className={flipBlack ? "toggled" : ""}
                aria-pressed={flipBlack}
                onClick={() => setFlipBlack((current) => !current)}
                title="Turn Black's pieces to face a player sitting opposite"
              >
                <FlipVertical2 aria-hidden="true" size={19} />
                <span>Flip Black</span>
              </button>
            )}
            <button type="button" onClick={() => setDialog("rules")} title="View rules">
              <BookOpen aria-hidden="true" size={19} />
              <span>Rules</span>
            </button>
          </footer>
        </aside>
      </section>

      {dialog === "new-game" ? (
        <Modal
          title="Start a new game?"
          description="The current game and its move feed will be cleared."
          onClose={() => setDialog(null)}
        >
          <div className="modal-actions">
            <button className="button secondary" type="button" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button className="button primary" type="button" data-autofocus onClick={resetBoard}>
              <RotateCcw aria-hidden="true" size={17} />
              Start new game
            </button>
          </div>
        </Modal>
      ) : null}

      {dialog === null ? (
        <GameOverDialog
          state={state}
          you={humanPlayer}
          actions={[
            { label: "Play again", onClick: resetBoard },
            { label: "Main menu", onClick: onExit }
          ]}
        />
      ) : null}

      {dialog === "rules" ? <RulesDialog onClose={() => setDialog(null)} /> : null}
    </main>
  );
}
