# Cooldown Chess Store Listing (draft)

_Draft. The bracketed fields still need real values before submitting._

| Field | Draft |
|---|---|
| Name (30 chars) | Cooldown Chess |
| Subtitle, iOS (30 chars) | Chess without turns |
| Short description, Google (80 chars) | Real-time chess: no turns, every piece has a cooldown, capture the king. |
| Category | Games → Board |
| Age rating | 4+ / Everyone (no free-form chat or user-generated text in the app build) |
| Price | Free, no in-app purchases |
| Privacy label (iOS) | Data Not Collected. The random player ID only lives in server memory for the length of a room. Once ratings store it, declare "Identifiers → User ID", not linked to identity |
| Data safety (Google) | No data collected or shared |
| Privacy policy URL | [LLC SITE]/cooldown-chess/privacy |
| Support URL | [LLC SITE]/cooldown-chess/support |

## Description

Chess with no turns. Move any piece the moment it is ready; after it moves, it cools down for a few seconds before it can move again. There is no check and no checkmate: you win by actually taking the king. Inspired by Xander Naumenko's physical real-time chess board (From Scratch); this is an independent app.

- Play the bot on Easy, Medium or Hard, even offline
- Same Screen: two players on one device, both moving at once
- Online play with private room codes or quick match, and a bot to play while you wait
- Choose the cooldown: 3, 5, 7 or 12 seconds
- Cooldown rings on every piece and a warning when your king is under threat
- No accounts, no ads, no tracking

## Review notes for Apple

No sign-in is needed. Online play connects to a game server that may take up to a minute to wake on the first connection. To test online play with one device, start a private room, then open the website ([WEB URL]/multiplayer) in a browser and join with the room code.

## Still to do

- Screenshots (iPhone 6.9", 1320×2868): `node scripts/store-screenshots.mjs` then `node scripts/frame-screenshots.mjs` writes them to `screenshots/framed/`. The same images work for Google Play.
- Google feature graphic (1024×500)
- Icon: `npm run mobile:icons` builds it from `art/piece-icon.png`
