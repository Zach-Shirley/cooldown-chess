import { useState } from "react";
import { BookOpen, Bot, ChevronRight, Globe, Users } from "lucide-react";
import type { BotLevel } from "../bot";
import { DEFAULT_GAME_RULES, type GameRules } from "../game";
import type { ColorChoice } from "../multiplayer/protocol";
import heroTall from "../assets/hero-tall.webp";
import heroWide from "../assets/hero.webp";
import { BotLevelPicker } from "../ui/BotLevelPicker";
import { ColorPicker } from "../ui/ColorPicker";
import { CooldownPicker, RulesDialog, SoundToggle } from "../ui/GameChrome";
import { Modal } from "../ui/Modal";

type HomePageProps = {
  onStartLocal: (rules: GameRules, flipBlack: boolean) => void;
  onStartBot: (level: BotLevel, rules: GameRules, color: ColorChoice) => void;
  onOpenMultiplayer: () => void;
};

type HomeDialog = "rules" | "bots" | "local" | null;

export function HomePage({ onStartLocal, onStartBot, onOpenMultiplayer }: HomePageProps) {
  const [dialog, setDialog] = useState<HomeDialog>(null);
  const [botLevel, setBotLevel] = useState<BotLevel>("medium");
  const [botColor, setBotColor] = useState<ColorChoice>("white");
  const [rules, setRules] = useState<GameRules>(DEFAULT_GAME_RULES);
  const [flipBlack, setFlipBlack] = useState(false);

  return (
    <main className="home-page">
      <picture className="home-hero" aria-hidden="true">
        <source media="(max-aspect-ratio: 4/5)" srcSet={heroTall} />
        <img src={heroWide} alt="" draggable="false" />
      </picture>
      <div className="home-shade" aria-hidden="true" />

      <div className="home-corner">
        <SoundToggle />
      </div>

      <section className="home-menu" aria-labelledby="home-title">
        <p className="home-kicker">Chess without turns</p>
        <h1 id="home-title">
          Cooldown <span>Chess</span>
        </h1>
        <p className="home-summary">
          Nobody waits. Move any piece the moment it is ready, and take the king before yours is taken.
        </p>

        <div className="home-actions" aria-label="Game modes">
          <button className="menu-button primary" type="button" onClick={() => setDialog("bots")}>
            <span className="menu-icon"><Bot aria-hidden="true" size={22} /></span>
            <span className="menu-copy">
              <strong>Play a Bot</strong>
              <small>Easy, medium or hard</small>
            </span>
            <ChevronRight className="menu-arrow" aria-hidden="true" size={20} />
          </button>
          <button className="menu-button" type="button" onClick={onOpenMultiplayer}>
            <span className="menu-icon"><Globe aria-hidden="true" size={22} /></span>
            <span className="menu-copy">
              <strong>Play Online</strong>
              <small>Private rooms and quick match</small>
            </span>
            <ChevronRight className="menu-arrow" aria-hidden="true" size={20} />
          </button>
          <button className="menu-button" type="button" onClick={() => setDialog("local")}>
            <span className="menu-icon"><Users aria-hidden="true" size={22} /></span>
            <span className="menu-copy">
              <strong>Same Screen</strong>
              <small>Two players, one board, both at once</small>
            </span>
            <ChevronRight className="menu-arrow" aria-hidden="true" size={20} />
          </button>
        </div>

        <button className="rules-link" type="button" onClick={() => setDialog("rules")}>
          <BookOpen aria-hidden="true" size={18} />
          How to play
        </button>
      </section>

      {dialog === "bots" ? (
        <Modal title="Play a bot" description="Pick a difficulty, a side and a cooldown." onClose={() => setDialog(null)}>
          <BotLevelPicker value={botLevel} onChange={setBotLevel} />
          <ColorPicker value={botColor} onChange={setBotColor} />
          <CooldownPicker value={rules} onChange={setRules} />
          <div className="modal-actions">
            <button className="button secondary" type="button" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              className="button primary"
              type="button"
              data-autofocus
              onClick={() => onStartBot(botLevel, rules, botColor)}
            >
              Start game
            </button>
          </div>
        </Modal>
      ) : null}

      {dialog === "local" ? (
        <Modal
          title="Same screen"
          description="Two players share this device and both play at once. White sits at the bottom, Black at the top."
          onClose={() => setDialog(null)}
        >
          <div className="setup-stack">
            <CooldownPicker value={rules} onChange={setRules} />
            <label className="setting-toggle">
              <span>
                <strong>Flip Black&apos;s pieces</strong>
                <small>Upright for a player sitting on the far side</small>
              </span>
              <input type="checkbox" checked={flipBlack} onChange={(event) => setFlipBlack(event.currentTarget.checked)} />
              <span className="toggle-track" aria-hidden="true" />
            </label>
          </div>
          <div className="modal-actions">
            <button className="button secondary" type="button" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button className="button primary" type="button" data-autofocus onClick={() => onStartLocal(rules, flipBlack)}>
              Start game
            </button>
          </div>
        </Modal>
      ) : null}

      {dialog === "rules" ? <RulesDialog onClose={() => setDialog(null)} /> : null}
    </main>
  );
}
