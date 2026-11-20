// Captures App Store screenshots (iPhone 6.9", 1320x2868) from the real app in app-shell mode.
// Needs the web app and the game server running: npm run dev:multiplayer
// Usage: node scripts/store-screenshots.mjs [baseUrl]   → store/screenshots/raw/*.png
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { openRoom, square, startBot, startSameScreen, tap, waitLive } from "./lib/board-dom.mjs";

const APP = process.argv[2] ?? "http://localhost:4374";
const outDir = "store/screenshots/raw";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const device = { viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

async function appPage() {
  const context = await browser.newContext(device);
  // Pretend to be the Android shell so the app-store build's UI is shown.
  await context.addInitScript(() => {
    window.androidBridge = { postMessage() {} };
  });
  const page = await context.newPage();
  await page.goto(`${APP}/`);
  return page;
}

async function shot(page, name, settle = 700) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(settle);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`${outDir}/${name}.png`);
}

const burst = async (page, moves) => {
  for (const move of moves) await tap(page, move.slice(0, 2), move.slice(2, 4));
};

// 1. Home
const home = await appPage();
await shot(home, "1-home");

// 2. Same screen: both sides have just moved several pieces, so rings are draining everywhere
await startSameScreen(home, APP, 7);
await waitLive(home);
await burst(home, ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3", "f8c5"]);
await square(home, "c1").click();
await shot(home, "2-local-game", 900);

// 3. A game against the bot, a few seconds in
await startBot(home, APP, { level: "Medium", seconds: 5 });
await waitLive(home);
await burst(home, ["e2e4", "g1f3", "d2d4", "b1c3"]);
await shot(home, "3-bot-game", 1800);

// 4. Online: the app player hosts a private room, a web player joins
const host = await appPage();
await host.goto(`${APP}/multiplayer`);
await host.waitForSelector(".server-state.online");
await host.getByRole("radio", { name: "White", exact: true }).click();
await host.getByRole("button", { name: "Create private room" }).click();
await host.waitForSelector("text=Waiting for an opponent");
await shot(host, "4-online-room");
await host.getByRole("button", { name: "Leave" }).click();

const guest = await (await browser.newContext(device)).newPage();
await openRoom(host, guest, APP, { hostSide: "White", seconds: 5 });
await guest.getByRole("button", { name: "Good luck!" }).click();
await host.getByRole("button", { name: "Thanks!" }).click();
await Promise.all([waitLive(host), waitLive(guest)]);
await Promise.all([burst(host, ["e2e4", "g1f3", "d2d4", "b1c3"]), burst(guest, ["e7e5", "b8c6", "g8f6", "d7d6"])]);
await host.waitForFunction(() => Number(document.querySelector(".moves-heading span")?.textContent) >= 8, null, { timeout: 8000 });
await square(host, "c1").click();
await shot(host, "5-online-game", 600);

await browser.close();
