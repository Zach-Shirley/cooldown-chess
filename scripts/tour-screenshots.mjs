// Walks every screen at desktop and phone sizes, playing real games on the way, and saves
// screenshots. Exits non-zero if the browser logged any console error.
// Usage: node scripts/tour-screenshots.mjs <baseUrl> <outDir>
// Online screens need the game server that <baseUrl> is configured for to be reachable.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import {
  SIZES,
  openRoom,
  playLine,
  playMove,
  square,
  startBot,
  startSameScreen,
  tap,
  waitLive,
  watchErrors
} from "./lib/board-dom.mjs";

const [base = "http://localhost:4374", outDir = "docs/screenshots"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const errors = [];

async function open(size, label) {
  const page = await (await browser.newContext(SIZES[size])).newPage();
  watchErrors(page, label, errors);
  return page;
}
const shot = async (page, name, settle = 350) => {
  await page.waitForTimeout(settle);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`${outDir}/${name}.png`);
};

for (const size of Object.keys(SIZES)) {
  // Home, rules and bot setup
  const page = await open(size, size);
  await page.goto(base);
  await shot(page, `${size}-1-home`, 900);
  await page.getByText("How to play").click();
  await shot(page, `${size}-1b-rules`);
  await page.getByRole("button", { name: "Got it" }).click();
  await page.getByText("Play a Bot").click();
  await shot(page, `${size}-2-bot-setup`);
  await page.getByRole("button", { name: "Cancel" }).click();

  // Against the bot: the countdown, then a burst of moves so many pieces are cooling at once.
  await startBot(page, base, { level: "Medium", seconds: 7 });
  await page.waitForSelector(".countdown-layer.counting");
  await shot(page, `${size}-3-countdown`, 150);
  await waitLive(page);
  for (const move of ["e2e4", "d2d4", "g1f3", "b1c3", "f1c4", "c1f4", "a2a3", "h2h3"]) await tap(page, move.slice(0, 2), move.slice(2, 4));
  await page.waitForTimeout(1600);
  await shot(page, `${size}-3b-cooldown-rings`, 0);
  // Line up a move for a piece that is still cooling, then try it too early.
  await square(page, "f3").click();
  await shot(page, `${size}-3c-lined-up`, 250);
  await square(page, "e5").click();
  await shot(page, `${size}-3d-still-cooling`, 120);
  await page.getByRole("button", { name: "Pause" }).click();
  await shot(page, `${size}-3e-paused`);

  // Same screen: both sides play at once; then a queen raid that ends by taking the king.
  await startSameScreen(page, base, 3, { flip: true });
  await waitLive(page);
  await tap(page, "e2", "e4");
  await tap(page, "e7", "e5");
  await tap(page, "g1", "f3");
  await tap(page, "b8", "c6");
  await tap(page, "d1", "e2");
  await square(page, "g8").click();
  await shot(page, `${size}-4-same-screen`, 300);
  await square(page, "g8").click();
  await playLine(page, ["e2b5", "b5b7"]);
  await playMove(page, "b7c8");
  await playMove(page, "c8d8");
  await page.waitForSelector(".danger-square", { timeout: 8000 });
  await shot(page, `${size}-4b-king-in-danger`, 200);
  await playMove(page, "d8e8");
  await page.waitForSelector(".modal-dialog");
  await shot(page, `${size}-4c-king-captured`, 500);
  await page.getByRole("button", { name: "View board" }).click();
  await shot(page, `${size}-4d-final-board`);

  // Online: lobby, quick match, waiting room, and a game between two browsers
  await page.goto(`${base}/multiplayer`);
  await page.waitForSelector("text=Playing as", { timeout: 90000 });
  await page.waitForSelector(".server-state.online", { timeout: 90000 });
  await shot(page, `${size}-5-lobby`);
  await page.getByRole("button", { name: "Find match" }).click();
  await page.waitForSelector("text=Looking for a player");
  await shot(page, `${size}-5b-quick-match`);
  await page.getByRole("button", { name: "Cancel search" }).click();
  await page.waitForSelector("text=Playing as");
  await page.locator('[data-cooldown="3000"]').click();
  await page.getByRole("radio", { name: "White", exact: true }).click();
  await page.getByRole("button", { name: "Create private room" }).click();
  await page.waitForSelector("text=Waiting for an opponent");
  await shot(page, `${size}-6-waiting-room`);
  const code = (await page.locator(".room-code-display span").innerText()).trim();
  const guest = await open(size, `${size}-guest`);
  await guest.goto(`${base}/multiplayer`);
  await guest.waitForSelector(".server-state.online", { timeout: 90000 });
  await guest.getByText("Join room", { exact: true }).first().click();
  await guest.getByPlaceholder("ABC123").fill(code);
  await guest.locator("form.lobby-form button[type=submit]").click();
  await page.waitForSelector("text=Online match", { timeout: 20000 });
  await guest.getByRole("button", { name: "Good luck!" }).click();
  await page.getByRole("button", { name: "Thanks!" }).click();
  await Promise.all([waitLive(page), waitLive(guest)]);
  // Both players move at the same time.
  await Promise.all([
    (async () => { for (const move of ["e2e4", "g1f3", "d2d4", "b1c3"]) await tap(page, move.slice(0, 2), move.slice(2, 4)); })(),
    (async () => { for (const move of ["e7e5", "b8c6", "g8f6", "d7d6"]) await tap(guest, move.slice(0, 2), move.slice(2, 4)); })()
  ]);
  await page.waitForFunction(() => Number(document.querySelector(".moves-heading span")?.textContent) >= 8, null, { timeout: 8000 });
  await square(page, "c1").click();
  await shot(page, `${size}-7-online-game`, 500);
  await shot(guest, `${size}-7b-online-game-black`, 0);
  if (size === "phone") {
    await page.locator(".chat-section").scrollIntoViewIfNeeded();
    await shot(page, `${size}-8-online-chat`);
  }
  // The guest drops out: the game pauses and every cooldown freezes. Then they come back.
  await guest.goto("about:blank");
  await page.waitForSelector(".disconnected-event", { timeout: 30000 });
  await shot(page, `${size}-8b-opponent-disconnected`);
  await guest.goBack();
  await guest.waitForSelector("text=Online match", { timeout: 20000 });
  await page.waitForSelector(".disconnected-event", { state: "detached", timeout: 10000 });
  // White takes on f7 with the bishop, then takes the king.
  await playLine(page, ["f1c4", "c4f7"]);
  await playMove(page, "f7e8");
  await page.waitForSelector(".result-event", { timeout: 10000 });
  await guest.waitForSelector(".result-event", { timeout: 10000 });
  await shot(page, `${size}-9-online-result`, 500);
  await shot(guest, `${size}-9b-online-result-lost`, 0);
  await page.context().close();
  await guest.context().close();
}
console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join("\n")}` : "no console errors");
if (errors.length) process.exitCode = 1;
await browser.close();
