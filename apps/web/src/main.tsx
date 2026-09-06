import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Listing } from '@gauntlet/publishing'
import './style.css'
import appLogo from './app-logo.png'

interface Game { id: string; slug: string; current_release_id: string | null; generation: number; listing: Listing; publisher: { handle: string; display_name: string } }
interface Release { id: string; game_id: string; status: string; created_at: string; listing: Listing; base_generation: number; error: string | null }
interface Session { access_token: string; refresh_token: string }
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}
function savedSession(): Session | null { try { return JSON.parse(sessionStorage.getItem('publisher-session') ?? 'null') } catch { return null } }
const initialPath = window.location.pathname
const gameOrigin = (): string => { const url = new URL(location.origin); url.port = import.meta.env.VITE_GAME_PORT ?? '4311'; return url.origin }
function App() {
  const [games, setGames] = useState<Game[]>([]), [loading, setLoading] = useState(true)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [session, setSession] = useState<Session | null>(savedSession), [mine, setMine] = useState<{ publisher: { display_name: string }; games: Game[]; releases: Release[] } | null>(null)
  const [preview, setPreview] = useState<{ url: string; release: Release } | null>(null)
  const uploadAttempt = useRef<{ signature: string; gameId: string; requestKey: string } | null>(null)
  useEffect(() => { if (session) sessionStorage.setItem('publisher-session', JSON.stringify(session)); else sessionStorage.removeItem('publisher-session') }, [session])
  async function api(route: string, input?: unknown, auth = session): Promise<any> {
    const response = await fetch(`/api/${route}`, { method: input === undefined ? 'GET' : 'POST', headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}) }, body: input === undefined ? undefined : JSON.stringify(input) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? 'Request failed.')
    return data
  }
  async function refresh(auth = session) { setGames(await api('games')); if (auth) setMine(await api('me', undefined, auth)) }
  useEffect(() => { void refresh().catch(e => setError(e.message)).finally(() => setLoading(false)) }, [])
  async function work(fn: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await fn() } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.') } finally { setBusy(false) } }
  const dashboard = initialPath === '/dashboard' || initialPath === '/connect'
  const selected = games.find(g => `/games/${g.slug}` === initialPath)
  const handle = initialPath.startsWith('/publishers/') ? decodeURIComponent(initialPath.slice(12)) : null
  const visible = handle ? games.filter(g => g.publisher.handle === handle) : games
  async function promote(game: Game, release: Release | null) {
    await api('promote', { gameId: game.id, releaseId: release?.id ?? null, generation: game.generation })
    await refresh(); setPreview(null); setNotice(release ? 'Your game is live. Its link stays the same for future updates.' : 'Game unpublished. It is no longer playable through the catalog.')
  }
  return <>
    <header><a className="brand" href="/"><img className="mark" src={appLogo} alt="" /> glassbox<span className="brand-muted">arcade</span></a><nav><a href="/" aria-current={!dashboard ? 'page' : undefined}>Games</a><a href="/dashboard" aria-current={dashboard ? 'page' : undefined}>Publisher studio <span aria-hidden>↗</span></a></nav></header>
    <main>
      {error && <div className="message error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
      {notice && <div className="message" role="status">{notice}</div>}
      {dashboard ? <>
        <div className="intro"><p className="eyebrow">FOR THE MAKERS</p><h1>Publisher studio<span>.</span></h1><p>Give your next game a place to play.</p></div>
        {!session ? <form className="panel login" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void work(async () => { const s = await api('login', { email: form.get('email'), password: form.get('password') }); setSession(s); await refresh(s) }) }}>
          <h2>Developer sign in</h2><p>Use your provisioned Glassbox publisher account.</p>
          <label>Email<input name="email" type="email" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required /></label><button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in →'}</button>
        </form> : <>
          <div className="toolbar"><span>Signed in as <strong>{mine?.publisher.display_name}</strong></span><button onClick={() => { setSession(null); setMine(null); setPreview(null) }}>Sign out</button></div>
          {initialPath === '/connect' && <section className="panel"><h2>Connect your desktop app</h2><p>Approve only if you just started sign-in in Gauntlet Gamesmith.</p><p>Connection code: <code>{new URLSearchParams(location.search).get('code')}</code></p><button disabled={busy} className="primary" onClick={() => void work(async () => { await api('device/approve', { code: new URLSearchParams(location.search).get('code'), refreshToken: session.refresh_token }); setSession(null); setMine(null); setNotice('Desktop connected. This session moved to your desktop. You can close this tab or sign in again to use the studio.') })}>Connect desktop</button></section>}
          <section className="panel"><h2>Bring a game to the arcade</h2><p>Use <strong>Publish</strong> on a saved round in the desktop app, or import a prepared game artifact here.</p>
            <form className="upload-form" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void work(async () => { const file = form.get('artifact') as File; if (file.size > 35 * 1024 * 1024) throw new Error('Artifact must be under 35 MB.'); const existing = String(form.get('gameId') ?? ''); const g = mine?.games.find(g => g.id === existing); const artifact = JSON.parse(await file.text()); const metadata = { title: form.get('title'), slug: g?.slug || form.get('slug'), description: form.get('description'), controls: form.get('controls'), coverPath: form.get('coverPath') || null }; const signature = JSON.stringify([existing, metadata, artifact.sourceRevision, artifact.files?.map((f: any) => [f.path, f.sha256])]); if (uploadAttempt.current?.signature !== signature) uploadAttempt.current = { signature, gameId: existing || newId(), requestKey: newId() }; const release = await api('releases', { gameId: uploadAttempt.current.gameId, requestKey: uploadAttempt.current.requestKey, listing: metadata, artifact }); await refresh(); const p = await api('preview', { releaseId: release.id }); setPreview({ url: p.url, release }); setNotice('Upload ready. Preview this build before publishing.') }) }}>
              <label>Game<select name="gameId"><option value="">New game</option>{mine?.games.map(g => <option key={g.id} value={g.id}>{g.slug}</option>)}</select></label>
              <label>Title<input name="title" maxLength={80} required placeholder="Your game's name" /></label><label>URL slug<input name="slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={64} placeholder="my-game" /></label>
              <label className="wide">Description<textarea name="description" maxLength={2000} required placeholder="What will players discover?" /></label><label className="wide">Controls<input name="controls" maxLength={500} placeholder="Arrow keys to move · Enter to start" /></label>
              <label>Cover image path<input name="coverPath" placeholder="cover.png (inside the build)" /></label><label>Game artifact<input name="artifact" type="file" accept=".json" required /></label><button className="primary" disabled={busy}>{busy ? 'Working…' : 'Upload & preview →'}</button>
            </form>
          </section>
          <h2 className="section-title">Your games <span>{mine?.games.length ?? 0}</span></h2>
          {mine?.games.length === 0 && <p className="empty">Your first release starts here. Publish a saved round or upload a game above.</p>}
          {mine?.games.map(game => <section className="panel" key={game.id}><div className="toolbar"><h2>{game.slug}</h2><span className="pill">{game.current_release_id ? 'Live' : 'Unpublished'}</span></div>{game.current_release_id && <div className="actions"><a href={`/games/${game.slug}`}>Open game ↗</a><button disabled={busy} onClick={() => void work(() => promote(game, null))}>Unpublish</button></div>}
            <div className="releases">{mine.releases.filter(r => r.game_id === game.id).map(release => <div className="release" key={release.id}><div><strong>{release.listing.title}</strong><small>{new Date(release.created_at).toLocaleString()} · {release.status}{release.id === game.current_release_id ? ' · Current release' : ''}</small>{release.error && <small role="alert">{release.error}</small>}</div><button disabled={busy || release.status !== 'ready'} onClick={() => void work(async () => { const p = await api('preview', { releaseId: release.id }); setPreview({ url: p.url, release }) })}>Preview{release.id !== game.current_release_id ? ' / publish' : ''}</button></div>)}</div>
          </section>)}
          {preview && <section className="preview panel"><div className="toolbar"><h2>Release preview: {preview.release.listing.title}</h2><button onClick={() => setPreview(null)}>Close preview</button></div><p>This private preview expires after 30 minutes. Publish only assets you have permission to share.</p><GameFrame url={preview.url} title={preview.release.listing.title} />
            <button className="primary" disabled={busy} onClick={() => void work(async () => { const g = mine?.games.find(g => g.id === preview.release.game_id); if (!g) throw new Error('Refresh your game list.'); await promote(g, preview.release) })}>{busy ? 'Publishing…' : 'Publish this version →'}</button>
          </section>}
        </>}
      </> : selected ? <>
        <a className="back" href="/">← All games</a><div className="game-heading"><div><p className="eyebrow">READY TO PLAY</p><h1>{selected.listing.title}</h1><p>By <a href={`/publishers/${selected.publisher.handle}`}>{selected.publisher.display_name}</a></p></div><span className="pill">Browser game</span></div>
        <GameFrame url={`${gameOrigin()}/play/${selected.id}/${selected.current_release_id}/index.html`} title={selected.listing.title} />
        <section className="game-info"><div><h2>About the game</h2><p>{selected.listing.description}</p></div><div><h2>How to play</h2><p>{selected.listing.controls || 'Follow the instructions in the game.'}</p><small>Keyboard games work best on a desktop or laptop.</small></div></section>
      </> : <>
        <div className="intro"><p className="eyebrow">INDEPENDENT GAMES. OPEN DOORS.</p><h1>{handle ? visible[0]?.publisher.display_name ?? handle : 'Made here. Played here.'}<span>_</span></h1><p>{handle ? 'Games from this publisher.' : 'Small worlds, big ideas. Pick a game and jump in.'}</p></div>
        <div className="section-bar"><h2>{handle ? 'Published games' : 'The collection'} <span>{visible.length.toString().padStart(2, '0')}</span></h2><span>NO ACCOUNT NEEDED TO PLAY</span></div>
        {loading ? <p role="status" className="empty">Loading the arcade…</p> : initialPath.startsWith('/games/') ? <p className="empty">This game is unavailable or unpublished. <a href="/">Browse games</a></p> : visible.length === 0 ? <div className="empty"><h2>The doors are open.</h2><p>The first game is on its way. Developers can publish from the studio.</p><a href="/dashboard">Open publisher studio →</a></div> : <div className="grid">{visible.map((game, i) => <a className="game-card" href={`/games/${game.slug}`} key={game.id}><div className={`cover color-${i % 3}`}>{game.listing.coverPath ? <img src={`${gameOrigin()}/play/${game.id}/${game.current_release_id}/${game.listing.coverPath}`} alt="" loading="lazy" /> : <><div className="pixel-orbit" aria-hidden>✳</div><span className="cover-title">{game.listing.title}</span></>}<span className="play-label">Play now ↗</span></div><div className="card-title"><h3>{game.listing.title}</h3><span aria-hidden>↗</span></div><p>{game.listing.description}</p><small>BY {game.publisher.display_name.toUpperCase()}</small></a>)}</div>}
      </>}
    </main><footer><span>GLASSBOX / ARCADE</span><span>Built with curiosity. Shared to play.</span></footer>
  </>
}
function GameFrame({ url, title }: { url: string; title: string }) {
  const [playing, setPlaying] = useState(false), [loading, setLoading] = useState(true), [frameError, setFrameError] = useState('')
  const [expanded, setExpanded] = useState(false), [restart, setRestart] = useState(0)
  const shell = useRef<HTMLDivElement>(null)
  useEffect(() => { setPlaying(false); setExpanded(false); setLoading(true); setFrameError('') }, [url])
  useEffect(() => {
    if (!expanded) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [expanded])
  async function fullscreen() {
    setExpanded(true)
    try { await shell.current?.requestFullscreen() }
    catch { /* The full-window player remains available in embedded browsers. */ }
  }
  async function back() {
    if (document.fullscreenElement === shell.current) await document.exitFullscreen()
    setExpanded(false)
  }
  return <div ref={shell} className={`player-shell${expanded ? ' player-expanded' : ''}`}>
    <div className="player">{playing ? <>{loading && <span className="player-loading" role="status">Loading game…</span>}<iframe key={`${url}:${restart}`} src={url} title={title} sandbox="allow-scripts allow-pointer-lock" allow="fullscreen; gamepad" onLoad={event => { setLoading(false); event.currentTarget.focus() }} /></> : <div className="player-start"><span className="pixel-orbit" aria-hidden>✳</span><h2>{title}</h2>{frameError && <p role="alert">{frameError}</p>}<button className="primary" onClick={() => { setFrameError(''); void fetch(url, { method: 'HEAD' }).then(response => { if (!response.ok) throw new Error(); setExpanded(true); setPlaying(true) }).catch(() => setFrameError('This game is unavailable. Refresh the page or ask the publisher for a new preview.')) }}>▶ Play game</button></div>}</div>
    <div className="player-tools"><span>{title}</span><div>
      {expanded ? <button onClick={() => void back()}>← Back to page</button> : playing && <button onClick={() => setExpanded(true)}>Expand player</button>}
      <button onClick={() => { setRestart(value => value + 1); setLoading(true) }}>Restart</button>
      <button onClick={() => void fullscreen()}>Fullscreen ⛶</button>
    </div></div>
  </div>
}
createRoot(document.getElementById('root')!).render(<App />)
