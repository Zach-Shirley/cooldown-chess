// End-to-end checks in a real browser, at desktop (1440x900) and phone (402x874) sizes:
//   - a game against the hard bot, played until a king is captured; cooldown rings, the
//     "still cooling" notice, pause and resume
//   - same screen: both sides moving within the same second, two fingers at once (phone size),
//     castling, a king capture
//   - online between two browsers: both moving concurrently, a move refused for cooldown, a
//     disconnect that freezes the game and a reconnect that resumes it, a king capture, a rematch
//   - quick match by cooldown with a bot while waiting, generated names, side choice (phone size)
// Needs the web app and the game server running: npm run dev:multiplayer
// Run: node scripts/e2e-bots.mjs [baseUrl]
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import {
  SIZES,
  feed,
  isCooling,
  isGameOver,
  moveCount,
  multiTouch,
  openRoom,
  pieceOn,
  playLine,
  playMove,
  sanList,
  square,
  startBot,
  startSameScreen,
  statusTitle,
  tap,
  waitLive,
  waitReady,
  watchErrors
} from "./lib/board-dom.mjs";

const APP = process.argv[2] ?? "http://localhost:4374";
const out = "art/out";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const errors = [];
const check = (ok, message) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${message}`);
  if (!ok) process.exitCode = 1;
};
async function open(size, label) {
  const page = await (await browser.newContext(SIZES[size])).newPage();
  watchErrors(page, label, errors);
  return page;
}
const seconds = (time) => Number(time.split(":")[0]) * 60 + Number(time.split(":")[1]);
const countAtLeast = (page, count, timeout = 10000) =>
  page.waitForFunction((n) => Number(document.querySelector(".moves-heading span")?.textContent) >= n, count, { timeout });

for (const size of Object.keys(SIZES)) {
  const tag = `[${size}]`;

  // ---- 1. Against the hard bot, to a king capture ----
  const bot = await open(size, `${size}-bot`);
  await startBot(bot, APP, { level: "Hard", seconds: 3 });
  check(bot.url().endsWith("/bot"), `${tag} bot game opens at /bot`);
  check((await bot.locator(".game-panel-header strong").innerText()) === "Hard bot", `${tag} panel names the hard bot`);
  check(/^Starting in [123]$/.test(await statusTitle(bot)), `${tag} the game starts with a countdown`);
  await tap(bot, "e2", "e4");
  check((await pieceOn(bot, "e2")) === "white-pawn" && (await moveCount(bot)) === 0, `${tag} nothing moves during the countdown`);
  await square(bot, "e2").click();
  await waitLive(bot);
  await tap(bot, "e2", "e4");
  await countAtLeast(bot, 1);
  const first = (await feed(bot)).find((entry) => entry.side === "white");
  check(first?.san === "e4" && /^0:0\d$/.test(first.time), `${tag} the feed shows the move with its time (${first?.time} ${first?.san})`);
  check(await isCooling(bot, "e4"), `${tag} the moved piece is cooling`);
  check((await bot.locator('.board [data-square="e4"] .cooldown-ring.white .cooldown-arc').count()) === 1, `${tag} it shows a cooldown ring`);
  check(!(await isCooling(bot, "d2")), `${tag} the other pieces are not affected`);
  // Line a move up for a cooling knight (back to the square it came from) and try it too early.
  await tap(bot, "g1", "h3");
  await bot.waitForFunction(() => document.querySelector('.board [data-square="h3"]')?.dataset.piece === "white-knight");
  await square(bot, "h3").click();
  check((await bot.locator('.board .pending-target[data-square="g1"]').count()) === 1, `${tag} a cooling piece can be selected and shows its moves as pending`);
  await square(bot, "g1").click({ force: true });
  const notice = await bot.locator(".board .piece-notice").first().innerText().catch(() => "");
  check(/^\d\.\ds$/.test(notice), `${tag} trying a cooling piece says how long is left ("${notice}")`);
  check((await pieceOn(bot, "h3")) === "white-knight" && (await pieceOn(bot, "g1")) === null, `${tag} and the piece does not move`);
  // Pause freezes every cooldown: a piece moved just before the pause still owes almost all of it.
  await tap(bot, "a2", "a3");
  await bot.getByRole("button", { name: "Pause" }).click();
  check((await statusTitle(bot)) === "Paused", `${tag} the game can be paused`);
  await bot.waitForTimeout(3400);
  await bot.getByRole("button", { name: "Resume" }).first().click();
  check(await isCooling(bot, "a3"), `${tag} a 3 s cooldown has not ended after a 3.4 s pause`);
  const resumedAt = Date.now();
  await waitReady(bot, "a3", 6000);
  const owed = Date.now() - resumedAt;
  check(owed > 1500 && owed < 3600, `${tag} after resuming it still takes the rest of the cooldown (${owed} ms)`);

  // Walk the king straight at the enemy until somebody's king is taken.
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline && !(await isGameOver(bot))) {
    const king = await bot.locator('.board [data-piece="white-king"]').getAttribute("data-square").catch(() => null);
    if (!king) break;
    if (await isCooling(bot, king)) {
      await bot.waitForTimeout(150);
      continue;
    }
    await square(bot, king).click({ force: true }).catch(() => undefined);
    const targets = await bot.locator(".board .legal-square").evaluateAll((elements) => elements.map((element) => element.dataset.square));
    // Forward if possible, otherwise anywhere.
    targets.sort((a, b) => Number(b[1]) - Number(a[1]));
    if (targets.length) await square(bot, targets[0]).click({ force: true }).catch(() => undefined);
    else await bot.waitForTimeout(150);
  }
  const over = await isGameOver(bot);
  check(over, `${tag} the bot game ends (${await moveCount(bot)} moves)`);
  if (over) {
    const title = await bot.locator(".modal-dialog h2").innerText();
    const message = await bot.locator(".modal-dialog .modal-copy p").innerText();
    check(/Your king was captured|King captured!/.test(title), `${tag} the result screen says a king was captured: "${title}" (${message})`);
    check(/x[a-h][1-8]$/.test((await sanList(bot)).at(-1) ?? ""), `${tag} the last move in the feed is the capture (${(await sanList(bot)).at(-1)})`);
    await bot.screenshot({ path: `${out}/e2e-${size}-bot-game-over.png` });
    await bot.getByRole("button", { name: "Play again" }).click();
    check((await moveCount(bot)) === 0 && /^Starting in/.test(await statusTitle(bot)), `${tag} play again resets the board and the clock`);
  }
  await bot.context().close();

  // ---- 2. Same screen ----
  const local = await open(size, `${size}-local`);
  await startSameScreen(local, APP, 3);
  await waitLive(local);
  // Both colours are selected at once, then both move: no turn order.
  await square(local, "e2").click();
  await square(local, "e7").click();
  check((await local.locator(".board .selected-square").count()) === 2, `${tag} each side has its own selection`);
  await square(local, "e4").click();
  await square(local, "e5").click();
  await countAtLeast(local, 2);
  let entries = await feed(local);
  check(
    entries.length === 2 && entries[0].side !== entries[1].side && Math.abs(seconds(entries[0].time) - seconds(entries[1].time)) <= 1,
    `${tag} both sides moved within the same second (${entries.map((entry) => `${entry.time} ${entry.side} ${entry.san}`).join(", ")})`
  );
  check((await isCooling(local, "e4")) && (await isCooling(local, "e5")), `${tag} both moved pieces are cooling at the same time`);
  // The same side can move again at once with another piece. On desktop the first is a mouse
  // drag: press on the knight, release on its target.
  if (size === "desktop") {
    const from = await square(local, "g1").boundingBox();
    const to = await square(local, "f3").boundingBox();
    await local.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await local.mouse.down();
    await local.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
    await local.mouse.up();
    await countAtLeast(local, 3);
    check((await pieceOn(local, "f3")) === "white-knight", `${tag} a piece can be dragged to its target with the mouse`);
  } else await tap(local, "g1", "f3");
  await tap(local, "f1", "c4");
  await countAtLeast(local, 4);
  check((await sanList(local)).slice(2).join(" ") === "Nf3 Bc4", `${tag} one side moves several pieces in a row`);
  if (size === "phone") {
    // Two fingers go down at the same instant: White's d-pawn and Black's d-pawn.
    await multiTouch(local, ["d2", "d7"]);
    check((await local.locator(".board .selected-square").count()) === 2, `${tag} two simultaneous touches select a piece for each player`);
    await multiTouch(local, ["d3", "d6"]);
    await countAtLeast(local, 6);
    entries = (await feed(local)).slice(4);
    check(
      entries.length === 2 && entries[0].time === entries[1].time && entries.map((entry) => entry.san).sort().join(" ") === "d3 d6",
      `${tag} two simultaneous touches move a piece for each player (${entries.map((entry) => `${entry.time} ${entry.san}`).join(", ")})`
    );
  }
  // Castling: the king and rook have not moved and the squares between are empty.
  await tap(local, "e1", "g1");
  await local.waitForFunction(() => document.querySelector('.board [data-square="g1"]')?.dataset.piece === "white-king", null, { timeout: 5000 });
  check((await pieceOn(local, "f1")) === "white-rook", `${tag} castling moves the rook to f1`);
  check((await isCooling(local, "g1")) && (await isCooling(local, "f1")), `${tag} castling puts both the king and the rook on cooldown`);
  check((await sanList(local)).at(-1) === "O-O", `${tag} castling is written O-O`);
  // Flip Black's pieces for a player sitting opposite.
  await local.getByRole("button", { name: "Flip Black" }).click();
  check((await local.locator(".board.flip-black").count()) === 1 && (await local.locator(".player-bar.flipped").count()) === 1, `${tag} Black's pieces and bar can be flipped`);
  // The bishop takes f7, then takes the king. Nothing stops Black from ignoring it: there is no check.
  await playMove(local, "c4f7");
  await local.waitForSelector(".danger-square", { timeout: 6000 });
  check((await local.locator('.board .danger-square[data-square="e8"]').count()) === 1, `${tag} the threatened king's square is flagged as the attacker comes off cooldown`);
  await playMove(local, "f7e8");
  check((await local.locator(".modal-dialog h2").innerText()) === "King captured!", `${tag} capturing the king ends the game`);
  check((await local.locator(".modal-dialog .modal-copy p").innerText()).startsWith("White took the king"), `${tag} the dialog says who took it`);
  check((await sanList(local)).at(-1) === "Bxe8", `${tag} the capture is the last entry of the feed, with no check marks anywhere`);
  await local.getByRole("button", { name: "View board" }).click();
  await tap(local, "a2", "a3");
  check((await pieceOn(local, "a2")) === "white-pawn", `${tag} nothing moves after the game is over`);
  await local.screenshot({ path: `${out}/e2e-${size}-king-captured.png` });
  await local.context().close();

  // ---- 3. Online ----
  const white = await open(size, `${size}-white`);
  const black = await open(size, `${size}-black`);
  await openRoom(white, black, APP, { hostSide: "White", seconds: 3 });
  check((await white.locator(".player-bar").last().innerText()).includes("White"), `${tag} the host plays White at the bottom`);
  check((await black.locator(".board [data-square]").first().getAttribute("data-square")) === "h1", `${tag} Black sees the board from Black's side`);
  check((await black.locator(".game-panel-header .section-kicker").innerText()).toLowerCase().includes("3 s"), `${tag} the joiner is shown the room's cooldown`);
  await black.getByRole("button", { name: "Good luck!" }).click();
  await white.waitForSelector(".chat-message.opponent");
  check((await white.locator(".chat-message.opponent p").innerText()) === "Good luck!", `${tag} quick chat reaches the opponent`);
  await Promise.all([waitLive(white), waitLive(black)]);
  // Both browsers move at the same time.
  await Promise.all([tap(white, "e2", "e4"), tap(black, "e7", "e5")]);
  await Promise.all([countAtLeast(white, 2), countAtLeast(black, 2)]);
  const [whiteFeed, blackFeed] = [await feed(white), await feed(black)];
  check(JSON.stringify(whiteFeed) === JSON.stringify(blackFeed), `${tag} both browsers show the same feed after moving concurrently`);
  check(whiteFeed.map((entry) => entry.san).sort().join(" ") === "e4 e5" && whiteFeed[0].time === whiteFeed[1].time, `${tag} the concurrent moves share a timestamp (${whiteFeed.map((entry) => `${entry.time} ${entry.san}`).join(", ")})`);
  check((await isCooling(black, "e4")) && (await isCooling(white, "e5")), `${tag} each player sees the opponent's piece cooling`);
  // A move for a cooling piece is refused and nothing changes for either player.
  await tap(white, "g1", "f3");
  await Promise.all([countAtLeast(white, 3), countAtLeast(black, 3)]);
  await square(white, "f3").click();
  await square(white, "g1").click({ force: true });
  const refused = await white.locator(".board .piece-notice").first().innerText().catch(() => "");
  await white.waitForTimeout(300);
  check(/^\d\.\ds$/.test(refused) && (await moveCount(white)) === 3 && (await moveCount(black)) === 3, `${tag} a move for a cooling piece is rejected ("${refused}")`);
  check((await pieceOn(black, "f3")) === "white-knight", `${tag} and the opponent's board is unchanged`);
  await square(white, "f3").click({ force: true });
  await Promise.all([tap(white, "f1", "c4"), tap(black, "g8", "f6")]);
  await Promise.all([countAtLeast(white, 5), countAtLeast(black, 5)]);

  // Black drops out right after moving: the game pauses with Black's knight still cooling.
  await black.goto("about:blank");
  await white.waitForSelector(".disconnected-event", { timeout: 10000 });
  check((await statusTitle(white)) === "Paused", `${tag} a disconnect pauses the game`);
  await white.waitForTimeout(3600);
  await black.goBack();
  await black.waitForSelector("text=Online match", { timeout: 20000 });
  await white.waitForSelector(".disconnected-event", { state: "detached", timeout: 10000 });
  const backAt = Date.now();
  check(JSON.stringify(await feed(black)) === JSON.stringify(await feed(white)), `${tag} the returning player is resynchronised`);
  check((await isCooling(black, "f6")) && (await isCooling(white, "f6")), `${tag} a 3 s cooldown has not ended after a 3.6 s disconnect, for either player`);
  await waitReady(white, "f6", 6000);
  const left = Date.now() - backAt;
  check(left > 1200 && left < 3600, `${tag} it runs out only after the game resumes (${left} ms later)`);

  await playLine(white, ["c4f7", "f7e8"]);
  await white.waitForSelector(".result-event.won", { timeout: 10000 });
  await black.waitForSelector(".result-event.lost", { timeout: 10000 });
  check((await white.locator(".result-event h2").innerText()) === "King captured!", `${tag} the winner sees "King captured!"`);
  check((await black.locator(".result-event h2").innerText()) === "Your king was captured", `${tag} the loser sees "Your king was captured"`);
  await black.screenshot({ path: `${out}/e2e-${size}-online-lost.png` });
  await white.getByRole("button", { name: "Request rematch" }).click();
  await black.getByRole("button", { name: "Accept rematch" }).click();
  await white.waitForFunction(() => /^Starting in/.test(document.querySelector(".turn-status p")?.textContent ?? ""), null, { timeout: 10000 });
  check((await moveCount(white)) === 0, `${tag} a rematch starts a fresh game with a new countdown`);
  await white.context().close();
  await black.context().close();
}

// ---- 4. Quick match, names and side choice (phone size) ----
const a = await open("phone", "A");
await a.goto(`${APP}/multiplayer`);
await a.waitForSelector("text=Playing as");
const nameA = await a.locator(".playing-as strong").innerText();
check(/^[A-Z][a-z]+[A-Z][a-z]+\d\d$/.test(nameA), `player gets a generated name (${nameA})`);
await a.reload();
await a.waitForSelector("text=Playing as");
check((await a.locator(".playing-as strong").innerText()) === nameA, "generated name survives a reload");
await a.waitForSelector(".server-state.online");
await a.locator('[data-cooldown="3000"]').click();
await a.getByRole("button", { name: "Find match" }).click();
await a.waitForSelector("text=Looking for a player");
check((await a.locator(".queue-screen").innerText()).includes("3 s cooldown"), "the search screen names the cooldown being searched for");
await a.getByRole("button", { name: "Play while I wait" }).click();
await a.waitForSelector("text=Still searching for a match");
await waitLive(a);
await tap(a, "e2", "e4");
await countAtLeast(a, 2, 15000);
check(true, "bot game runs while quick match searches");

// A player searching for a different cooldown is not paired with A.
const other = await open("phone", "other");
await other.goto(`${APP}/multiplayer`);
await other.waitForSelector(".server-state.online");
await other.locator('[data-cooldown="7000"]').click();
await other.getByRole("button", { name: "Find match" }).click();
await other.waitForSelector("text=Looking for a player");
await other.waitForTimeout(700);
check((await a.locator("text=Still searching for a match").count()) === 1, "quick match does not pair different cooldowns");
await other.context().close();

const b = await open("phone", "B");
await b.goto(`${APP}/multiplayer`);
await b.waitForSelector(".server-state.online");
const nameB = await b.locator(".playing-as strong").innerText();
await b.locator('[data-cooldown="3000"]').click();
await b.getByRole("button", { name: "Find match" }).click();
await a.waitForSelector("text=Match found! Your bot game was closed.", { timeout: 8000 });
await a.waitForSelector("text=Online match");
check(true, "a found match replaces the waiting bot game, with a notice");
check(await a.getByText(nameB).first().isVisible(), `opponent shows by generated name (${nameB})`);

const c = await open("phone", "C");
await c.goto(`${APP}/multiplayer`);
await c.waitForSelector(".server-state.online");
await c.getByRole("button", { name: "Find match" }).click();
await c.waitForSelector("text=Looking for a player");
await c.getByRole("button", { name: "Play a bot instead" }).click();
await c.waitForURL(/\/bot$/);
check((await c.locator(".game-panel-header strong").innerText()) === "Medium bot", "play a bot instead leaves the queue and opens a bot game");

// Playing the bot as Black flips the board.
const d = await open("phone", "D");
await startBot(d, APP, { level: "Hard", seconds: 3, side: "Black" });
check((await d.locator(".board [data-square]").first().getAttribute("data-square")) === "h1", "board is flipped when playing Black");
check((await d.locator(".player-bar").last().innerText()).includes("You"), "your bar is at the bottom");
await waitLive(d);
await countAtLeast(d, 1, 8000);
check((await feed(d))[0].side === "white", "the bot, playing White, moves on its own once the game is live");

// Private room: the creator picks Black, the joiner gets White.
const host = await open("phone", "host");
const guest = await open("phone", "guest");
await openRoom(host, guest, APP, { hostSide: "Black", seconds: 5 });
check((await guest.locator(".player-bar").last().innerText()).includes("White"), "joiner of a Black-hosted room plays White");
check((await host.locator(".player-bar").last().innerText()).includes("Black"), "host sees themselves as Black at the bottom");

check(errors.length === 0, `no console errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close();
