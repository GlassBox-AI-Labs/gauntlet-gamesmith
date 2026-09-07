import Link from 'next/link'
import { Sprite } from '@/components/features/splash/sprite'
import { SplashClient } from '@/components/features/splash/splash-client'
import { fontClass } from './splash-fonts'
import './splash.css'
export default function SplashPage() {
  return (
    <article className={`page ${fontClass}`} id="splash">
      <Sprite />
      <SplashClient />
      <header className="nav">
        <Link className="brand" href="/"><img src="/splash/app-icon.webp" alt="" /> Gauntlet Gamesmith <small>by GlassBox AI Labs</small></Link>
        <nav className="links" aria-label="Sections">
          <a href="#what">What it does</a><Link href="/how">How it works</Link><a href="#arcade">Arcade</a><a href="#get">Get it</a>
        </nav>
        <a className="btn btn-primary" href="https://github.com/GlassBox-AI-Labs/gauntlet-gamesmith/releases/latest"><svg className="icon" aria-hidden="true"><use href="#i-download"/></svg>Download for Mac</a>
      </header>

      <section className="hero">
        <canvas className="field" aria-hidden="true"></canvas>
        <div>
          <h1>Type a sentence. Play a game.</h1>
          <p className="lead">Two agents build it, break it, and build it again. You walk away.</p>
          <div className="cta">
            <a className="btn btn-primary" href="https://github.com/GlassBox-AI-Labs/gauntlet-gamesmith/releases/latest"><svg className="icon" aria-hidden="true"><use href="#i-download"/></svg>Download for Mac</a>
            <Link className="btn btn-secondary" href="/games">Open the arcade<svg className="icon" aria-hidden="true"><use href="#i-arrow-up-right"/></svg></Link>
            <span className="meta">v0.1.1 · Apple chip and Intel</span>
          </div>
        </div>
        <div className="case hero-case">
          <div className="back"></div>
          <div className="glass"><video src="/splash/app-clip.mp4" poster="/splash/app-poster.webp" muted loop playsInline autoPlay preload="metadata" aria-label="The app: a sentence is typed and Create build is pressed"></video></div>
        </div>
      </section>

      <section className="what" id="what">
        <div className="what-head">
          <div>
            <h2 data-reveal>No babysitting.</h2>
            <p className="line" data-reveal style={{ transitionDelay: '80ms' }}>Set a spending ceiling and walk away. It stops when the critic passes your game, the rounds run out, or the money does.</p>
          </div>
          <div className="case small" data-reveal style={{ transitionDelay: '120ms' }}>
            <div className="back"></div>
            <div className="glass"><img src="/splash/app-options.webp" alt="Run options: Reference Study mode, maximum rounds, and a budget ceiling as equivalent API cost" /></div>
          </div>
        </div>
        <div className="points">
          <div className="point" data-reveal>
            <div className="pt"><h3>It studies the real thing first.</h3><p>Name the game yours should feel like. It gathers stills, clips, and sources before writing a line.</p></div>
            <div className="case"><div className="back"></div><div className="glass"><img src="/splash/app-study.webp" alt="The reference study running: counts of stills, motion frames, and journey shots above a grid of captured frames" /></div></div>
          </div>
          <div className="point flip" data-reveal>
            <div className="pt"><h3>It criticises itself.</h3><p>A second agent, with no memory of building, plays your game and scores it. The notes go back in.</p></div>
            <div className="case"><div className="back"></div><div className="glass"><img src="/splash/app-pairs.webp" alt="The critic's gameplay recording above blind side-by-side pairs, this build beside the reference" /></div></div>
          </div>
          <div className="point" data-reveal>
            <div className="pt"><h3>Nothing is hidden.</h3><p>Every prompt, command, helper, and cost estimate is on screen while it works.</p></div>
            <div className="case"><div className="back"></div><div className="glass"><img src="/splash/app-log.webp" alt="The study log with a chip for every agent and a row of tool call ids" /></div></div>
          </div>
          <div className="point flip" data-reveal>
            <div className="pt"><h3>Every round is saved.</h3><p>Play any earlier version. Publish the one you like.</p></div>
            <div className="case"><div className="back"></div><div className="glass"><img src="/splash/app-rounds.webp" alt="The rounds table with a score per round and the Publish, Play, Export, and Resume build buttons" /></div></div>
          </div>
        </div>
        <div className="cta" data-reveal>
          <a className="btn btn-primary" href="https://github.com/GlassBox-AI-Labs/gauntlet-gamesmith/releases/latest"><svg className="icon" aria-hidden="true"><use href="#i-download"/></svg>Download for Mac</a>
        </div>
      </section>

      <section className="loop" id="loop">
        <h2 data-reveal>The loop, in one drag.</h2>
        <div className="evidence">
          <div>
            <div className="case" data-reveal>
              <div className="back"></div>
              <div className="glass">
                <div className="pair">
                  <img className="before" src="/splash/ashen-capsule.webp" alt="Round 1: the dog rendered as white capsule shapes beside a bonfire" />
                  <img className="after" src="/splash/ashen-bonfire.webp" alt="A later run: the same scene with a real dog mesh at the bonfire" />
                  <span className="tag l">Round 1</span><span className="tag r">A later run</span>
                  <input className="handle" type="range" min="0" max="100" defaultValue="50" aria-label="Compare round 1 with a later run" />
                </div>
              </div>
            </div>
            <p className="record" data-reveal style={{ transitionDelay: '100ms' }}><span className="score">0.40</span><span className="fail">fail</span><span className="file">round 1 · verdict.json</span></p>
          </div>
          <div className="loop-side" data-reveal style={{ transitionDelay: '160ms' }}>
            <p className="big">Round 1 failed. Every finding went into round 2. That is the whole idea.</p>
            <Link className="more" href="/how">See how a run works<svg className="icon" aria-hidden="true"><use href="#i-arrow-right"/></svg></Link>
            <a className="btn btn-primary" href="https://github.com/GlassBox-AI-Labs/gauntlet-gamesmith/releases/latest"><svg className="icon" aria-hidden="true"><use href="#i-download"/></svg>Download for Mac</a>
          </div>
        </div>
      </section>

      <section className="sentences" id="sentences">
        <h2 data-reveal>Three sentences. Three games.</h2>
        <ul className="typed">
          <li data-reveal><span className="text">A Souls-like where you play a dog carrying its bones.</span><span className="case tiny"><span className="back"></span><span className="glass"><img src="/splash/ashen-title.webp" alt="Ashen Woods title screen" /></span></span></li>
          <li data-reveal style={{ transitionDelay: '80ms' }}><span className="text">Geometry Wars on the surface of a sphere.</span><span className="case tiny"><span className="back"></span><span className="glass"><img src="/splash/tron-sphere.webp" alt="Gauntletron sphere arena" /></span></span></li>
          <li data-reveal style={{ transitionDelay: '160ms' }}><span className="text">A Pac-Man platformer with a flat maze hiding inside.</span><span className="case tiny"><span className="back"></span><span className="glass"><img src="/splash/pac-maze.webp" alt="Claude-Man 3D maze" /></span></span></li>
        </ul>
        <p className="big" data-reveal>Yours is whatever you type next.</p>
      </section>

      <section className="arcade" id="arcade">
        <div className="case" data-reveal>
          <div className="back"></div>
          <div className="glass">
            <video src="/splash/arcade-clip.mp4" poster="/splash/arcade-poster.webp" muted loop playsInline autoPlay preload="metadata" aria-hidden="true"></video>
            <div className="scrim"></div>
            <div className="copy">
              <span className="live">The arcade is live</span>
              <h2>Made here. Played here.</h2>
              <p>Publish from the app. Anyone can play it in a browser, no account.</p>
              <div className="shelf"><strong>Pac-claude Arcade</strong><span>published by Gabe's Games</span></div>
              <div className="cta">
                <Link className="btn btn-secondary" href="/games">Open the arcade<span className="meta">gauntletgamesmith.com</span><svg className="icon" aria-hidden="true"><use href="#i-arrow-up-right"/></svg></Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="get" id="get">
        <div data-reveal>
          <h2>Get it</h2>
          <ul className="dl">
            <li><a href="https://github.com/GlassBox-AI-Labs/gauntlet-gamesmith/releases/download/v0.1.1/Gauntlet.Gamesmith-0.1.1-mac-arm64.dmg"><svg className="icon" aria-hidden="true"><use href="#i-apple"/></svg><b>Apple chip</b><span className="size">.dmg · 139 MB</span><svg className="icon go" aria-hidden="true"><use href="#i-download"/></svg></a></li>
            <li><a href="https://github.com/GlassBox-AI-Labs/gauntlet-gamesmith/releases/download/v0.1.1/Gauntlet.Gamesmith-0.1.1-mac-x64.dmg"><svg className="icon" aria-hidden="true"><use href="#i-cpu"/></svg><b>Intel chip</b><span className="size">.dmg · 146 MB</span><svg className="icon go" aria-hidden="true"><use href="#i-download"/></svg></a></li>
          </ul>
          <p className="help">Apple menu, About This Mac. If the chip says Apple, take the first one. Mac only, v0.1.1.</p>
          <p className="block"><b>macOS blocks it the first time.</b> Right-click, Open, confirm. Once.</p>
        </div>
        <div data-reveal style={{ transitionDelay: '100ms' }}>
          <p className="side-title">Three things you need</p>
          <ol className="needs">
            <li><div><h3><svg className="icon" aria-hidden="true"><use href="#i-terminal"/></svg>A Claude or ChatGPT subscription</h3><p>Runs Claude Code or Codex. Installs it for you if needed.</p></div></li>
            <li><div><h3><svg className="icon" aria-hidden="true"><use href="#i-code"/></svg>Node.js LTS</h3><p>Previews the games.</p></div></li>
            <li><div><h3><svg className="icon" aria-hidden="true"><use href="#i-git-branch"/></svg>Git</h3><p>Snapshots every round.</p></div></li>
          </ol>
          <p className="stays">Everything stays on your machine. No account, no server.</p>
          <p className="help">Costs shown in the app are estimates. It runs on the subscription you already pay for, with your own login.</p>
        </div>
      </section>

      <footer>
        <span className="maker"><svg className="gbx" aria-label="GlassBox AI Labs"><use href="#gbx-cube"/></svg>glassbox <small>ai labs</small></span>
        <span className="mid"><span>Gauntlet Gamesmith</span><span>GlassBox AI Labs</span><span>Gauntlet AI G6 capstone</span></span>
        <a href="https://github.com/GlassBox-AI-Labs/gauntlet-gamesmith">github.com/GlassBox-AI-Labs/gauntlet-gamesmith</a>
        <span className="line">Reference material is research evidence. It never ships inside a game.</span>
      </footer>
    </article>
  )
}
