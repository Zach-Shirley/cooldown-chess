import { useRef, type ReactNode } from "react";
import {
  BOARD_SIZE,
  getPieceAt,
  isDarkSquare,
  isReady,
  parseSquare,
  pieceName,
  playerName,
  squareName,
  type GameState,
  type Move,
  type Piece,
  type Player,
  type Square
} from "../game";
import { START_COUNTDOWN_MS } from "../variant/interpretation";
import { PieceToken, type PieceAnimation } from "./PieceToken";
import { READY_FLASH_MS, type BoardNotice, type ClockView, type Selection } from "./realtime";

const indexes = Array.from({ length: BOARD_SIZE }, (_, index) => index);

type BoardProps = {
  state: GameState;
  // Whose pieces sit at the bottom of the screen.
  perspective: Player;
  label: string;
  // The game time of this render and the clock it came from (cooldown rings read both).
  now: number;
  clock: ClockView;
  // One selection per player at this device: the selected piece and where it can go.
  selections: Selection[];
  // The sides that can be played from this device (their pieces get a pointer cursor).
  sides: readonly Player[];
  animations: PieceAnimation[];
  onAnimationEnd: (animationId: number) => void;
  // Pointer input, one call per finger: where it went down, and where it came up.
  onSquareDown: (square: Square) => void;
  onSquareUp: (square: Square, downSquare: Square) => void;
  // Kings to warn about (a UI aid; there is no check in the rules).
  dangerSquares?: Square[];
  notices?: BoardNotice[];
  // Draw Black's pieces upside down, for a player sitting on the far side of one device.
  flipBlack?: boolean;
  // Drawn over the board: the start countdown.
  overlay?: ReactNode;
};

// The one board renderer, shared by same-screen, bot and online games.
export function Board({
  state,
  perspective,
  label,
  now,
  clock,
  selections,
  sides,
  animations,
  onAnimationEnd,
  onSquareDown,
  onSquareUp,
  dangerSquares = [],
  notices = [],
  flipBlack = false,
  overlay
}: BoardProps) {
  const rows = perspective === "black" ? [...indexes].reverse() : indexes;
  const cols = perspective === "black" ? [...indexes].reverse() : indexes;
  // Where each active pointer went down, so a release elsewhere is a drag.
  const pressed = useRef(new Map<number, Square>());

  // The latest move of each side stays tinted.
  const lastMoves: Partial<Record<Player, GameState["moveLog"][number]>> = {};
  for (let index = state.moveLog.length - 1; index >= 0 && !(lastMoves.white && lastMoves.black); index -= 1) {
    const entry = state.moveLog[index];
    lastMoves[entry.player] ??= entry;
  }
  const lastMoveBy = (row: number, col: number): Player | null => {
    for (const player of ["white", "black"] as const) {
      const entry = lastMoves[player];
      if (entry && ((entry.from.row === row && entry.from.col === col) || (entry.to.row === row && entry.to.col === col))) return player;
    }
    return null;
  };

  const animationFor = (piece: Piece): PieceAnimation | null => {
    for (const animation of animations) {
      if (animation.pieceId === piece.id) return animation;
      if (animation.companion?.pieceId === piece.id) return { ...animation, ...animation.companion, mode: "slide", companion: undefined };
    }
    return null;
  };

  const squareUnder = (x: number, y: number): Square | null => {
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-square]");
    return element?.dataset.square ? parseSquare(element.dataset.square) : null;
  };

  return (
    <div className="board-frame">
      <div
        className={`board${flipBlack ? " flip-black" : ""}`}
        role="grid"
        aria-label={label}
        onPointerUp={(event) => {
          const down = pressed.current.get(event.pointerId);
          pressed.current.delete(event.pointerId);
          const up = squareUnder(event.clientX, event.clientY);
          if (down && up) onSquareUp(up, down);
        }}
        onPointerCancel={(event) => pressed.current.delete(event.pointerId)}
      >
        {rows.flatMap((row, visualRow) =>
          cols.map((col, visualCol) => {
            const square = { row, col };
            const piece = getPieceAt(state, square);
            let target: Move | undefined;
            let targetOwner: Selection | undefined;
            for (const selection of selections) {
              const move = selection.targets.find((candidate) => candidate.to.row === row && candidate.to.col === col);
              if (move) {
                target = move;
                targetOwner = selection;
              }
            }
            const selectedBy = piece ? selections.find((selection) => selection.pieceId === piece.id) : undefined;
            const inDanger = dangerSquares.some((danger) => danger.row === row && danger.col === col);
            const lastBy = lastMoveBy(row, col);
            const cooling = piece ? !isReady(piece, now) : false;
            const justReady = Boolean(piece && !cooling && now - piece.readyAt < READY_FLASH_MS);
            const notice = piece ? notices.find((item) => item.pieceId === piece.id) : undefined;
            const playable = Boolean(piece && sides.includes(piece.player));
            const classes = [
              "square",
              isDarkSquare(square) ? "dark-square" : "light-square",
              target ? "legal-square" : "",
              target?.captures.length ? "capture-square" : "",
              targetOwner?.pending ? "pending-target" : "",
              playable ? "movable-square" : "",
              selectedBy ? `selected-square by-${selectedBy.player}` : "",
              lastBy ? `last-move-square last-${lastBy}` : "",
              inDanger ? "danger-square" : ""
            ];

            return (
              <button
                className={classes.filter(Boolean).join(" ")}
                key={`${row}-${col}`}
                type="button"
                role="gridcell"
                data-square={squareName(square)}
                data-piece={piece ? `${piece.player}-${piece.kind}` : undefined}
                data-cooling={cooling ? "true" : undefined}
                aria-label={squareAriaLabel(square, piece, target, cooling, inDanger)}
                onPointerDown={(event) => {
                  if (event.button > 0) return;
                  // Touch pointers are captured by the element they start on; release that so
                  // the pointerup reports where the finger really is.
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                  pressed.current.set(event.pointerId, square);
                  onSquareDown(square);
                }}
                onClick={(event) => {
                  // Pointer input is handled above; this is the keyboard (Enter or Space).
                  if (event.detail !== 0) return;
                  onSquareDown(square);
                  onSquareUp(square, square);
                }}
              >
                {visualCol === 0 ? <span className="rank-label" aria-hidden="true">{BOARD_SIZE - row}</span> : null}
                {visualRow === BOARD_SIZE - 1 ? <span className="file-label" aria-hidden="true">{String.fromCharCode(97 + col)}</span> : null}
                {target && targetOwner ? <span className={`move-target ${targetOwner.player}`} aria-hidden="true" /> : null}
                {piece ? (
                  <PieceToken
                    // A new key restarts the ring's CSS animation from freshly read values.
                    key={`${piece.id}:${piece.readyAt}:${clock.epoch}`}
                    piece={piece}
                    animation={animationFor(piece)}
                    onAnimationEnd={onAnimationEnd}
                    cooldown={
                      cooling
                        ? {
                            remainingMs: piece.readyAt - clock.now(),
                            // Before the start, every piece's ring is the countdown itself.
                            totalMs: piece.readyAt === 0 ? START_COUNTDOWN_MS : state.rules.cooldownMs,
                            running: clock.running
                          }
                        : null
                    }
                    justReady={justReady}
                    notice={notice?.text}
                  />
                ) : null}
              </button>
            );
          })
        )}
      </div>
      {overlay}
    </div>
  );
}

function squareAriaLabel(square: Square, piece: Piece | null, move: Move | undefined, cooling: boolean, inDanger: boolean) {
  const contents = piece ? `${playerName(piece.player)} ${pieceName(piece.kind)}` : "empty";
  const coolingText = cooling ? ", cooling down" : "";
  const dangerText = inDanger ? ", king in danger" : "";
  const moveText = move ? (move.captures.length > 0 ? ", capture destination" : ", move destination") : "";
  return `${squareName(square)}, ${contents}${coolingText}${dangerText}${moveText}`;
}
