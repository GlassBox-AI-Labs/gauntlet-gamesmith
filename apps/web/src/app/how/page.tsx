import type { Metadata } from 'next'
import Link from 'next/link'
import { Sprite } from '@/components/features/splash/sprite'
import { SplashClient } from '@/components/features/splash/splash-client'
import { fontClass } from '../splash-fonts'
import './how.css'
export const metadata: Metadata = { title: 'How it works' }
export default function HowPage() {
  return (
    <article className={`page ${fontClass}`} id="how">
      <Sprite />
      <SplashClient rootId="how" />
      <header className="nav">
        <Link className="brand" href="/"><img src="/splash/app-icon.webp" alt="" /> Gauntlet Gamesmith</Link>
        <Link className="back" href="/"><svg className="icon" aria-hidden="true"><use href="#i-arrow-right"/></svg><span>Back to the splash</span></Link>
        <a className="btn btn-primary" href="https://github.com/GlassBox-AI-Labs/gauntlet-gamesmith/releases/latest"><svg className="icon" aria-hidden="true"><use href="#i-download"/></svg>Download for Mac</a>
      </header>

      <div className="wrap">
        <header className="top">
          <h1>How a run works.</h1>
          <p>The run that built Ashen Woods, from its own ledger.</p>
        </header>

        <div className="phases">
          <div className="rail" aria-hidden="true"></div>

          <section className="phase" data-phase="describe">
            <span className="node" aria-hidden="true"></span>
            <div>
              <h2>Describe it</h2>
              <p className="line">A folder, a sentence, a spending ceiling.</p>
            </div>
            <div className="shots">
              <figure className="shot"><video src="/splash/clip-hero.mp4" poster="/splash/clip-hero-poster.webp" muted loop playsInline autoPlay preload="metadata" aria-label="The Create build form: a sentence is typed, effort is set, and Create build is pressed"></video><figcaption>Create build</figcaption></figure>
              <figure className="shot"><img src="/splash/app-options.webp" alt="Run options: Reference Study mode, maximum rounds, and a budget as equivalent API cost" /><figcaption>Run options: study mode, rounds, budget</figcaption></figure>
            </div>
          </section>

          <section className="phase" data-phase="study">
            <span className="node" aria-hidden="true"></span>
            <div>
              <h2>Reference Study</h2>
              <p className="line">One agent studies the real game first. The pack is frozen.</p>
              <ul className="log">
                <li><time>07:24:38</time><span><span className="k">→ WebSearch</span>"Dark Souls YOU DIED font typeface used"</span></li>
                <li className="err"><time>07:26:11</time><span><span className="k">✗ tool error</span>Claude Code is unable to fetch from www.reddit.com</span></li>
              </ul>
            </div>
            <div className="shots">
              <figure className="shot"><video src="/splash/clip-study.mp4" poster="/splash/clip-study-poster.webp" muted loop playsInline autoPlay preload="metadata" aria-label="The reference study running: what the pack has gathered so far and the research notes it wrote"></video><figcaption>Reference study running</figcaption></figure>
            </div>
          </section>

          <section className="phase hot" data-phase="build">
            <span className="node" aria-hidden="true"></span>
            <span className="ret" aria-hidden="true"><span className="ret-label">notes go back in</span></span>
            <div>
              <h2>Build</h2>
              <p className="line">An orchestrator writes the game and spawns helpers. Every round is a Git revision.</p>
              <ul className="log">
                <li><time>08:02:19</time><span><span className="k">▶ local_agent</span>started "Sculpt samoyed (mesh route)"</span></li>
              </ul>
            </div>
            <div className="shots">
              <figure className="shot"><video src="/splash/clip-log.mp4" poster="/splash/clip-log-poster.webp" muted loop playsInline autoPlay preload="metadata" aria-label="Totals, the four prompts, and the attempts table with a cost per round"></video><figcaption>Every prompt and every cost, on screen</figcaption></figure>
            </div>
          </section>

          <section className="phase hot" data-phase="critique">
            <span className="node" aria-hidden="true"></span>
            <div>
              <h2>Critique</h2>
              <p className="line">A second agent, with no memory of building, plays it blind and scores it.</p>
              <ul className="log">
                <li><time>08:31:20</time><span><span className="k">▣ artifact</span>Critique evidence baseline frozen at sha256:08f34f9e</span></li>
              </ul>
              <p className="record"><span className="score">0.40</span><span className="fail">fail</span><span className="file">round 1 · verdict.json</span></p>
              <p className="summary">Lost all 7 blind pairs to the reference: blob-capsule dog, flat foliage, spiral-ribbon fire.</p>
              <div className="finding"><span className="sev">major</span><span>Camera clips inside branch polygons and blacks out half the frame.</span></div>
            </div>
            <div className="shots">
              <figure className="shot"><video src="/splash/clip-critique.mp4" poster="/splash/clip-critique-poster.webp" muted loop playsInline autoPlay preload="metadata" aria-label="Blind side-by-side pairs: this build beside the reference, with the critic's note under each"></video><figcaption>Blind side-by-side, this build against the reference</figcaption></figure>
            </div>
          </section>

          <section className="phase" data-phase="play">
            <span className="node" aria-hidden="true"></span>
            <div>
              <h2>Play and publish</h2>
              <p className="line">Play at any point. Publish a finished round to the arcade.</p>
            </div>
            <div className="shots">
              <figure className="shot"><img src="/splash/app-rounds-still.webp" alt="A stopped build at round 4 of 10: the Publish, Play, Export, and Resume build bar over the rounds table, a score and cost per round" /><figcaption>Publish, Play, Export, Resume</figcaption></figure>
            </div>
          </section>
        </div>

        <div className="close">
          <div>
            <p className="big">0.40 is a fail. That is the point. Every finding goes into the next round.</p>
            <p className="note">Costs shown are estimates. It runs on the Claude or ChatGPT subscription you already pay for, with your own login.</p>
          </div>
          <div>
            <a className="btn btn-primary" href="https://github.com/GlassBox-AI-Labs/gauntlet-gamesmith/releases/latest"><svg className="icon" aria-hidden="true"><use href="#i-download"/></svg>Download for Mac</a>
          </div>
        </div>

        <footer>
          <span className="maker"><svg className="gbx" aria-label="GlassBox AI Labs"><use href="#gbx-cube"/></svg>glassbox <small>ai labs</small></span>
          <span className="mid"><span>Gauntlet Gamesmith</span><span>GlassBox AI Labs</span><span>Gauntlet AI G6 capstone</span></span>
          <a href="https://github.com/GlassBox-AI-Labs/gauntlet-gamesmith">github.com/GlassBox-AI-Labs/gauntlet-gamesmith</a>
          <span className="line">Reference material is research evidence. It never ships inside a game.</span>
        </footer>
      </div>
    </article>
  )
}
