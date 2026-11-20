// Helpers that drive the board through the DOM, the way a player would: they only press
// squares and read what the page shows. Shared by the end-to-end and screenshot scripts.
//
// The board marks every square with data-square ("e4") and data-piece ("white-knight"), a
// cooling piece's square with data-cooling="true", and the squares a selected piece may move
// to with the class "legal-square" ("pending-target" as well while that piece is cooling).

export const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }
};

export const square = (page, name) => page.locator(`.board [data-square="${name}"]`);
export const pieceOn = (page, name) => square(page, name).getAttribute("data-piece");
export const isCooling = async (page, name) => (await square(page, name).getAttribute("data-cooling")) === "true";
export const moveCount = (page) => page.locator(".moves-heading span").innerText().then(Number);
export const statusTitle = (page) => page.locator(".turn-status p").innerText();
export const isGameOver = async (page) => (await statusTitle(page)) === "Game over";

// The move feed in order: [{ time: "0:07", side: "white", san: "Nf3" }, ...].
export const feed = (page) =>
  page.locator(".move-list .move-entry").evaluateAll((items) =>
    items.map((item) => ({
      time: item.querySelector(".move-time")?.textContent ?? "",
      side: item.classList.contains("black") ? "black" : "white",
      san: item.querySelector(".move-san")?.textContent ?? ""
    }))
  );
export const sanList = async (page) => (await feed(page)).map((entry) => entry.san);

// Waits for the 3-2-1 to finish: both sides are live.
export function waitLive(page, timeout = 15000) {
  return page.waitForFunction(
    () => {
      const title = document.querySelector(".turn-status p")?.textContent ?? "";
      return !document.querySelector(".countdown-layer.counting") && (title === "Live" || title === "Your king is in danger");
    },
    null,
    { timeout }
  );
}

// Waits until the piece on `name` has finished cooling down.
export function waitReady(page, name, timeout = 20000) {
  return page.waitForFunction(
    (wanted) => {
      const element = document.querySelector(`.board [data-square="${wanted}"]`);
      return element?.dataset.piece && element.dataset.cooling !== "true";
    },
    name,
    { timeout }
  );
}

// Presses two squares: a piece, then where it goes. Does not wait for anything.
export async function tap(page, from, to) {
  await square(page, from).click();
  await square(page, to).click();
}

// Plays one "e2e4"-style move as soon as its piece is ready, and waits for it to land.
export async function playMove(page, move, timeout = 20000) {
  const from = move.slice(0, 2);
  const to = move.slice(2, 4);
  await waitReady(page, from, timeout);
  const piece = await pieceOn(page, from);
  await tap(page, from, to);
  await page.waitForFunction(
    ([origin, target, wanted]) => {
      const at = (name) => document.querySelector(`.board [data-square="${name}"]`)?.dataset.piece;
      // A promoted pawn arrives as a queen of the same colour.
      return at(target)?.startsWith(wanted.split("-")[0]) && at(origin) !== wanted;
    },
    [from, to, piece],
    { timeout: 8000 }
  );
}

export async function playLine(page, moves) {
  for (const move of moves) await playMove(page, move);
}

// Puts fingers down on several squares at the same instant and lifts them together, through
// the browser's touch input (Chromium only): what two players do on one phone.
export async function multiTouch(page, names) {
  const client = await page.context().newCDPSession(page);
  const touchPoints = [];
  for (const [index, name] of names.entries()) {
    const box = await square(page, name).boundingBox();
    touchPoints.push({ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), id: index + 1 });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints });
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await client.detach();
}

// A small seeded generator so scripted games are repeatable.
export function seeded(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

// Collects console errors and page errors for the final report.
export function watchErrors(page, label, errors) {
  page.on("console", (message) => message.type() === "error" && errors.push(`${label}: ${message.text()}`));
  page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
}

const pickCooldown = (page, seconds) => page.locator(`[data-cooldown="${seconds * 1000}"]`).click();

// Home -> Same Screen with the given cooldown. Resolves on the game page, countdown running.
export async function startSameScreen(page, base, seconds = 3, { flip = false } = {}) {
  await page.goto(base);
  await page.getByText("Same Screen").click();
  await pickCooldown(page, seconds);
  if (flip) await page.locator(".setting-toggle").click();
  await page.getByRole("button", { name: "Start game" }).click();
  await page.waitForURL(/\/local$/);
}

// Home -> Play a Bot. `side` is "White" or "Black".
export async function startBot(page, base, { level = "Medium", seconds = 3, side = "White" } = {}) {
  await page.goto(base);
  await page.getByText("Play a Bot").click();
  await page.getByRole("radio", { name: new RegExp(level) }).click();
  await page.getByRole("radio", { name: side, exact: true }).click();
  await pickCooldown(page, seconds);
  await page.getByRole("button", { name: "Start game" }).click();
  await page.waitForURL(/\/bot$/);
}

// Creates a private room on `host` (playing `hostSide`) and joins it from `guest`.
export async function openRoom(host, guest, base, { hostSide = "White", seconds = 3 } = {}) {
  await host.goto(`${base}/multiplayer`);
  await host.waitForSelector(".server-state.online", { timeout: 90000 });
  await pickCooldown(host, seconds);
  await host.getByRole("radio", { name: hostSide, exact: true }).click();
  await host.getByRole("button", { name: "Create private room" }).click();
  await host.waitForSelector("text=Waiting for an opponent");
  const code = (await host.locator(".room-code-display span").innerText()).trim();
  await guest.goto(`${base}/multiplayer`);
  await guest.waitForSelector(".server-state.online", { timeout: 90000 });
  await guest.getByText("Join room", { exact: true }).first().click();
  await guest.getByPlaceholder("ABC123").fill(code);
  await guest.locator("form.lobby-form button[type=submit]").click();
  await host.waitForSelector("text=Online match", { timeout: 20000 });
  await guest.waitForSelector("text=Online match", { timeout: 20000 });
  return code;
}
