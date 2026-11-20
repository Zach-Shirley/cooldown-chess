// The parts around the board that every game mode shares: player bars, the status line, the
// move feed, the start countdown, the cooldown picker, the rules dialog and the sound toggle.
import { useEffect, useRef, type ReactNode } from "react";
import { Bot, ExternalLink, Timer, Volume2, VolumeX } from "lucide-react";
import { isReady, listPieces, type GameRules, type GameState, type PieceKind, type Player } from "../game";
import { setMuted, useMuted } from "../sound";
import { formatClock } from "../variant/clock";
import { COOLDOWN_CHOICES_MS, DEFAULT_COOLDOWN_MS } from "../variant/interpretation";
import { MaterialStrip } from "./MaterialStrip";
import { Modal } from "./Modal";
import { pieceSprite } from "./PieceToken";
import { GO_FLASH_MS } from "./realtime";

export const cooldownLabel = (rules: GameRules) => `${rules.cooldownMs / 1000} s cooldown`;

export function PlayerBar({
  player,
  name,
  tag,
  state,
  now,
  live,
  isBot = false,
  offline = false,
  flipped = false
}: {
  player: Player;
  name: string;
  // Short role line under the name, e.g. "You · White".
  tag: string;
  state: GameState;
  now: number;
  // The game is running: this side can move.
  live: boolean;
  isBot?: boolean;
  offline?: boolean;
  // Turned to face a player sitting on the far side of the device.
  flipped?: boolean;
}) {
  const pieces = listPieces(state, player);
  const ready = pieces.filter(({ piece }) => isReady(piece, now)).length;
  return (
    <div className={`player-bar ${player} ${live ? "active" : ""} ${offline ? "disconnected" : ""} ${flipped ? "flipped" : ""}`}>
      <span className="player-avatar" aria-hidden="true">
        <img src={pieceSprite(player, "king")} alt="" draggable="false" />
        {isBot ? (
          <span className="avatar-badge">
            <Bot size={12} strokeWidth={2.4} />
          </span>
        ) : null}
      </span>
      <div className="player-identity">
        <strong>{name}</strong>
        <span>{tag}</span>
      </div>
      <MaterialStrip state={state} player={player} />
      <div className="player-turn-state" aria-label={`${ready} of ${pieces.length} pieces ready`}>
        <span className="turn-pip" aria-hidden="true" />
        {offline ? "Offline" : `${ready}/${pieces.length} ready`}
      </div>
    </div>
  );
}

export function StatusBar({
  state,
  now,
  paused,
  message,
  danger = false,
  action
}: {
  state: GameState;
  now: number;
  paused: boolean;
  // Overrides the default line under the title.
  message?: string;
  // The local player's king is in danger.
  danger?: boolean;
  action?: ReactNode;
}) {
  const { status } = state;
  const over = status.phase !== "playing";
  const counting = !over && now < 0;
  const title = over ? "Game over" : paused ? "Paused" : counting ? `Starting in ${Math.ceil(-now / 1000)}` : danger ? "Your king is in danger" : "Live";
  const fallback = over
    ? status.message
    : paused
      ? "Every cooldown is frozen."
      : counting
        ? "Both sides go live at the same instant."
        : danger
          ? "An enemy piece that attacks it is ready, or nearly."
          : "No turns. Move any piece that is ready.";
  const color = status.phase === "won" ? status.winner : status.phase === "draw" ? "draw" : "live";
  return (
    <section className={`turn-status ${over ? "game-over" : ""} ${danger && !over ? "danger" : ""} ${paused && !over ? "paused" : ""}`} aria-live="polite">
      <span className={`status-color ${color}`} />
      <div>
        <p>{title}</p>
        <span>{message ?? fallback}</span>
      </div>
      {action}
    </section>
  );
}

// The 3-2-1 before both sides go live, then a brief GO.
export function StartCountdown({ state, now, paused }: { state: GameState; now: number; paused: boolean }) {
  if (state.status.phase !== "playing" || now >= GO_FLASH_MS) return null;
  const value = now < 0 ? String(Math.ceil(-now / 1000)) : "GO";
  return (
    <div className={`countdown-layer ${now < 0 ? "counting" : "go"} ${paused ? "paused" : ""}`} role="status" aria-live="assertive">
      <span key={value} className="countdown-number">{value}</span>
    </div>
  );
}

// The move log as a timestamped feed, both colours interleaved: "0:07 Nf3".
export function MoveFeed({ state }: { state: GameState }) {
  const listRef = useRef<HTMLOListElement | null>(null);
  const latest = state.moveLog.length - 1;

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // Tall panels scroll down, the one-line phone strip scrolls sideways.
    list.scrollTop = list.scrollHeight;
    list.scrollLeft = list.scrollWidth;
  }, [state.moveLog.length]);

  return (
    <section className="moves-section" aria-labelledby="moves-title">
      <div className="moves-heading">
        <h2 id="moves-title">Moves</h2>
        <span>{state.moveLog.length}</span>
      </div>
      <ol className="move-list" ref={listRef}>
        {state.moveLog.length === 0 ? (
          <li className="empty-moves">No moves yet.</li>
        ) : (
          state.moveLog.map((entry, index) => (
            <li key={index} className={`move-entry ${entry.player} ${index === latest ? "latest" : ""}`}>
              <span className="move-time">{formatClock(entry.at)}</span>
              <span className="move-dot" aria-hidden="true" />
              <span className="move-san">{entry.notation}</span>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}

export function SoundToggle() {
  const muted = useMuted();
  return (
    <button
      className="icon-button"
      type="button"
      onClick={() => setMuted(!muted)}
      aria-label={muted ? "Turn sound on" : "Turn sound off"}
      title={muted ? "Sound off" : "Sound on"}
    >
      {muted ? <VolumeX aria-hidden="true" size={19} /> : <Volume2 aria-hidden="true" size={19} />}
    </button>
  );
}

// The cooldown length for a new game: 3, 5, 7 or 12 seconds.
export function CooldownPicker({ value, onChange }: { value: GameRules; onChange: (rules: GameRules) => void }) {
  return (
    <div className="color-picker cooldown-picker">
      <span className="field-caption">Cooldown after each move</span>
      <div className="segmented" role="radiogroup" aria-label="Cooldown length">
        {COOLDOWN_CHOICES_MS.map((cooldownMs) => (
          <button
            key={cooldownMs}
            type="button"
            role="radio"
            aria-checked={value.cooldownMs === cooldownMs}
            aria-label={`${cooldownMs / 1000} seconds`}
            data-cooldown={cooldownMs}
            className={value.cooldownMs === cooldownMs ? "active" : ""}
            onClick={() => onChange({ cooldownMs })}
          >
            {cooldownMs === DEFAULT_COOLDOWN_MS ? <Timer aria-hidden="true" size={15} /> : null}
            {cooldownMs / 1000} s
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The rules dialog
// ---------------------------------------------------------------------------------------------

const VIDEO_URL = "https://www.youtube.com/watch?v=y7VtSK23_Jg";
const REPO_URL = "https://github.com/misprit7/real-time-chess";
const HN_URL = "https://news.ycombinator.com/item?id=43514695";

// The four rules the game's creator states.
const CORE_RULES: { kind: PieceKind; title: string; text: string }[] = [
  { kind: "knight", title: "No turns", text: "Move whenever you like, whatever your opponent is doing. Both sides play at once." },
  {
    kind: "rook",
    title: "Every piece has its own cooldown",
    text: "After a piece moves it cannot move again until its ring has drained. Your other pieces are not affected."
  },
  { kind: "pawn", title: "A cooling piece can still be captured", text: "Cooling down only stops a piece from moving. It is not protected." },
  { kind: "king", title: "Capture the king to win", text: "There is no check and no checkmate. You lose when your king is actually taken." }
];

// What the creator left open, and what this app decided. Mirrors src/variant/interpretation.ts.
const INTERPRETATION: { title: string; text: string }[] = [
  { title: "Piece movement", text: "Pieces move as in chess and the app enforces it. With no check, a king may step into attack and nothing is ever pinned." },
  { title: "Castling", text: "Allowed while the king and that rook have not moved and the squares between them are empty, even through attack. Both pieces cool down." },
  { title: "En passant", text: "Only while the pawn that just advanced two squares is still on the cooldown from that move." },
  { title: "Promotion", text: "A pawn that reaches the far rank becomes a queen automatically, and that queen cools down like any piece that moved." },
  { title: "Two moves at once", text: "Moves are applied in the order they arrive. A move that is no longer possible when it arrives is dropped, with no penalty." },
  { title: "No premoves", text: "You can select a cooling piece to line a move up, but you have to play it yourself once the piece is ready." },
  { title: "Start", text: "A 3-2-1 countdown, then both sides are live at the same instant. Nobody moves first." },
  { title: "Draws", text: "Only when both sides are down to a bare king. There is no stalemate, repetition or fifty-move rule." },
  { title: "Online disconnects", text: "The game pauses and every cooldown freezes while a player is away, for up to 30 seconds. After that they forfeit." }
];

export function RulesDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="How to play" description="Chess without turns. Capture the enemy king." onClose={onClose} wide>
      <ul className="rules-list piece-rules">
        {CORE_RULES.map((rule) => (
          <li key={rule.title}>
            <img src={pieceSprite("white", rule.kind)} alt="" draggable="false" />
            <div>
              <strong>{rule.title}</strong>
              <p>{rule.text}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="rules-source">
        These four rules, and one cooldown length for every piece (his example is 5 seconds; his board offers 3, 7 and 12), come from the
        game&apos;s creator, Xander Naumenko, who built it as a physical electronic board:{" "}
        <a href={VIDEO_URL} target="_blank" rel="noreferrer">
          &ldquo;I Made Chess Without Turns&rdquo; <ExternalLink aria-hidden="true" size={12} />
        </a>
        ,{" "}
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          his project <ExternalLink aria-hidden="true" size={12} />
        </a>{" "}
        and{" "}
        <a href={HN_URL} target="_blank" rel="noreferrer">
          his comments <ExternalLink aria-hidden="true" size={12} />
        </a>
        . This app is an independent tribute, not his work.
      </p>

      <h3 className="rules-subtitle">This app&apos;s interpretation</h3>
      <p className="rules-source">His board does not check moves, so these details are our own decisions, not his rules.</p>
      <dl className="rules-notes">
        {INTERPRETATION.map((note) => (
          <div key={note.title}>
            <dt>{note.title}</dt>
            <dd>{note.text}</dd>
          </div>
        ))}
      </dl>

      <h3 className="rules-subtitle">Reading the board</h3>
      <dl className="rules-notes">
        <div>
          <dt>Rings</dt>
          <dd>A dimmed piece with a draining ring is cooling down. When the ring is gone it flashes and can move again.</dd>
        </div>
        <div>
          <dt>King warning</dt>
          <dd>Your king&apos;s square pulses red when an enemy piece that attacks it is ready or nearly ready. This is a hint from the app, not a rule: nothing forces you to react.</dd>
        </div>
      </dl>
      <div className="modal-actions single-action">
        <button className="button primary" type="button" onClick={onClose}>
          Got it
        </button>
      </div>
    </Modal>
  );
}
