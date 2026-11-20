// What the real-time game screens share: a view of the game clock, a re-render scheduler that
// wakes only when something on the board changes state, move animations, sounds, and the
// tap/drag selection logic for one or two players on the same board.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  findPiece,
  getKingInDanger,
  getMovesIgnoringCooldown,
  getPieceAt,
  isReady,
  listPieces,
  type GameState,
  type Move,
  type Player,
  type Square
} from "../game";
import { playSound, soundForMove } from "../sound";
import { KING_DANGER_SOON_MS } from "../variant/interpretation";
import type { PieceAnimation } from "./PieceToken";

// The game clock as a screen sees it. `now()` is always current; `epoch` changes whenever the
// clock is paused, resumed or re-synchronised, which restarts the CSS cooldown animations.
export type ClockView = {
  now: () => number;
  running: boolean;
  epoch: number;
};

// How long the "ready" flash and the "GO" flash stay on screen (CSS runs the animations).
export const READY_FLASH_MS = 480;
export const GO_FLASH_MS = 800;

// Returns the game time of this render, and schedules exactly one timeout for the next moment
// the picture changes: a countdown second, a piece becoming ready, a king-danger warning.
// Cooldown rings themselves are CSS animations and need no JavaScript while they drain.
export function useClockTick(state: GameState, clock: ClockView): number {
  const [, bump] = useReducer((count: number) => count + 1, 0);
  const now = clock.now();

  useEffect(() => {
    if (!clock.running || state.status.phase !== "playing") return;
    const current = clock.now();
    let next = Infinity;
    if (current < 0) next = (Math.floor(current / 1000) + 1) * 1000;
    else if (current < GO_FLASH_MS) next = GO_FLASH_MS;
    for (const { piece } of listPieces(state)) {
      for (const point of [piece.readyAt - KING_DANGER_SOON_MS, piece.readyAt, piece.readyAt + READY_FLASH_MS]) {
        if (point > current && point < next) next = point;
      }
    }
    if (next === Infinity) return;
    const timer = window.setTimeout(bump, Math.max(4, next - current + 2));
    return () => window.clearTimeout(timer);
  });

  return now;
}

function animationFor(entry: GameState["moveLog"][number], id: number, perspective: Player): PieceAnimation {
  const flip = perspective === "black" ? -1 : 1;
  // The piece is already on its new square and animates in from the old one.
  const offset = (from: Square, to: Square) => ({ dx: (from.col - to.col) * flip, dy: (from.row - to.row) * flip });
  return {
    id,
    pieceId: entry.pieceId,
    mode: entry.pieceKind === "knight" ? "hop" : "slide",
    ...offset(entry.from, entry.to),
    companion: entry.rook ? { pieceId: entry.rook.pieceId, ...offset(entry.rook.from, entry.rook.to) } : undefined
  };
}

// Animates and sounds every move that appears in the log. Several can run at once.
export function useMoveEffects(state: GameState, perspective: Player) {
  const [animations, setAnimations] = useState<PieceAnimation[]>([]);
  const seen = useRef(state.moveLog.length);

  useEffect(() => {
    const total = state.moveLog.length;
    if (total < seen.current) {
      // A new game.
      seen.current = total;
      setAnimations([]);
      return;
    }
    if (total === seen.current) return;
    const fresh = state.moveLog.slice(seen.current).map((entry, index) => animationFor(entry, seen.current + index + 1, perspective));
    // After a reconnect the log can jump by many moves; only the newest few are worth showing.
    const recent = fresh.slice(-4);
    for (const entry of state.moveLog.slice(-recent.length)) playSound(soundForMove(entry));
    seen.current = total;
    setAnimations((current) => [...current.filter((item) => !recent.some((next) => next.pieceId === item.pieceId)), ...recent]);
  }, [state.moveLog, perspective]);

  const onAnimationEnd = useCallback((animationId: number) => {
    setAnimations((current) => current.filter((item) => item.id !== animationId));
  }, []);

  return { animations, onAnimationEnd };
}

// The squares of the kings that are in danger, for the players on this device.
export function useKingDanger(state: GameState, now: number, sides: readonly Player[]): Square[] {
  const squares: Square[] = [];
  for (const side of sides) {
    const square = getKingInDanger(state, side, now);
    if (square) squares.push(square);
  }
  const count = squares.length;
  const lastAlert = useRef(0);
  const previous = useRef(0);
  useEffect(() => {
    // Sound the alarm when a king newly comes under threat, but not in a constant stream.
    if (count > previous.current && performance.now() - lastAlert.current > 1200) {
      lastAlert.current = performance.now();
      playSound("danger");
    }
    previous.current = count;
  }, [count]);
  return squares;
}

// Countdown beeps, the start signal and the result jingle.
export function useGameSounds(state: GameState, now: number, you: Player | null) {
  const phase = state.status.phase;
  const winner = state.status.phase === "won" ? state.status.winner : null;
  useEffect(() => {
    if (phase === "draw") playSound("draw");
    if (phase === "won") playSound(you && winner !== you ? "lose" : "win");
  }, [phase, winner, you]);

  const second = now < 0 ? Math.ceil(-now / 1000) : 0;
  const lastSecond = useRef(second);
  useEffect(() => {
    if (second !== lastSecond.current) {
      if (second > 0) playSound("count");
      else if (lastSecond.current > 0 && phase === "playing") playSound("go");
      lastSecond.current = second;
    }
  }, [second, phase]);
}

export type Selection = {
  player: Player;
  pieceId: string;
  targets: Move[];
  // The selected piece is still cooling: its targets are shown, but it cannot move yet.
  pending: boolean;
};

// A short message pinned to a piece: why a tap did nothing.
export type BoardNotice = {
  id: number;
  pieceId: string;
  text: string;
};

const NOTICE_MS = 950;
let nextNoticeId = 1;

// Selection for the players who share this board (`sides`): one in a bot or online game, both
// in a same-screen game, each with their own selected piece. Works with taps (press a piece,
// press a target) and drags (press a piece, release on a target), from any number of pointers.
export function useSelections({
  state,
  now,
  clock,
  sides,
  enabled,
  onMove
}: {
  state: GameState;
  now: number;
  clock: ClockView;
  sides: readonly Player[];
  enabled: boolean;
  onMove: (player: Player, move: Move) => void;
}) {
  const [selected, setSelected] = useState<Record<Player, string | null>>({ white: null, black: null });
  const [notices, setNotices] = useState<BoardNotice[]>([]);
  // The side that selected most recently wins a square both sides could move to.
  const selectedAt = useRef<Record<Player, number>>({ white: 0, black: 0 });
  // A press on the piece that was already selected: releasing on the same square unselects it.
  const toggleOff = useRef<Record<Player, string | null>>({ white: null, black: null });
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const stateRef = useRef(state);
  stateRef.current = state;

  const selections = useMemo(() => {
    const list: Selection[] = [];
    for (const player of sides) {
      const pieceId = selected[player];
      const located = pieceId ? findPiece(state, pieceId) : null;
      if (!pieceId || !located || located.piece.player !== player) continue;
      const targets = getMovesIgnoringCooldown(state, player, now).filter((move) => move.pieceId === pieceId);
      list.push({ player, pieceId, targets, pending: now < 0 || !isReady(located.piece, now) });
    }
    return list;
  }, [selected, sides, state, now]);

  // A selected piece that was captured (or a finished game) drops its selection.
  useEffect(() => {
    setSelected((current) => {
      let next = current;
      for (const player of ["white", "black"] as const) {
        const pieceId = current[player];
        if (!pieceId) continue;
        const located = findPiece(state, pieceId);
        if (!located || located.piece.player !== player || state.status.phase !== "playing") next = { ...next, [player]: null };
      }
      return next;
    });
  }, [state]);

  const notify = useCallback((pieceId: string, text: string) => {
    const id = nextNoticeId++;
    setNotices((current) => [...current.filter((notice) => notice.pieceId !== pieceId), { id, pieceId, text }]);
    window.setTimeout(() => setNotices((current) => current.filter((notice) => notice.id !== id)), NOTICE_MS);
  }, []);

  const select = useCallback((player: Player, pieceId: string | null) => {
    selectedAt.current[player] = performance.now();
    setSelected((current) => (current[player] === pieceId ? current : { ...current, [player]: pieceId }));
  }, []);

  // Plays the move if its piece is ready; otherwise says why nothing happened.
  const attempt = useCallback(
    (player: Player, move: Move) => {
      const current = stateRef.current;
      const located = findPiece(current, move.pieceId);
      if (!located) return;
      const time = clock.now();
      if (time < 0) {
        notify(move.pieceId, "Wait for GO");
        playSound("deny");
        return;
      }
      if (!isReady(located.piece, time)) {
        notify(move.pieceId, `${((located.piece.readyAt - time) / 1000).toFixed(1)}s`);
        playSound("deny");
        return;
      }
      select(player, null);
      onMove(player, move);
    },
    [clock, notify, onMove, select]
  );

  const targetOn = useCallback(
    (square: Square) => {
      const current = stateRef.current;
      const time = clock.now();
      const candidates: { player: Player; move: Move }[] = [];
      for (const player of sides) {
        const pieceId = selectedRef.current[player];
        if (!pieceId) continue;
        const move = getMovesIgnoringCooldown(current, player, time).find(
          (candidate) => candidate.pieceId === pieceId && candidate.to.row === square.row && candidate.to.col === square.col
        );
        if (move) candidates.push({ player, move });
      }
      candidates.sort((a, b) => selectedAt.current[b.player] - selectedAt.current[a.player]);
      return candidates[0] ?? null;
    },
    [clock, sides]
  );

  const onSquareDown = useCallback(
    (square: Square) => {
      if (!enabled) return;
      const target = targetOn(square);
      if (target) {
        attempt(target.player, target.move);
        return;
      }
      const piece = getPieceAt(stateRef.current, square);
      if (piece && sides.includes(piece.player)) {
        toggleOff.current[piece.player] = selectedRef.current[piece.player] === piece.id ? piece.id : null;
        select(piece.player, piece.id);
        return;
      }
      // With one player at the board, a tap anywhere else clears the selection. With two, it
      // could be either player's finger, so each clears their own by tapping their piece again.
      if (sides.length === 1) select(sides[0], null);
    },
    [attempt, enabled, select, sides, targetOn]
  );

  const onSquareUp = useCallback(
    (square: Square, downSquare: Square) => {
      if (!enabled) return;
      const pressed = getPieceAt(stateRef.current, downSquare);
      if (!pressed || !sides.includes(pressed.player)) return;
      const player = pressed.player;
      if (square.row === downSquare.row && square.col === downSquare.col) {
        if (toggleOff.current[player] === pressed.id) select(player, null);
        toggleOff.current[player] = null;
        return;
      }
      // A drag: the piece pressed on is released over one of its targets.
      toggleOff.current[player] = null;
      if (selectedRef.current[player] !== pressed.id) return;
      const move = getMovesIgnoringCooldown(stateRef.current, player, clock.now()).find(
        (candidate) => candidate.pieceId === pressed.id && candidate.to.row === square.row && candidate.to.col === square.col
      );
      if (move) attempt(player, move);
    },
    [attempt, clock, enabled, select, sides]
  );

  const clear = useCallback(() => setSelected({ white: null, black: null }), []);

  return { selections, notices, notify, onSquareDown, onSquareUp, clear };
}
