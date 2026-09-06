import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { app, ipcMain, safeStorage, shell, dialog } from 'electron'
import { boundedText, listing, object, uuid } from '@gauntlet/publishing'
import { packDirectory, validateArtifact } from '@gauntlet/publishing/node'
import type { Ledger } from './ledger'
import { checkoutRoundRevision, cleanupRoundCheckout } from './round-revision'
import {
  buildPublication,
  recoverPublicationBuild,
  type BuildJob,
} from './publication-build'
import { playAccessError } from './play'
import { IPC } from '../shared/ipc'
import { success, failure } from '../shared/result'
import { redactLogText, redactedErrorMessage } from '../shared/redact-log'
import type { LoopLogLine } from '../shared/loop'
import type { PublicationPreview, ReleaseHistory } from '../shared/publishing'

interface Session {
  access_token: string
  refresh_token: string
}
interface LocalJob {
  gameId: string
  requestKey: string
  digest?: string
  preview?: PublicationPreview
  build?: BuildJob
  publisherId: string
}
/** Separate publishing session and orchestration; no CLI credential access or renderer secrets. */
export class Publishing {
  readonly catalogUrl = new URL(
    process.env.GAUNTLET_CATALOG_URL ?? 'http://127.0.0.1:4310',
  ).origin
  private active = false
  private signInAbort: AbortController | null = null
  private logTarget: { loopId: string; runId: string | null } | null = null
  private readonly root = path.join(
    app.getPath('userData'),
    'publishing',
    createHash('sha256').update(this.catalogUrl).digest('hex').slice(0, 16),
  )
  constructor(
    private readonly ledger: Ledger,
    private readonly emit: (line: LoopLogLine) => void,
  ) {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }
  isBusy(): boolean {
    return this.active
  }
  private log(loopId: string, text: string): void {
    const line: LoopLogLine = {
      loopId,
      runId: this.logTarget?.loopId === loopId ? this.logTarget.runId : null,
      ts: new Date().toISOString(),
      kind: 'system',
      channel: 'system',
      text: redactLogText(text),
    }
    this.ledger.appendEvent(line)
    this.emit(line)
  }
  private session(value?: unknown): Session | null {
    const file = path.join(this.root, 'session.enc')
    if (value) {
      const input = object(value)
      const session = {
        access_token: boundedText(input.access_token, 'access token', 12000),
        refresh_token: boundedText(input.refresh_token, 'refresh token', 12000),
      }
      if (
        !safeStorage.isEncryptionAvailable() ||
        (process.platform === 'linux' &&
          safeStorage.getSelectedStorageBackend() === 'basic_text')
      )
        throw new Error('OS-protected credential storage is unavailable.')
      fs.writeFileSync(
        file,
        safeStorage.encryptString(JSON.stringify(session)),
        { mode: 0o600 },
      )
      return session
    }
    if (!fs.existsSync(file)) return null
    if (fs.statSync(file).size > 32768)
      throw new Error('Publishing session is invalid. Sign in again.')
    const stored = object(
      JSON.parse(safeStorage.decryptString(fs.readFileSync(file))),
    )
    return {
      access_token: boundedText(stored.access_token, 'access token', 12000),
      refresh_token: boundedText(stored.refresh_token, 'refresh token', 12000),
    }
  }
  private async request(
    route: string,
    input?: unknown,
    auth?: Session | null,
  ): Promise<any> {
    const timeout = AbortSignal.timeout(120000)
    const response = await fetch(`${this.catalogUrl}/api/${route}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: this.signInAbort
        ? AbortSignal.any([timeout, this.signInAbort.signal])
        : timeout,
    })
    const data = await response.json()
    if (!response.ok)
      throw new Error(
        typeof data.error === 'string' ? data.error : 'Catalog request failed.',
      )
    return data
  }
  private async authenticated(): Promise<Session> {
    const current = this.session()
    if (!current) throw new Error('Sign in to publishing first.')
    const updated = await this.request('refresh', {
      refreshToken: current.refresh_token,
    })
    return this.session(updated)!
  }
  async status() {
    const session = this.session()
    if (!session)
      return {
        connected: false,
        catalogUrl: this.catalogUrl,
        publisherName: null,
      }
    const me = await this.request('me', undefined, await this.authenticated())
    return {
      connected: true,
      catalogUrl: this.catalogUrl,
      publisherName: String(me.publisher.display_name),
    }
  }
  async signIn() {
    if (this.active)
      throw new Error('A publishing operation is already running.')
    this.active = true
    this.signInAbort = new AbortController()
    try {
      const secret = randomBytes(32).toString('hex'),
        challenge = createHash('sha256').update(secret).digest('hex')
      const start = await this.request('device/start', { challenge })
      if (new URL(start.url).origin !== this.catalogUrl)
        throw new Error('Unexpected sign-in origin.')
      await shell.openExternal(start.url)
      for (let attempt = 0; attempt < 150; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const session = await this.request('device/poll', {
          code: start.code,
          secret,
        })
        if (!session.pending) {
          this.session(session)
          return this.status()
        }
      }
      throw new Error('Sign-in timed out. Try again.')
    } finally {
      this.active = false
      this.signInAbort = null
    }
  }
  cancelSignIn(): void {
    this.signInAbort?.abort(new Error('Publishing sign-in cancelled.'))
  }
  signOut(): void {
    if (this.active)
      throw new Error('Wait for the publishing operation to finish.')
    fs.rmSync(path.join(this.root, 'session.enc'), { force: true })
  }
  private jobFile(loopId: string): string {
    return path.join(this.root, `${uuid(loopId)}.json`)
  }
  private readJob(loopId: string): LocalJob | null {
    const file = this.jobFile(loopId)
    if (!fs.existsSync(file)) return null
    if (fs.statSync(file).size > 65536)
      throw new Error('Publishing job is too large or damaged.')
    const stored = object(JSON.parse(fs.readFileSync(file, 'utf8')))
    const job: LocalJob = {
      gameId: uuid(stored.gameId),
      requestKey: uuid(stored.requestKey),
      publisherId: uuid(stored.publisherId),
    }
    if (stored.digest !== undefined) {
      if (
        typeof stored.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(stored.digest)
      )
        throw new Error('Publishing digest is damaged.')
      job.digest = stored.digest
    }
    if (stored.build) {
      const build = object(stored.build),
        loop = this.ledger.getLoop(loopId)
      const directory = boundedText(build.directory, 'build checkout', 4096)
      if (
        !loop ||
        path.resolve(directory) !== directory ||
        fs.realpathSync(directory) !== directory ||
        !directory.startsWith(
          `${loop.workspaceDir}${path.sep}.gauntlet-gamesmith${path.sep}play${path.sep}`,
        ) ||
        !['starting', 'running', 'finished'].includes(String(build.status))
      )
        throw new Error('Publishing build record is invalid.')
      job.build = {
        directory,
        runId: uuid(build.runId),
        status: build.status as BuildJob['status'],
        gateDir: boundedText(build.gateDir, 'build gate', 4096),
      }
    }
    if (stored.preview) {
      const preview = object(stored.preview),
        gameUrl = new URL(boundedText(preview.gameUrl, 'game URL', 2000))
      if (
        gameUrl.origin !== this.catalogUrl ||
        !gameUrl.pathname.startsWith('/games/') ||
        !Number.isSafeInteger(preview.generation) ||
        (preview.generation as number) < 0 ||
        preview.gameId !== job.gameId
      )
        throw new Error('Publishing preview record is invalid.')
      job.preview = {
        gameId: job.gameId,
        releaseId: uuid(preview.releaseId),
        generation: preview.generation as number,
        gameUrl: gameUrl.toString(),
        previewUrl: '',
      }
    }
    return job
  }
  private save(loopId: string, job: LocalJob): void {
    const file = this.jobFile(loopId),
      temp = `${file}.tmp`
    fs.writeFileSync(temp, JSON.stringify(job), { mode: 0o600 })
    fs.renameSync(temp, file)
  }
  async prepare(value: unknown): Promise<PublicationPreview> {
    if (this.active)
      throw new Error('A publishing operation is already running.')
    const input = object(value),
      loopId = uuid(input.loopId),
      round = input.round
    if (!Number.isSafeInteger(round) || (round as number) < 1)
      throw new Error('Select a completed saved round.')
    const metadata = listing(input),
      output = boundedText(input.outputDir, 'build directory', 100)
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(output))
      throw new Error('Build directory must be a relative folder such as dist.')
    const loop = this.ledger.getLoop(loopId)
    if (!loop) throw new Error('Run not found.')
    const trustError = playAccessError(loop)
    if (trustError) throw new Error(trustError)
    this.ledger.assertLoopWorkspaceIdentity(loopId)
    const revision = this.ledger.succeededImplementRevision(
      loopId,
      round as number,
    )
    if (!revision)
      throw new Error('No immutable revision exists for this round.')
    this.active = true
    let checkout: string | null = null
    try {
      const auth = await this.authenticated(),
        me = await this.request('me', undefined, auth)
      const job: LocalJob = this.readJob(loopId) ?? {
        gameId: randomUUID(),
        requestKey: randomUUID(),
        publisherId: uuid(me.publisher.id),
      }
      if (job.publisherId !== me.publisher.id)
        throw new Error(
          'This run is linked to another publisher. Sign in to that account.',
        )
      if (job.build)
        await recoverPublicationBuild(job.build, (text) =>
          this.log(loopId, text),
        )
      this.logTarget = {
        loopId,
        runId:
          this.ledger
            .runsForLoop(loopId)
            .find(
              (run) =>
                run.role === 'implement' &&
                run.round === round &&
                run.revision === revision,
            )?.id ?? null,
      }
      this.log(
        loopId,
        `Preparing publication of round ${round}, revision ${revision}.`,
      )
      checkout = checkoutRoundRevision(
        loop.workspaceDir,
        loopId,
        round as number,
        revision,
      )
      await buildPublication(
        checkout,
        (build) => {
          job.build = build
          this.save(loopId, job)
        },
        (text) => this.log(loopId, text),
      )
      const buildDir = path.join(checkout, output),
        canonical = fs.realpathSync(buildDir)
      if (!canonical.startsWith(`${fs.realpathSync(checkout)}${path.sep}`))
        throw new Error('Build output escaped the saved revision.')
      const artifact = await packDirectory(buildDir, revision),
        fingerprint = createHash('sha256')
          .update(validateArtifact(artifact).digest + JSON.stringify(metadata))
          .digest('hex')
      if (job.digest !== fingerprint) {
        job.requestKey = randomUUID()
        job.digest = fingerprint
        job.preview = undefined
      }
      this.save(loopId, job)
      this.log(
        loopId,
        `Uploading ${artifact.files.length} shipping files. Run history and harness credentials are excluded.`,
      )
      const sourceRunId = this.logTarget.runId
      if (!sourceRunId)
        throw new Error('The saved round has no implementation run.')
      const started = await this.request(
        'releases',
        {
          gameId: job.gameId,
          requestKey: job.requestKey,
          listing: metadata,
          digest: validateArtifact(artifact).digest,
          source: { loopId, runId: sourceRunId, round, revision },
        },
        auth,
      )
      if (!started.ready) {
        const uploadUrl = new URL(
          boundedText(started.uploadUrl, 'upload URL', 4000),
        )
        const local = ['localhost', '127.0.0.1'].includes(
          new URL(this.catalogUrl).hostname,
        )
        if (
          uploadUrl.protocol !== 'https:' &&
          !(
            local &&
            uploadUrl.protocol === 'http:' &&
            ['127.0.0.1', 'localhost'].includes(uploadUrl.hostname)
          )
        )
          throw new Error('Untrusted artifact upload URL.')
        const uploaded = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(artifact),
          signal: AbortSignal.timeout(120000),
        })
        if (!uploaded.ok && uploaded.status !== 409 && uploaded.status !== 400)
          throw new Error('Artifact transfer failed. Retry this saved round.')
      }
      const release = await this.request(
        'releases/complete',
        { releaseId: uuid(started.releaseId) },
        auth,
      )
      const preview = await this.request(
        'preview',
        { releaseId: release.id },
        auth,
      )
      const current = await this.request('me', undefined, auth),
        game = current.games.find((g: any) => g.id === job.gameId)
      const result: PublicationPreview = {
        gameId: uuid(job.gameId),
        releaseId: uuid(release.id),
        generation: game.generation,
        gameUrl: `${this.catalogUrl}/games/${metadata.slug}`,
        previewUrl: preview.url,
      }
      // Bearer preview URLs are ephemeral; do not persist them in portable logs.
      job.preview = { ...result, previewUrl: '' }
      this.save(loopId, job)
      this.log(
        loopId,
        `Release ${result.releaseId} is ready for private preview. It is not yet published.`,
      )
      const previewOrigin = new URL(preview.url).origin
      const allowed = new URL(
        process.env.GAUNTLET_GAME_ORIGIN ?? this.catalogUrl,
      )
      if (!process.env.GAUNTLET_GAME_ORIGIN)
        allowed.port = process.env.GAUNTLET_GAME_PORT ?? '4311'
      if (previewOrigin !== allowed.origin)
        throw new Error('Unexpected preview origin.')
      await shell.openExternal(preview.url)
      return { ...result, previewUrl: '' }
    } catch (error) {
      this.log(
        loopId,
        `Publication failed: ${redactedErrorMessage(error, 'Unknown publishing error.')}`,
      )
      throw error
    } finally {
      this.active = false
      if (checkout) cleanupRoundCheckout(checkout)
    }
  }
  async history(value: unknown): Promise<ReleaseHistory> {
    const loopId = uuid(value),
      job = this.readJob(loopId)
    if (!job)
      return {
        gameId: null,
        currentReleaseId: null,
        generation: 0,
        gameUrl: null,
        releases: [],
      }
    const me = await this.request('me', undefined, await this.authenticated())
    if (job.publisherId !== me.publisher.id)
      throw new Error('This run belongs to another publisher account.')
    const game = me.games.find((game: { id: string }) => game.id === job.gameId)
    if (!game) throw new Error('Published game was not found.')
    return {
      gameId: game.id,
      currentReleaseId: game.current_release_id,
      generation: game.generation,
      gameUrl: `${this.catalogUrl}/games/${game.slug}`,
      releases: me.releases
        .filter((release: { game_id: string }) => release.game_id === game.id)
        .map(
          (release: {
            id: string
            listing: { title: string }
            status: string
            created_at: string
            source: { round: number; revision: string } | null
          }) => ({
            id: release.id,
            title: release.listing.title,
            status: release.status,
            createdAt: release.created_at,
            round: release.source?.round ?? null,
            revision: release.source?.revision ?? null,
          }),
        ),
    }
  }
  async previewRelease(value: unknown): Promise<PublicationPreview> {
    if (this.active)
      throw new Error('A publishing operation is already running.')
    const input = object(value),
      loopId = uuid(input.loopId),
      releaseId = uuid(input.releaseId)
    this.active = true
    try {
      const history = await this.history(loopId),
        job = this.readJob(loopId)
      if (
        !job ||
        !history.gameId ||
        !history.gameUrl ||
        !history.releases.some(
          (release) => release.id === releaseId && release.status === 'ready',
        )
      )
        throw new Error('Choose a ready release from this run.')
      const preview = await this.request(
        'preview',
        { releaseId },
        await this.authenticated(),
      )
      const allowed = new URL(
        process.env.GAUNTLET_GAME_ORIGIN ?? this.catalogUrl,
      )
      if (!process.env.GAUNTLET_GAME_ORIGIN)
        allowed.port = process.env.GAUNTLET_GAME_PORT ?? '4311'
      if (new URL(preview.url).origin !== allowed.origin)
        throw new Error('Unexpected preview origin.')
      const result = {
        gameId: history.gameId,
        releaseId,
        generation: history.generation,
        gameUrl: history.gameUrl,
        previewUrl: '',
      }
      job.preview = result
      this.save(loopId, job)
      await shell.openExternal(preview.url)
      this.log(loopId, `Opened private preview for release ${releaseId}.`)
      return result
    } finally {
      this.active = false
    }
  }
  async unpublish(value: unknown): Promise<void> {
    if (this.active)
      throw new Error('A publishing operation is already running.')
    const input = object(value),
      loopId = uuid(input.loopId)
    this.active = true
    try {
      const history = await this.history(loopId)
      if (
        !history.gameId ||
        !history.currentReleaseId ||
        input.generation !== history.generation
      )
        throw new Error('Refresh releases before unpublishing.')
      const choice = await dialog.showMessageBox({
        type: 'question',
        message: 'Unpublish this game?',
        detail:
          'Players will lose access. Your saved releases remain available for republishing.',
        buttons: ['Keep published', 'Unpublish'],
        defaultId: 0,
        cancelId: 0,
      })
      if (choice.response !== 1) return
      await this.request(
        'promote',
        {
          gameId: history.gameId,
          releaseId: null,
          generation: history.generation,
        },
        await this.authenticated(),
      )
      this.log(
        loopId,
        `Unpublished game ${history.gameId}. Saved releases remain available.`,
      )
    } finally {
      this.active = false
    }
  }
  async publish(value: unknown): Promise<string> {
    const input = object(value),
      loopId = uuid(input.loopId)
    if (this.active)
      throw new Error('A publishing operation is already running.')
    const job = this.readJob(loopId)
    if (
      !job?.preview ||
      job.preview.gameId !== input.gameId ||
      job.preview.releaseId !== input.releaseId ||
      job.preview.generation !== input.generation
    )
      throw new Error('Preview this exact release before publishing.')
    this.active = true
    try {
      await this.request(
        'promote',
        {
          gameId: uuid(input.gameId),
          releaseId: uuid(input.releaseId),
          generation: input.generation,
        },
        await this.authenticated(),
      )
      this.log(
        loopId,
        `Published release ${job.preview.releaseId}: ${job.preview.gameUrl}`,
      )
      return job.preview.gameUrl
    } finally {
      this.active = false
    }
  }
}
export function registerPublishingIpc(service: Publishing): void {
  const handle = (name: string, operation: (value: unknown) => unknown) =>
    ipcMain.handle(name, async (_event, value: unknown) => {
      try {
        return success(await operation(value))
      } catch (error) {
        return failure(
          redactedErrorMessage(error, 'Publishing operation failed.'),
        )
      }
    })
  handle(IPC.publishing.status, () => service.status())
  handle(IPC.publishing.signIn, () => service.signIn())
  handle(IPC.publishing.signOut, () => service.signOut())
  handle(IPC.publishing.history, (value) => service.history(value))
  handle(IPC.publishing.previewRelease, (value) =>
    service.previewRelease(value),
  )
  handle(IPC.publishing.unpublish, (value) => service.unpublish(value))
  handle(IPC.publishing.cancelSignIn, () => service.cancelSignIn())
  handle(IPC.publishing.prepare, (value) => service.prepare(value))
  handle(IPC.publishing.publish, (value) => service.publish(value))
}
