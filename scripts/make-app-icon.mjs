// Renders the source images @capacitor/assets turns into every iOS/Android icon and splash size.
// The piece comes from art/piece-icon.png, a 1024px render from art/studio.js. It stands inside
// a cooldown ring that is two thirds drained: the whole game in one picture.
// Run: npm run mobile:icons
import { mkdirSync } from "node:fs";
import sharp from "sharp";

const dark = "#476078";
const light = "#d4c4a4";
const night = "#05080c";
// --cool-white in src/theme/tokens.css.
const ringColour = "#5fe0ff";
// How much of the ring is still lit.
const RING_LEFT = 0.68;

// A 2x2 board corner. Apple masks the corners itself, so no rounding here.
const board = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <rect width="512" height="512" fill="${light}"/>
  <rect x="512" width="512" height="512" fill="${dark}"/>
  <rect y="512" width="512" height="512" fill="${dark}"/>
  <rect x="512" y="512" width="512" height="512" fill="${light}"/>
</svg>`);

// The ring as an SVG the size of the canvas: a dark track and the lit arc, starting at the top.
function ring(canvas, radius, stroke, { glow = true } = {}) {
  const centre = canvas / 2;
  const length = 2 * Math.PI * radius;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}">
  <defs><filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${stroke * 0.5}"/></filter></defs>
  <circle cx="${centre}" cy="${centre}" r="${radius}" fill="rgba(5,8,12,0.34)" stroke="rgba(5,8,12,0.72)" stroke-width="${stroke}"/>
  <g transform="rotate(-90 ${centre} ${centre})" fill="none" stroke="${ringColour}" stroke-linecap="round" stroke-dasharray="${length * RING_LEFT} ${length}">
    ${glow ? `<circle cx="${centre}" cy="${centre}" r="${radius}" stroke-width="${stroke * 1.3}" opacity="0.55" filter="url(#glow)"/>` : ""}
    <circle cx="${centre}" cy="${centre}" r="${radius}" stroke-width="${stroke}"/>
  </g>
</svg>`);
}

async function pieceLayer(source, size) {
  const piece = await sharp(source).trim({ threshold: 1 }).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
  // Soft contact shadow under the piece so it sits on the board.
  const shadow = await sharp(piece).ensureAlpha().linear([0, 0, 0, 0.55], [0, 0, 0, 0]).blur(18).toBuffer();
  return { piece, shadow };
}

async function icon(source, output) {
  const size = 640;
  const { piece, shadow } = await pieceLayer(source, size);
  const left = Math.round((1024 - size) / 2);
  const top = Math.round((1024 - size) / 2) - 4;
  await sharp(board)
    .composite([
      { input: ring(1024, 388, 62), left: 0, top: 0 },
      { input: shadow, left: left + 10, top: top + 22 },
      { input: piece, left, top }
    ])
    .flatten({ background: light })
    .png()
    .toFile(output);
}

{
  await icon("art/piece-icon.png", "assets/icon-only.png");
  // Android's adaptive icon crops to the middle two thirds, so everything is drawn smaller.
  const { piece } = await pieceLayer("art/piece-icon.png", 430);
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: ring(1024, 262, 44), left: 0, top: 0 },
      { input: piece, left: 297, top: 293 }
    ])
    .png()
    .toFile("assets/icon-foreground.png");
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: dark } }).png().toFile("assets/icon-background.png");
  const splashPiece = (await pieceLayer("art/piece-icon.png", 520)).piece;
  for (const file of ["assets/splash.png", "assets/splash-dark.png"]) {
    await sharp({ create: { width: 2732, height: 2732, channels: 4, background: night } })
      .composite([
        { input: ring(880, 330, 50), left: 926, top: 926 },
        { input: splashPiece, left: 1106, top: 1102 }
      ])
      .png()
      .toFile(file);
  }
  // Browser tab and home-screen icons.
  mkdirSync("public", { recursive: true });
  await sharp("assets/icon-only.png").resize(64, 64).png().toFile("public/favicon.png");
  await sharp("assets/icon-only.png").resize(180, 180).png().toFile("public/apple-touch-icon.png");
  await sharp("assets/icon-only.png").resize(512, 512).png().toFile("public/icon-512.png");
  console.log("Wrote assets/*.png and public/*.png");
}
