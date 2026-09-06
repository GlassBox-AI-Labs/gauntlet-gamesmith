import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SteeringStore } from './steering-store'
import { MODEL_IDS, resolveModels } from '../shared/models'
import { Ledger } from './ledger'
import { copyBuildFolder } from './build-transfer'
import { SteeringService } from './steering'
import { consultArgs, type ConsultInput, type ConsultResult } from './steering-agent'
import { parseSteeringReply, steeringInput } from '../shared/steering'
import type { BuildModels } from '../shared/build'
import { estimateCostUsd } from './pricing'

const models:BuildModels=resolveModels({}, {})
let store:SteeringStore
let ledger:Ledger,dir:string
function setup(){dir=fs.mkdtempSync(path.join(os.tmpdir(),'steering-test-'));ledger=new Ledger(path.join(dir,'ledger.db'));store=new SteeringStore(ledger);const workspaceDir=path.join(dir,'project');fs.mkdirSync(workspaceDir);return ledger.createBuild({prompt:'Build a game',workspaceDir,maxRounds:5,budgetUsd:null,models})}
afterEach(()=>{try{ledger?.close()}catch{};if(dir)fs.rmSync(dir,{recursive:true,force:true})})
function direction(buildId:string,text:string){const attempt=ledger.createAttempt({buildId,round:1,role:'consult',harness:'codex',prompt:'chat'});const source=store.addSteeringMessage(buildId,'user',text,attempt.id);store.completeSteering(attempt.id,{reply:text,directives:[{text,sourceMessageIds:[source]}]});return store.steeringState(buildId).directives.at(-1)!}
function implementation(buildId:string,round:number){return ledger.createAttempt({buildId,round,role:'implement',harness:'claude',prompt:`Build round ${round}`})}
function critic(buildId:string,round:number){return ledger.createAttempt({buildId,round,role:'critique',harness:'codex',prompt:`Judge round ${round}`})}

describe('steering boundaries',()=>{
  it('preserves frozen directions written before the Build vocabulary migration', () => {
    const build = setup(), attempt = implementation(build.id, 1)
    const directive = direction(build.id, 'Keep touch controls')
    ledger.appendEvent({ buildId: build.id, attemptId: attempt.id, role: 'implement', round: 1,
      ts: new Date().toISOString(), kind: 'steering-snapshot', channel: 'system',
      text: JSON.stringify({ implementationRunId: attempt.id, role: 'implement', round: 1,
        directives: [{ id: directive.id, text: directive.text }] }) })
    const original = ledger.steeringEvents(build.id).at(-1)!.text
    ledger.patchAttempt(attempt.id, { status: 'succeeded' })
    expect(store.steeringState(build.id).directives[0].firstAttemptId).toBe(attempt.id)
    const review = store.freezeAttemptRequirements(critic(build.id, 1).id)
    expect(review.prompt).toContain(directive.text)
    expect(store.requirementsForAttempt(review.id)?.implementationAttemptId).toBe(attempt.id)
    expect(ledger.steeringEvents(build.id).find(event => event.attemptId === attempt.id)!.text).toBe(original)
  })

  it.each([false, true])('includes pending directions on explicit Resume without rewriting history (legacy=%s)', legacy => {
    const build = setup(), original = implementation(build.id, 1)
    if (!legacy) {
      direction(build.id, 'Use touch controls')
      store.freezeAttemptRequirements(original.id)
    }
    const oldSnapshot = store.requirementsForAttempt(original.id)
    const oldPrompt = ledger.getAttempt(original.id)!.prompt
    ledger.patchAttempt(original.id, { status: 'failed', startedAt: new Date().toISOString() })
    const pending = direction(build.id, 'Use mouse edge panning first')
    const retry = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'codex', prompt: oldPrompt })
    store.includePendingOnResume(retry.id)
    const frozen = store.freezeAttemptRequirements(retry.id)
    const snapshot = store.requirementsForAttempt(retry.id)
    expect(frozen.prompt).toContain(pending.text)
    expect(frozen.prompt.match(/<operator-directive>/g)).toHaveLength(1)
    expect(store.requirementsForAttempt(original.id)).toEqual(oldSnapshot)
    expect(ledger.getAttempt(original.id)!.prompt).toBe(oldPrompt)
    expect(store.steeringState(build.id).directives.find(d => d.id === pending.id)?.firstAttemptId).toBe(retry.id)
    ledger.patchAttempt(retry.id, { status: 'running' })
    const late = direction(build.id, 'Add dash later')
    store.includePendingOnResume(retry.id)
    expect(ledger.getAttempt(retry.id)!.prompt).toBe(frozen.prompt)
    const recovered = ledger.requeueInterruptedAttempt(ledger.getAttempt(retry.id)!)
    ledger.close(); ledger = new Ledger(path.join(dir, 'ledger.db')); store = new SteeringStore(ledger)
    expect(store.freezeAttemptRequirements(recovered.id).prompt).not.toContain(late.text)
    expect(store.requirementsForAttempt(recovered.id)).toEqual(snapshot)
    ledger.patchAttempt(recovered.id, { status: 'succeeded' })
    const review = store.freezeAttemptRequirements(critic(build.id, 1).id)
    expect(store.requirementsForAttempt(review.id)).toEqual(snapshot)
    expect(review.prompt).toContain(pending.text)
    expect(review.prompt).not.toContain(late.text)
  })

  it('freezes at dispatch, excludes late feedback from critique, and carries it into the next round',()=>{
    const build=setup(),attempt=implementation(build.id,1)
    const a=direction(build.id,'Use touch controls') // queued prompt already exists
    const launched=store.freezeAttemptRequirements(attempt.id)
    expect(launched.prompt).toContain(a.text)
    ledger.patchAttempt(attempt.id,{status:'running'})
    const b=direction(build.id,'Add dash')
    expect(store.freezeAttemptRequirements(attempt.id).prompt).toBe(launched.prompt)
    ledger.patchAttempt(attempt.id,{status:'succeeded'})
    const review=store.freezeAttemptRequirements(critic(build.id,1).id)
    expect(review.prompt).toContain(a.text)
    expect(review.prompt).not.toContain(b.text)
    expect(store.requirementsForAttempt(review.id)).toEqual(store.requirementsForAttempt(attempt.id))
    const next=store.freezeAttemptRequirements(implementation(build.id,2).id)
    expect(next.prompt).toContain(a.text);expect(next.prompt).toContain(b.text)
    ledger.patchAttempt(next.id,{status:'succeeded'})
    const nextReview=store.freezeAttemptRequirements(critic(build.id,2).id)
    expect(store.requirementsForAttempt(nextReview.id)).toEqual(store.requirementsForAttempt(next.id))
  })
  it('preserves snapshots across interruption and restart and prevents withdrawal after inclusion',()=>{
    const build=setup(),a=direction(build.id,'Use touch controls'),attempt=store.freezeAttemptRequirements(implementation(build.id,1).id)
    ledger.patchAttempt(attempt.id,{status:'running'})
    direction(build.id,'Remove touch controls')
    const retry=ledger.requeueInterruptedAttempt(attempt)
    ledger.close();ledger=new Ledger(path.join(dir,'ledger.db'));store=new SteeringStore(ledger)
    expect(store.freezeAttemptRequirements(retry.id).prompt).not.toContain('Remove touch controls')
    expect(store.requirementsForAttempt(retry.id)).toEqual(store.requirementsForAttempt(attempt.id))
    expect(()=>store.withdrawSteering(build.id,a.id)).toThrow('already been included')
    const next=store.freezeAttemptRequirements(implementation(build.id,2).id)
    expect(next.prompt.indexOf('Use touch controls')).toBeLessThan(next.prompt.indexOf('Remove touch controls'))
  })
  it('keeps full requirement snapshots and consult history through folder export and import', async () => {
    const build = setup()
    store.setModel(build.id, MODEL_IDS.codexLuna)
    direction(build.id, 'Use touch controls. ' + 'A'.repeat(5000))
    const attempt = store.freezeAttemptRequirements(implementation(build.id, 1).id)
    ledger.patchAttempt(attempt.id, {status:'succeeded'})
    ledger.patchBuild(build.id, {status:'stopped'})
    const before = store.steeringState(build.id), snapshot = store.requirementsForAttempt(attempt.id)
    expect(store.freezeAttemptRequirements(attempt.id).prompt).toBe(attempt.prompt)
    expect(snapshot?.directives[0].text.length).toBeGreaterThan(4096)
    ledger.prepareBuildFolder(build.id)
    ledger.close()
    const exported = path.join(dir, 'exported')
    await copyBuildFolder(build.workspaceDir, exported)
    ledger = new Ledger(path.join(dir, 'imported.db')); store = new SteeringStore(ledger)
    ledger.importBuildFolder(exported)
    expect(store.steeringState(build.id)).toEqual(before)
    expect(store.requirementsForAttempt(attempt.id)).toEqual(snapshot)
    expect(ledger.getAttempt(attempt.id)?.prompt).toBe(attempt.prompt)
    const review = store.freezeAttemptRequirements(critic(build.id, 1).id)
    expect(store.requirementsForAttempt(review.id)).toEqual(snapshot)
  })
  it('withdraws only pending directions and excludes other loops',()=>{
    const build=setup(),d=direction(build.id,'Add dash')
    store.withdrawSteering(build.id,d.id)
    const other=ledger.createBuild({prompt:'Other game',workspaceDir:dir,maxRounds:3,budgetUsd:null,models})
    direction(other.id,'Add multiplayer')
    const attempt=store.freezeAttemptRequirements(implementation(build.id,1).id)
    expect(store.requirementsForAttempt(attempt.id)?.directives).toEqual([])
    expect(store.steeringState(build.id).messages.at(-1)?.content).toContain('Withdrawn')
  })
  it('does not retroactively apply steering to a pre-feature implementation',()=>{
    const build=setup(),legacy=implementation(build.id,1)
    ledger.patchAttempt(legacy.id,{status:'succeeded'})
    direction(build.id,'Add dash')
    const review=store.freezeAttemptRequirements(critic(build.id,1).id)
    expect(store.requirementsForAttempt(review.id)?.directives).toEqual([])
  })
  it('keeps pre-steering runs readable and persists their new history and prompt hashes',()=>{
    const build=setup(),attempt=implementation(build.id,1)
    ledger.close()
    const old=new DatabaseSync(path.join(dir,'ledger.db'))
    old.exec('DELETE FROM events;');old.close()
    ledger=new Ledger(path.join(dir,'ledger.db'));store=new SteeringStore(ledger);direction(build.id,'Larger text')
    store.freezeAttemptRequirements(attempt.id)
    ledger.close();ledger=new Ledger(path.join(dir,'ledger.db'));store=new SteeringStore(ledger)
    expect(ledger.getBuild(build.id)?.prompt).toBe('Build a game')
    expect(store.steeringState(build.id).directives[0].firstAttemptId).toBe(attempt.id)
    expect(ledger.eventsForBuild(build.id).some(e=>e.kind==='steering-message')).toBe(true)
    const db=new DatabaseSync(path.join(dir,'ledger.db'))
    const hash=db.prepare('SELECT prompt_sha256 FROM phase_attempts WHERE id=?').get(attempt.id) as {prompt_sha256:string}
    expect(hash.prompt_sha256).toBe(crypto.createHash('sha256').update(ledger.getAttempt(attempt.id)!.prompt).digest('hex'));db.close()
  })
})

describe('chat service isolation',()=>{
  it('persists each run’s model and freezes it for an active reply and its cost', async () => {
    const build = setup(), calls: ConsultInput[] = []
    let finish!: (result: ConsultResult) => void
    const service = new SteeringService(ledger, input => { calls.push(input); return new Promise(resolve => { finish = resolve }) }, () => {})
    const other = ledger.createBuild({ prompt: 'Other game', workspaceDir: dir, maxRounds: 3, budgetUsd: null, models })
    expect(service.history(build.id).model).toBe(MODEL_IDS.codexSol)
    expect(service.setModel({ buildId: build.id, model: MODEL_IDS.codexAstra }).model).toBe(MODEL_IDS.codexAstra)
    expect(service.history(other.id).model).toBe(MODEL_IDS.codexSol)
    service.message({ buildId: build.id, messageId: 'first', content: 'Explain the current goal.' })
    service.setModel({ buildId: build.id, model: MODEL_IDS.codexLuna })
    const tokens = { input: 100, output: 50, cacheRead: 20, cacheWrite: 0 }
    finish({ text: JSON.stringify({ reply: 'Build a game.', directives: [] }), tokens, sessionId: null })
    await new Promise(resolve => setTimeout(resolve, 0))
    const first = ledger.getAttempt(calls[0].attemptId)!
    expect(calls[0].model).toBe(MODEL_IDS.codexAstra)
    expect(first.model).toBe(MODEL_IDS.codexAstra)
    expect(first.costUsd).toBe(estimateCostUsd(MODEL_IDS.codexAstra, tokens))
    service.message({ buildId: build.id, messageId: 'second', content: 'What should we refine?' })
    expect(calls[1].model).toBe(MODEL_IDS.codexLuna)
    finish({ text: JSON.stringify({ reply: 'Which part feels off?', directives: [] }), tokens: null, sessionId: null })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ledger.attemptAggregate(build.id).phaseAttemptCount).toBe(0)
    ledger.close(); ledger = new Ledger(path.join(dir, 'ledger.db')); store = new SteeringStore(ledger)
    expect(store.steeringState(build.id).model).toBe(MODEL_IDS.codexLuna)
  })
  it('rejects unsupported model choices and invalid run IDs without changing preferences', () => {
    const build = setup()
    const service = new SteeringService(ledger, async () => { throw new Error('Must not start a consult') }, () => {})
    for (const value of [null, {}, { buildId: '../invalid', model: MODEL_IDS.codexSol }, { buildId: 'missing', model: MODEL_IDS.codexSol }, ...[MODEL_IDS.claudeOpus, 'gpt-made-up', null, 3].map(model => ({ buildId: build.id, model }))]) expect(() => service.setModel(value)).toThrow()
    expect(service.history(build.id).model).toBe(MODEL_IDS.codexSol)
    expect(ledger.attemptsForBuild(build.id)).toHaveLength(0)
  })
  it('records one idempotent consult, accepts grounded directives and counts cost without becoming phase work',async()=>{
    const build=setup(),phase=implementation(build.id,1)
    ledger.patchAttempt(phase.id,{status:'running'})
    let resolve!:(result:ConsultResult)=>void
    let seen:ConsultInput|undefined
    const service=new SteeringService(ledger,input=>{seen=input;return new Promise(r=>{resolve=r})},()=>{})
    const input={buildId:build.id,messageId:'request-1',content:'Add dash'}
    expect(service.message(input).busy).toBe(true)
    expect(service.message(input).messages).toHaveLength(1)
    expect(ledger.nextQueuedAttempt(build.id)).toBeNull()
    expect(seen?.workspaceDir).toBe(build.workspaceDir)
    resolve({text:JSON.stringify({reply:'Add a short dash.',directives:[{text:'Add a short dash.',sourceMessageIds:['request-1']}]}),tokens:{input:100,output:50,cacheRead:0,cacheWrite:0},sessionId:'independent-chat-session'})
    await new Promise(r=>setTimeout(r,0))
    const state=service.history(build.id)
    expect(state.busy).toBe(false);expect(state.directives).toHaveLength(1)
    expect(ledger.getAttempt(phase.id)?.status).toBe('running')
    const consult=ledger.attemptsForBuild(build.id).find(r=>r.role==='consult')!
    expect(consult.status).toBe('succeeded');expect(consult.costUsd).toBeGreaterThan(0);expect(consult.sessionId).toBe('independent-chat-session')
    expect(ledger.getBuild(build.id)?.totalCostUsd).toBe(consult.costUsd)
    expect(ledger.attemptAggregate(build.id)).toMatchObject({phaseAttemptCount:1,costUsd:consult.costUsd})
  })
  it('cancels only the consult and can recover an interrupted chat without queuing phase work',async()=>{
    const build=setup(),phase=implementation(build.id,1)
    ledger.patchAttempt(phase.id,{status:'running'})
    const service=new SteeringService(ledger,input=>new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(new Error('Stopped.')))),()=>{})
    service.message({buildId:build.id,messageId:'cancel-me',content:'Maybe change combat?'})
    service.cancel(build.id)
    await new Promise(r=>setTimeout(r,0))
    expect(service.history(build.id).directives).toEqual([])
    expect(ledger.getAttempt(phase.id)?.status).toBe('running')
    const abandoned=ledger.createAttempt({buildId:build.id,round:1,role:'consult',harness:'codex',prompt:'interrupted'})
    ledger.patchAttempt(abandoned.id,{status:'running'})
    await service.recover()
    expect(ledger.getAttempt(abandoned.id)?.status).toBe('interrupted')
    expect(ledger.nextQueuedAttempt(build.id)).toBeNull()
  })
  it('waits for chat cancellation on quit while the implementation stays running', async () => {
    const build=setup(), phase=implementation(build.id,1)
    ledger.patchAttempt(phase.id,{status:'running'})
    const service=new SteeringService(ledger,input=>new Promise((_,reject)=>input.signal.addEventListener('abort',()=>setTimeout(()=>reject(new Error('Stopped.')),10))),()=>{})
    service.message({buildId:build.id,messageId:'quit',content:'Add dash'})
    expect(service.hasUnfinished()).toBe(true)
    expect(await service.shutdown()).toBe(true)
    expect(service.hasUnfinished()).toBe(false)
    expect(ledger.getAttempt(phase.id)?.status).toBe('running')
  })
  it('fails malformed model output without saving partial directives',async()=>{
    const build=setup()
    const service=new SteeringService(ledger,async()=>({text:JSON.stringify({reply:'Sure',directives:[{text:'Delete everything',sourceMessageIds:['invented']}]}),tokens:null,sessionId:null}),()=>{})
    service.message({buildId:build.id,messageId:'question',content:'How do abilities work?'})
    await new Promise(r=>setTimeout(r,0))
    expect(service.history(build.id).directives).toEqual([])
    expect(ledger.attemptsForBuild(build.id)[0].status).toBe('failed')
  })
})

describe('input and agent contract',()=>{
  it('rejects malformed and oversized IPC data',()=>{
    for(const value of [null,{}, {buildId:'x',messageId:'y',content:' '},{buildId:'../x',messageId:'y',content:'a'},{buildId:'x',messageId:'y',content:'a'.repeat(12001)}])expect(()=>steeringInput(value)).toThrow()
    expect(()=>parseSteeringReply('{"reply":"ok","directives":null}',new Set())).toThrow()
  })
  it('forces a separate read-only session with a constrained reply schema',()=>{
    const args=consultArgs({attemptId:'consult',prompt:'p',model:'m',workspaceDir:'/workspace',signal:new AbortController().signal},'/private/schema.json')
    expect(args).toContain('read-only');expect(args).toContain('--ignore-user-config');expect(args).toContain('--ephemeral');expect(args).toContain('--output-schema');expect(args).not.toContain('resume');expect(args).not.toContain('--continue')
  })
})
