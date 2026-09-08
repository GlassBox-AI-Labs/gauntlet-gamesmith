import { uploadArtifact } from './artifact-upload'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import {
  app,
  ipcMain,
  safeStorage,
  shell,
  dialog,
  BrowserWindow,
} from 'electron'
import { boundedText, object, uuid } from '@gauntlet/publishing'
import {
  packDirectory,
  validateArtifact,
  normalizeCover,
} from '@gauntlet/publishing/node'
import type { Ledger } from './ledger'
import { checkoutRoundRevision, cleanupRoundCheckout } from './round-revision'
import {
  buildPublication,
  recoverPublicationBuild,
  type BuildJob,
} from './publication-build'
import { playAccessError } from './play'
import { publicationCover, publicationListing } from './publication-listing'
import { requestCatalog } from './publishing-response'
import { publishingConfig } from './publishing-config'
import { IPC } from '../shared/ipc'
import { success, failure } from '../shared/result'
import { redactLogText, redactedErrorMessage } from '../shared/redact-log'
import type { BuildLogLine } from '../shared/build'
import {
  enrollmentEmail,
  publisherCredentials,
  publisherSignup,
  publisherVerification,
} from './publishing-auth'
import { studioSchema, listingUpdateSchema } from '@gauntlet/data/contracts'
import { publicationGames } from './publication-state'
import type {
  PublicationPreview,
  ReleaseHistory,
  PublishedGame,
  PublisherLibrary,
} from '../shared/publishing'

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
  private readonly config = publishingConfig({
    GAUNTLET_CATALOG_URL: process.env.GAUNTLET_CATALOG_URL,
    GAUNTLET_GAME_ORIGIN: process.env.GAUNTLET_GAME_ORIGIN,
    GAUNTLET_GAME_PORT: process.env.GAUNTLET_GAME_PORT,
  })
  readonly catalogUrl = this.config.catalogUrl
  private active = false
  private sessionEpoch = 0
  private refreshing: Promise<Session> | null = null
  private previews = new Map<string, PublicationPreview>()
  private coverSelection: { id: string; bytes: Buffer } | null = null
  private signInAbort: AbortController | null = null
  private logTarget: { buildId: string; attemptId: string | null } | null = null
  private readonly root = path.join(
    app.getPath('userData'),
    'publishing',
    createHash('sha256').update(this.catalogUrl).digest('hex').slice(0, 16),
  )
  constructor(
    private readonly ledger: Ledger,
    private readonly emit: (line: BuildLogLine) => void,
  ) {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }
  isBusy(): boolean {
    return this.active
  }
  private log(buildId: string, text: string): void {
    const line: BuildLogLine = {
      buildId,
      attemptId:
        this.logTarget?.buildId === buildId ? this.logTarget.attemptId : null,
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
    const timeout = AbortSignal.timeout(this.signInAbort ? 30000 : 120000)
    return requestCatalog(this.catalogUrl, route, {
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
  }
  private async authenticated(): Promise<Session> {
    if (this.refreshing) return this.refreshing
    const epoch = this.sessionEpoch
    const operation = (async () => {
      const current = this.session()
      if (!current) throw new Error('Sign in to publishing first.')
      const updated = await this.request('refresh', {
        refreshToken: current.refresh_token,
      })
      if (epoch !== this.sessionEpoch)
        throw new Error('Publisher account changed. Refresh and try again.')
      return this.session(updated)!
    })()
    this.refreshing = operation
    try {
      return await operation
    } finally {
      if (this.refreshing === operation) this.refreshing = null
    }
  }
  private async studio() {
    const epoch = this.sessionEpoch
    const result = studioSchema.parse(
      await this.request('me', undefined, await this.authenticated()),
    )
    if (epoch !== this.sessionEpoch)
      throw new Error('Publisher account changed. Refresh and try again.')
    return result
  }
  async library(): Promise<PublisherLibrary> {
    if (!this.session())
      return {
        status: {
          connected: false,
          catalogUrl: this.catalogUrl,
          publisherName: null,
        },
        games: [],
      }
    const me = await this.studio()
    return {
      status: {
        connected: true,
        catalogUrl: this.catalogUrl,
        publisherName: me.publisher.display_name,
      },
      games: publicationGames(me, this.catalogUrl),
    }
  }
  async status() {
    return (await this.library()).status
  }
  private async accountOperation<T>(operation: () => Promise<T>): Promise<T> {
    const endpoint = new URL(this.catalogUrl)
    if (
      endpoint.protocol !== 'https:' &&
      !(
        endpoint.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
      )
    )
      throw new Error('Publisher sign-in requires HTTPS or a loopback catalog.')
    if (this.active)
      throw new Error('A publishing operation is already running.')
    this.active = true
    this.signInAbort = new AbortController()
    try {
      return await operation()
    } finally {
      this.active = false
      this.signInAbort = null
    }
  }
  private completeSignIn(result: unknown) {
    this.signInAbort?.signal.throwIfAborted()
    const input = object(result)
    const publisherName = boundedText(
      object(input.publisher).display_name,
      'publisher name',
      200,
    )
    // Never persist passwords or codes, or return tokens through IPC.
    this.sessionEpoch += 1
    this.refreshing = null
    this.previews.clear()
    this.coverSelection = null
    this.session(input)
    return { connected: true, catalogUrl: this.catalogUrl, publisherName }
  }
  async signIn(value: unknown) {
    const input = publisherCredentials(value)
    return this.accountOperation(async () =>
      this.completeSignIn(await this.request('login', input)),
    )
  }
  async signUp(value: unknown): Promise<void> {
    const input = publisherSignup(value)
    return this.accountOperation(async () => {
      await this.request('signup', input)
    })
  }
  async verifyEmail(value: unknown) {
    const input = publisherVerification(value)
    return this.accountOperation(async () =>
      this.completeSignIn(await this.request('verify-email', input)),
    )
  }
  async sendSignInCode(value: unknown): Promise<void> {
    const input = enrollmentEmail(value)
    return this.accountOperation(async () => {
      await this.request('sign-in-code', input)
    })
  }
  async resendVerification(value: unknown): Promise<void> {
    const input = enrollmentEmail(value)
    return this.accountOperation(async () => {
      await this.request('resend-verification', input)
    })
  }
  cancelSignIn(): void {
    this.signInAbort?.abort(new Error('Publishing sign-in cancelled.'))
  }
  signOut(): void {
    if (this.active)
      throw new Error('Wait for the publishing operation to finish.')
    this.sessionEpoch += 1
    this.refreshing = null
    this.previews.clear()
    this.coverSelection = null
    fs.rmSync(path.join(this.root, 'session.enc'), { force: true })
  }
  private jobFile(buildId: string): string {
    return path.join(this.root, `${uuid(buildId)}.json`)
  }
  private readJob(buildId: string): LocalJob | null {
    const file = this.jobFile(buildId)
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
        projectBuild = this.ledger.getBuild(buildId)
      const directory = boundedText(build.directory, 'build checkout', 4096)
      if (
        !projectBuild ||
        path.resolve(directory) !== directory ||
        fs.realpathSync(directory) !== directory ||
        !directory.startsWith(
          `${projectBuild.workspaceDir}${path.sep}.gauntlet-gamesmith${path.sep}play${path.sep}`,
        ) ||
        !['starting', 'running', 'finished'].includes(String(build.status))
      )
        throw new Error('Publishing build record is invalid.')
      job.build = {
        directory,
        attemptId: uuid(build.attemptId ?? build.runId),
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
  private save(buildId: string, job: LocalJob): void {
    const file = this.jobFile(buildId),
      temp = `${file}.tmp`
    fs.writeFileSync(temp, JSON.stringify(job), { mode: 0o600 })
    fs.renameSync(temp, file)
  }
  async prepare(value: unknown): Promise<PublicationPreview> {
    if (this.active)
      throw new Error('A publishing operation is already running.')
    const input = object(value),
      buildId = uuid(input.buildId),
      round = input.round
    if (!Number.isSafeInteger(round) || (round as number) < 1)
      throw new Error('Select a completed saved round.')
    const metadata = publicationListing(input)
    const projectBuild = this.ledger.getBuild(buildId)
    if (!projectBuild) throw new Error('Build not found.')
    const trustError = playAccessError(projectBuild)
    if (trustError) throw new Error(trustError)
    this.ledger.assertBuildWorkspaceIdentity(buildId)
    const revision = this.ledger.succeededImplementRevision(
      buildId,
      round as number,
    )
    if (!revision)
      throw new Error('No immutable revision exists for this round.')
    this.active = true
    let checkout: string | null = null
    try {
      const auth = await this.authenticated(),
        me = await this.request('me', undefined, auth)
      const job: LocalJob = this.readJob(buildId) ?? {
        gameId: randomUUID(),
        requestKey: randomUUID(),
        publisherId: uuid(me.publisher.id),
      }
      if (job.publisherId !== me.publisher.id)
        throw new Error(
          'This build is linked to another publisher. Sign in to that account.',
        )
      if (job.build)
        await recoverPublicationBuild(job.build, (text) =>
          this.log(buildId, text),
        )
      this.logTarget = {
        buildId,
        attemptId:
          this.ledger
            .attemptsForBuild(buildId)
            .find(
              (attempt) =>
                attempt.role === 'implement' &&
                attempt.round === round &&
                attempt.revision === revision,
            )?.id ?? null,
      }
      this.log(
        buildId,
        `Preparing publication of round ${round}, revision ${revision}.`,
      )
      checkout = checkoutRoundRevision(
        projectBuild.workspaceDir,
        buildId,
        round as number,
        revision,
      )
      const buildDir = await buildPublication(
        checkout,
        (build) => {
          job.build = build
          this.save(buildId, job)
        },
        (text) => this.log(buildId, text),
      )
      const artifact = await packDirectory(buildDir, revision, (text) =>
        this.log(buildId, text),
      )
      metadata.coverPath = publicationCover(artifact)
      this.log(
        buildId,
        metadata.coverPath
          ? `Using shipping cover: ${metadata.coverPath}.`
          : 'No shipping cover found; the catalog will use its default artwork.',
      )
      const fingerprint = createHash('sha256')
        .update(validateArtifact(artifact).digest + JSON.stringify(metadata))
        .digest('hex')
      if (job.digest !== fingerprint) {
        job.requestKey = randomUUID()
        job.digest = fingerprint
        job.preview = undefined
      }
      this.save(buildId, job)
      this.log(
        buildId,
        `Uploading ${artifact.files.length} shipping files. Build history and harness credentials are excluded.`,
      )
      const sourceAttemptId = this.logTarget.attemptId
      if (!sourceAttemptId)
        throw new Error('The saved round has no implementation attempt.')
      const started = await this.request(
        'releases',
        {
          gameId: job.gameId,
          requestKey: job.requestKey,
          listing: metadata,
          digest: validateArtifact(artifact).digest,
          // Keep the initial hosted provenance contract compatible across desktop updates.
          source: { loopId: buildId, runId: sourceAttemptId, round, revision },
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
        await uploadArtifact(uploadUrl, artifact, (text) =>
          this.log(buildId, text),
        )
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
      this.save(buildId, job)
      this.log(
        buildId,
        `Release ${result.releaseId} is ready for private preview. It is not yet published.`,
      )
      const previewOrigin = new URL(preview.url).origin
      if (previewOrigin !== this.config.gameOrigin)
        throw new Error('Unexpected preview origin.')
      await shell.openExternal(preview.url)
      this.previews.set(result.gameId, { ...result, previewUrl: '' })
      return { ...result, previewUrl: '' }
    } catch (error) {
      this.log(
        buildId,
        `Publication failed: ${redactedErrorMessage(error, 'Unknown publishing error.')}`,
      )
      throw error
    } finally {
      this.active = false
      if (checkout) cleanupRoundCheckout(checkout)
    }
  }
  private async game(value: unknown): Promise<PublishedGame> {
    const input = object(value)
    const games = (await this.library()).games
    if (input.gameId !== undefined) {
      const id = uuid(input.gameId)
      const game = games.find((g) => g.gameId === id)
      if (!game)
        throw new Error('This game is not owned by the connected publisher.')
      return game
    }
    const buildId = uuid(input.buildId)
    const game = games.find((g) =>
      g.releases.some((r) => r.buildId === buildId),
    )
    if (!game)
      throw new Error('No published game is associated with this build.')
    return game
  }
  async history(value: unknown): Promise<ReleaseHistory> {
    const buildId = uuid(value)
    const library = await this.library()
    if (!library.status.connected)
      throw new Error('Sign in to check publication status.')
    const game = library.games.find((g) =>
      g.releases.some((r) => r.buildId === buildId),
    )
    if (game) return game
    if (fs.existsSync(this.jobFile(buildId)))
      throw new Error(
        'Publication unavailable for this account. Sign in to the build’s publisher account or refresh.',
      )
    return {
      gameId: null,
      currentReleaseId: null,
      generation: 0,
      gameUrl: null,
      releases: [],
    }
  }
  private async manage<T>(
    value: unknown,
    operation: (game: PublishedGame) => Promise<T>,
  ): Promise<T> {
    if (this.active)
      throw new Error('A publishing operation is already running.')
    this.active = true
    let game: PublishedGame | undefined
    try {
      game = await this.game(value)
      return await operation(game)
    } catch (error) {
      if (game)
        this.logGame(
          game,
          `Publishing operation failed: ${redactedErrorMessage(error, 'Unknown error.')}`,
        )
      throw error
    } finally {
      this.active = false
    }
  }
  private logGame(game: PublishedGame, text: string) {
    for (const buildId of new Set(game.releases.map((r) => r.buildId))) {
      if (buildId && this.ledger.getBuild(buildId)) this.log(buildId, text)
    }
  }
  async previewRelease(value: unknown): Promise<PublicationPreview> {
    const input = object(value),
      releaseId = uuid(input.releaseId)
    return this.manage(input, async (game) => {
      if (
        !game.releases.some((r) => r.id === releaseId && r.status === 'ready')
      )
        throw new Error('Choose a ready release from this game.')
      const preview = await this.request(
        'preview',
        { releaseId },
        await this.authenticated(),
      )
      if (new URL(preview.url).origin !== this.config.gameOrigin)
        throw new Error('Unexpected preview origin.')
      await shell.openExternal(preview.url)
      const result = {
        gameId: game.gameId,
        releaseId,
        generation: game.generation,
        gameUrl: game.gameUrl,
        previewUrl: '',
      }
      this.previews.set(game.gameId, result)
      this.logGame(game, `Opened private preview for release ${releaseId}.`)
      return result
    })
  }
  async unpublish(value: unknown): Promise<void> {
    const input = object(value)
    return this.manage(input, async (game) => {
      if (!game.currentReleaseId || input.generation !== game.generation)
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
        { gameId: game.gameId, releaseId: null, generation: game.generation },
        await this.authenticated(),
      )
      this.previews.delete(game.gameId)
      this.logGame(
        game,
        `Unpublished game ${game.gameId}. Saved releases remain available.`,
      )
    })
  }
  async publish(value: unknown): Promise<string> {
    const input = object(value),
      gameId = uuid(input.gameId),
      releaseId = uuid(input.releaseId)
    return this.manage(input, async (game) => {
      const preview = this.previews.get(gameId)
      if (
        !preview ||
        preview.releaseId !== releaseId ||
        preview.generation !== input.generation ||
        game.generation !== input.generation
      )
        throw new Error('Preview this exact release again before publishing.')
      await this.request(
        'promote',
        { gameId, releaseId, generation: game.generation },
        await this.authenticated(),
      )
      this.previews.delete(gameId)
      this.logGame(game, `Published release ${releaseId}: ${game.gameUrl}`)
      return game.gameUrl
    })
  }
  async openGame(value: unknown): Promise<void> {
    const game = await this.game({ gameId: uuid(value) })
    if (!game.currentReleaseId) throw new Error('This game is unpublished.')
    await shell.openExternal(game.gameUrl)
  }
  async cover(value: unknown): Promise<string | null> {
    const epoch = this.sessionEpoch
    const data = await this.request(
      'covers/read',
      { gameId: uuid(value) },
      await this.authenticated(),
    )
    if (epoch !== this.sessionEpoch)
      throw new Error('Publisher account changed.')
    if (data.dataUrl === null) return null
    if (
      typeof data.dataUrl !== 'string' ||
      data.dataUrl.length > 4 * 1024 * 1024 + 32 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(data.dataUrl)
    )
      throw new Error('Invalid cover response.')
    return data.dataUrl
  }
  async chooseCover() {
    if (this.active)
      throw new Error('A publishing operation is already running.')
    this.active = true
    try {
      const selected = await dialog.showOpenDialog({
        title: 'Choose game cover',
        properties: ['openFile'],
        filters: [
          {
            name: 'Cover image',
            extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
          },
        ],
      })
      if (selected.canceled || !selected.filePaths[0]) return null
      const file = fs.openSync(
        selected.filePaths[0],
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      )
      let bytes: Buffer
      try {
        const stat = fs.fstatSync(file)
        if (!stat.isFile() || stat.size > 3 * 1024 * 1024)
          throw new Error('Choose an image up to 3 MiB.')
        bytes = Buffer.alloc(stat.size)
        if (fs.readSync(file, bytes, 0, bytes.length, 0) !== bytes.length)
          throw new Error('Cover changed while reading. Choose it again.')
      } finally {
        fs.closeSync(file)
      }
      bytes = await normalizeCover(bytes)
      const id = randomUUID()
      this.coverSelection = { id, bytes }
      return {
        id,
        dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      }
    } finally {
      this.active = false
    }
  }
  async updateListing(value: unknown): Promise<void> {
    const input = object(value)
    const listing = listingUpdateSchema.parse({
      gameId: input.gameId,
      generation: input.generation,
      description: input.description,
      controls: input.controls,
    })
    const selection =
      input.coverSelectionId === undefined ? null : uuid(input.coverSelectionId)
    return this.manage(listing, async (game) => {
      if (game.generation !== listing.generation)
        throw new Error('Game changed. Refresh before saving.')
      const auth = await this.authenticated()
      let upload: { coverId: string; coverToken: string } | undefined
      if (selection) {
        if (this.coverSelection?.id !== selection)
          throw new Error('Select the cover again.')
        const started = await this.request(
          'covers/upload',
          { gameId: game.gameId, generation: game.generation },
          auth,
        )
        const url = new URL(
          boundedText(started.uploadUrl, 'cover upload URL', 4000),
        )
        if (
          url.protocol !== 'https:' &&
          !(
            new URL(this.catalogUrl).protocol === 'http:' &&
            url.protocol === 'http:' &&
            ['localhost', '127.0.0.1'].includes(url.hostname)
          )
        )
          throw new Error('Untrusted cover upload URL.')
        const response = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/png', 'x-upsert': 'false' },
          body: new Uint8Array(this.coverSelection.bytes),
          signal: AbortSignal.timeout(120000),
        })
        if (!response.ok) throw new Error('Cover upload failed. Try again.')
        upload = {
          coverId: uuid(started.coverId),
          coverToken: boundedText(
            started.coverToken,
            'cover upload receipt',
            100,
          ),
        }
      }
      await this.request('listing', { ...listing, ...upload }, auth)
      this.coverSelection = null
      this.previews.delete(game.gameId)
      this.logGame(
        game,
        `Updated published listing for ${game.gameId}. The playable release is unchanged.`,
      )
    })
  }
}
export function registerPublishingIpc(service: Publishing): void {
  const handle = (name: string, operation: (value: unknown) => unknown) =>
    ipcMain.handle(name, async (_event, value: unknown) => {
      try {
        const result = await operation(value)
        if (
          [
            IPC.publishing.signIn,
            IPC.publishing.verifyEmail,
            IPC.publishing.signOut,
            IPC.publishing.publish,
            IPC.publishing.unpublish,
            IPC.publishing.updateListing,
          ].some((channel) => channel === name)
        ) {
          for (const window of BrowserWindow.getAllWindows())
            window.webContents.send(
              IPC.publishing.changed,
              [
                IPC.publishing.signIn,
                IPC.publishing.verifyEmail,
                IPC.publishing.signOut,
              ].some((channel) => channel === name)
                ? 'account'
                : 'games',
            )
        }
        return success(result)
      } catch (error) {
        return failure(
          redactedErrorMessage(error, 'Publishing operation failed.'),
        )
      }
    })
  handle(IPC.publishing.library, () => service.library())
  handle(IPC.publishing.cover, (value) => service.cover(value))
  handle(IPC.publishing.chooseCover, () => service.chooseCover())
  handle(IPC.publishing.updateListing, (value) => service.updateListing(value))
  handle(IPC.publishing.openGame, (value) => service.openGame(value))
  handle(IPC.publishing.status, () => service.status())
  handle(IPC.publishing.signIn, (input) => service.signIn(input))
  handle(IPC.publishing.signUp, (input) => service.signUp(input))
  handle(IPC.publishing.sendSignInCode, (input) => service.sendSignInCode(input))
  handle(IPC.publishing.verifyEmail, (input) => service.verifyEmail(input))
  handle(IPC.publishing.resendVerification, (input) =>
    service.resendVerification(input),
  )
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
