import { useMemo, type CSSProperties, type ReactNode } from "react";
import type { Piece, PieceKind, Player } from "../game";
import bishopBlack from "../assets/pieces/bishop-black.webp";
import bishopWhite from "../assets/pieces/bishop-white.webp";
import kingBlack from "../assets/pieces/king-black.webp";
import kingWhite from "../assets/pieces/king-white.webp";
import knightBlack from "../assets/pieces/knight-black.webp";
import knightWhite from "../assets/pieces/knight-white.webp";
import pawnBlack from "../assets/pieces/pawn-black.webp";
import pawnWhite from "../assets/pieces/pawn-white.webp";
import queenBlack from "../assets/pieces/queen-black.webp";
import queenWhite from "../assets/pieces/queen-white.webp";
import rookBlack from "../assets/pieces/rook-black.webp";
import rookWhite from "../assets/pieces/rook-white.webp";

// Sprites rendered by art/render.mjs. A new game swaps this table (and the files behind it).
const SPRITES: Record<Player, Record<PieceKind, string>> = {
  white: { pawn: pawnWhite, knight: knightWhite, bishop: bishopWhite, rook: rookWhite, queen: queenWhite, king: kingWhite },
  black: { pawn: pawnBlack, knight: knightBlack, bishop: bishopBlack, rook: rookBlack, queen: queenBlack, king: kingBlack }
};

export function pieceSprite(player: Player, kind: PieceKind) {
  return SPRITES[player][kind];
}

// A move animation: the piece is already on its new square and animates in from the old one.
// Offsets are in board cells (the piece box is exactly one cell) and point back to the origin.
export type PieceAnimation = {
  id: number;
  pieceId: string;
  mode: "slide" | "hop";
  dx: number;
  dy: number;
  // A second piece that slides in the same move (the rook when castling).
  companion?: { pieceId: string; dx: number; dy: number };
};

// What the token needs to draw a cooldown: how long is left right now, out of how much.
export type Cooldown = {
  remainingMs: number;
  totalMs: number;
  // False while the game clock is paused: the ring holds still.
  running: boolean;
};

type PieceTokenProps = {
  piece: Piece;
  animation?: PieceAnimation | null;
  onAnimationEnd?: (animationId: number) => void;
  cooldown?: Cooldown | null;
  // The piece came off cooldown a moment ago: play the "ready" flash once.
  justReady?: boolean;
  // A short message over the piece (why a tap did nothing).
  notice?: ReactNode;
};

export function PieceToken({ piece, animation = null, onAnimationEnd, cooldown = null, justReady = false, notice }: PieceTokenProps) {
  const style = animation
    ? ({ "--dx": `${animation.dx * 100}%`, "--dy": `${animation.dy * 100}%` } as CSSProperties)
    : undefined;
  const classes = [
    "piece",
    piece.kind,
    piece.player,
    cooldown ? "cooling" : "",
    notice ? "denied" : "",
    animation ? `animate-${animation.mode}` : ""
  ];

  return (
    <span
      className={classes.filter(Boolean).join(" ")}
      style={style}
      aria-hidden="true"
      onAnimationEnd={(event) => {
        if (animation && event.target === event.currentTarget) onAnimationEnd?.(animation.id);
      }}
    >
      {cooldown ? <CooldownRing cooldown={cooldown} player={piece.player} /> : null}
      {justReady && !cooldown ? <span className={`ready-flash ${piece.player}`} /> : null}
      <img className="piece-art" src={pieceSprite(piece.player, piece.kind)} alt="" draggable="false" />
      {notice ? <span className="piece-notice">{notice}</span> : null}
    </span>
  );
}

// The ring is one CSS animation: it is told once how long the cooldown is and how far in it
// already is (a negative delay), then the browser drains it with no JavaScript. The parent
// gives the token a new key whenever the clock is paused, resumed or re-synchronised, so the
// values are read again exactly then.
function CooldownRing({ cooldown, player }: { cooldown: Cooldown; player: Player }) {
  const style = useMemo(
    () =>
      ({
        "--cd-total": `${cooldown.totalMs}ms`,
        "--cd-delay": `${-Math.max(0, cooldown.totalMs - cooldown.remainingMs)}ms`
      }) as CSSProperties,
    // Deliberately computed once per mount; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  return (
    <span className={`cooldown-ring ${player}${cooldown.running ? "" : " paused"}`} style={style}>
      <svg viewBox="0 0 40 40" focusable="false">
        <circle className="cooldown-track" cx="20" cy="20" r="17" />
        <circle className="cooldown-arc" cx="20" cy="20" r="17" pathLength="100" />
      </svg>
    </span>
  );
}
