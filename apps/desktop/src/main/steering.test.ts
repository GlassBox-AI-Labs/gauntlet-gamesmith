import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SteeringStore } from './steering-store'
import { MODEL_IDS, resolveModels } from '../shared/models'
import { Ledger } from './ledger'
import { copyRunFolder } from './run-transfer'
import { SteeringService } from './steering'
import { consultArgs, type ConsultInput, type ConsultResult } from './steering-agent'
import { parseSteeringReply, steeringInput } from '../shared/steering'
import type { LoopModels } from '../shared/loop'
import { estimateCostUsd } from './pricing'

const models:LoopModels=resolveModels({}, {})
let store:SteeringStore
let ledger:Ledger,dir:string
function setup(){dir=fs.mkdtempSync(path.join(os.tmpdir(),'steering-test-'));ledger=new Ledger(path.join(dir,'ledger.db'));store=new SteeringStore(ledger);const workspaceDir=path.join(dir,'project');fs.mkdirSync(workspaceDir);return ledger.createLoop({prompt:'Build a game',workspaceDir,maxRounds:5,budgetUsd:null,models})}
afterEach(()=>{try{ledger?.close()}catch{};if(dir)fs.rmSync(dir,{recursive:true,force:true})})
function direction(loopId:string,text:string){const run=ledger.createRun({loopId,round:1,role:'consult',harness:'codex',prompt:'chat'});const source=store.addSteeringMessage(loopId,'user',text,run.id);store.completeSteering(run.id,{reply:text,directives:[{text,sourceMessageIds:[source]}]});return store.steeringState(loopId).directives.at(-1)!}
function implementation(loopId:string,round:number){return ledger.createRun({loopId,round,role:'implement',harness:'claude',prompt:`Build round ${round}`})}
function critic(loopId:string,round:number){return ledger.createRun({loopId,round,role:'critique',harness:'codex',prompt:`Judge round ${round}`})}

describe('steering boundaries',()=>{
  it.each([false, true])('includes pending directions on explicit Resume without rewriting history (legacy=%s)', legacy => {
    const loop = setup(), original = implementation(loop.id, 1)
    if (!legacy) {
      direction(loop.id, 'Use touch controls')
      store.freezeRunRequirements(original.id)
    }
    const oldSnapshot = store.requirementsForRun(original.id)
    const oldPrompt = ledger.getRun(original.id)!.prompt
    ledger.patchRun(original.id, { status: 'failed', startedAt: new Date().toISOString() })
    const pending = direction(loop.id, 'Use mouse edge panning first')
    const retry = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: oldPrompt })
    store.includePendingOnResume(retry.id)
    const frozen = store.freezeRunRequirements(retry.id)
    const snapshot = store.requirementsForRun(retry.id)
    expect(frozen.prompt).toContain(pending.text)
    expect(frozen.prompt.match(/<operator-directive>/g)).toHaveLength(1)
    expect(store.requirementsForRun(original.id)).toEqual(oldSnapshot)
    expect(ledger.getRun(original.id)!.prompt).toBe(oldPrompt)
    expect(store.steeringState(loop.id).directives.find(d => d.id === pending.id)?.firstRunId).toBe(retry.id)
    ledger.patchRun(retry.id, { status: 'running' })
    const late = direction(loop.id, 'Add dash later')
    store.includePendingOnResume(retry.id)
    expect(ledger.getRun(retry.id)!.prompt).toBe(frozen.prompt)
    const recovered = ledger.requeueInterruptedRun(ledger.getRun(retry.id)!)
    ledger.close(); ledger = new Ledger(path.join(dir, 'ledger.db')); store = new SteeringStore(ledger)
    expect(store.freezeRunRequirements(recovered.id).prompt).not.toContain(late.text)
    expect(store.requirementsForRun(recovered.id)).toEqual(snapshot)
    ledger.patchRun(recovered.id, { status: 'succeeded' })
    const review = store.freezeRunRequirements(critic(loop.id, 1).id)
    expect(store.requirementsForRun(review.id)).toEqual(snapshot)
    expect(review.prompt).toContain(pending.text)
    expect(review.prompt).not.toContain(late.text)
  })

  it('freezes at dispatch, excludes late feedback from critique, and carries it into the next round',()=>{
    const loop=setup(),run=implementation(loop.id,1)
    const a=direction(loop.id,'Use touch controls') // queued prompt already exists
    const launched=store.freezeRunRequirements(run.id)
    expect(launched.prompt).toContain(a.text)
    ledger.patchRun(run.id,{status:'running'})
    const b=direction(loop.id,'Add dash')
    expect(store.freezeRunRequirements(run.id).prompt).toBe(launched.prompt)
    ledger.patchRun(run.id,{status:'succeeded'})
    const review=store.freezeRunRequirements(critic(loop.id,1).id)
    expect(review.prompt).toContain(a.text)
    expect(review.prompt).not.toContain(b.text)
    expect(store.requirementsForRun(review.id)).toEqual(store.requirementsForRun(run.id))
    const next=store.freezeRunRequirements(implementation(loop.id,2).id)
    expect(next.prompt).toContain(a.text);expect(next.prompt).toContain(b.text)
    ledger.patchRun(next.id,{status:'succeeded'})
    const nextReview=store.freezeRunRequirements(critic(loop.id,2).id)
    expect(store.requirementsForRun(nextReview.id)).toEqual(store.requirementsForRun(next.id))
  })
  it('preserves snapshots across interruption and restart and prevents withdrawal after inclusion',()=>{
    const loop=setup(),a=direction(loop.id,'Use touch controls'),run=store.freezeRunRequirements(implementation(loop.id,1).id)
    ledger.patchRun(run.id,{status:'running'})
    direction(loop.id,'Remove touch controls')
    const retry=ledger.requeueInterruptedRun(run)
    ledger.close();ledger=new Ledger(path.join(dir,'ledger.db'));store=new SteeringStore(ledger)
    expect(store.freezeRunRequirements(retry.id).prompt).not.toContain('Remove touch controls')
    expect(store.requirementsForRun(retry.id)).toEqual(store.requirementsForRun(run.id))
    expect(()=>store.withdrawSteering(loop.id,a.id)).toThrow('already been included')
    const next=store.freezeRunRequirements(implementation(loop.id,2).id)
    expect(next.prompt.indexOf('Use touch controls')).toBeLessThan(next.prompt.indexOf('Remove touch controls'))
  })
  it('keeps full requirement snapshots and consult history through folder export and import', async () => {
    const loop = setup()
    store.setModel(loop.id, MODEL_IDS.codexLuna)
    direction(loop.id, 'Use touch controls. ' + 'A'.repeat(5000))
    const run = store.freezeRunRequirements(implementation(loop.id, 1).id)
    ledger.patchRun(run.id, {status:'succeeded'})
    ledger.patchLoop(loop.id, {status:'stopped'})
    const before = store.steeringState(loop.id), snapshot = store.requirementsForRun(run.id)
    expect(store.freezeRunRequirements(run.id).prompt).toBe(run.prompt)
    expect(snapshot?.directives[0].text.length).toBeGreaterThan(4096)
    ledger.prepareRunFolder(loop.id)
    ledger.close()
    const exported = path.join(dir, 'exported')
    await copyRunFolder(loop.workspaceDir, exported)
    ledger = new Ledger(path.join(dir, 'imported.db')); store = new SteeringStore(ledger)
    ledger.importRunFolder(exported)
    expect(store.steeringState(loop.id)).toEqual(before)
    expect(store.requirementsForRun(run.id)).toEqual(snapshot)
    expect(ledger.getRun(run.id)?.prompt).toBe(run.prompt)
    const review = store.freezeRunRequirements(critic(loop.id, 1).id)
    expect(store.requirementsForRun(review.id)).toEqual(snapshot)
  })
  it('withdraws only pending directions and excludes other loops',()=>{
    const loop=setup(),d=direction(loop.id,'Add dash')
    store.withdrawSteering(loop.id,d.id)
    const other=ledger.createLoop({prompt:'Other game',workspaceDir:dir,maxRounds:3,budgetUsd:null,models})
    direction(other.id,'Add multiplayer')
    const run=store.freezeRunRequirements(implementation(loop.id,1).id)
    expect(store.requirementsForRun(run.id)?.directives).toEqual([])
    expect(store.steeringState(loop.id).messages.at(-1)?.content).toContain('Withdrawn')
  })
  it('does not retroactively apply steering to a pre-feature implementation',()=>{
    const loop=setup(),legacy=implementation(loop.id,1)
    ledger.patchRun(legacy.id,{status:'succeeded'})
    direction(loop.id,'Add dash')
    const review=store.freezeRunRequirements(critic(loop.id,1).id)
    expect(store.requirementsForRun(review.id)?.directives).toEqual([])
  })
  it('keeps pre-steering runs readable and persists their new history and prompt hashes',()=>{
    const loop=setup(),run=implementation(loop.id,1)
    ledger.close()
    const old=new DatabaseSync(path.join(dir,'ledger.db'))
    old.exec('DELETE FROM events;');old.close()
    ledger=new Ledger(path.join(dir,'ledger.db'));store=new SteeringStore(ledger);direction(loop.id,'Larger text')
    store.freezeRunRequirements(run.id)
    ledger.close();ledger=new Ledger(path.join(dir,'ledger.db'));store=new SteeringStore(ledger)
    expect(ledger.getLoop(loop.id)?.prompt).toBe('Build a game')
    expect(store.steeringState(loop.id).directives[0].firstRunId).toBe(run.id)
    expect(ledger.eventsForLoop(loop.id).some(e=>e.kind==='steering-message')).toBe(true)
    const db=new DatabaseSync(path.join(dir,'ledger.db'))
    const hash=db.prepare('SELECT prompt_sha256 FROM runs WHERE id=?').get(run.id) as {prompt_sha256:string}
    expect(hash.prompt_sha256).toBe(crypto.createHash('sha256').update(ledger.getRun(run.id)!.prompt).digest('hex'));db.close()
  })
})

describe('chat service isolation',()=>{
  it('persists each run’s model and freezes it for an active reply and its cost', async () => {
    const loop = setup(), calls: ConsultInput[] = []
    let finish!: (result: ConsultResult) => void
    const service = new SteeringService(ledger, input => { calls.push(input); return new Promise(resolve => { finish = resolve }) }, () => {})
    const other = ledger.createLoop({ prompt: 'Other game', workspaceDir: dir, maxRounds: 3, budgetUsd: null, models })
    expect(service.history(loop.id).model).toBe(MODEL_IDS.codexSol)
    expect(service.setModel({ loopId: loop.id, model: MODEL_IDS.codexAstra }).model).toBe(MODEL_IDS.codexAstra)
    expect(service.history(other.id).model).toBe(MODEL_IDS.codexSol)
    service.message({ loopId: loop.id, messageId: 'first', content: 'Explain the current goal.' })
    service.setModel({ loopId: loop.id, model: MODEL_IDS.codexLuna })
    const tokens = { input: 100, output: 50, cacheRead: 20, cacheWrite: 0 }
    finish({ text: JSON.stringify({ reply: 'Build a game.', directives: [] }), tokens, sessionId: null })
    await new Promise(resolve => setTimeout(resolve, 0))
    const first = ledger.getRun(calls[0].attemptId)!
    expect(calls[0].model).toBe(MODEL_IDS.codexAstra)
    expect(first.model).toBe(MODEL_IDS.codexAstra)
    expect(first.costUsd).toBe(estimateCostUsd(MODEL_IDS.codexAstra, tokens))
    service.message({ loopId: loop.id, messageId: 'second', content: 'What should we refine?' })
    expect(calls[1].model).toBe(MODEL_IDS.codexLuna)
    finish({ text: JSON.stringify({ reply: 'Which part feels off?', directives: [] }), tokens: null, sessionId: null })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ledger.runAggregate(loop.id).phaseAttemptCount).toBe(0)
    ledger.close(); ledger = new Ledger(path.join(dir, 'ledger.db')); store = new SteeringStore(ledger)
    expect(store.steeringState(loop.id).model).toBe(MODEL_IDS.codexLuna)
  })
  it('rejects unsupported model choices and invalid run IDs without changing preferences', () => {
    const loop = setup()
    const service = new SteeringService(ledger, async () => { throw new Error('Must not start a consult') }, () => {})
    for (const value of [null, {}, { loopId: '../invalid', model: MODEL_IDS.codexSol }, { loopId: 'missing', model: MODEL_IDS.codexSol }, ...[MODEL_IDS.claudeOpus, 'gpt-made-up', null, 3].map(model => ({ loopId: loop.id, model }))]) expect(() => service.setModel(value)).toThrow()
    expect(service.history(loop.id).model).toBe(MODEL_IDS.codexSol)
    expect(ledger.runsForLoop(loop.id)).toHaveLength(0)
  })
  it('records one idempotent consult, accepts grounded directives and counts cost without becoming phase work',async()=>{
    const loop=setup(),phase=implementation(loop.id,1)
    ledger.patchRun(phase.id,{status:'running'})
    let resolve!:(result:ConsultResult)=>void
    let seen:ConsultInput|undefined
    const service=new SteeringService(ledger,input=>{seen=input;return new Promise(r=>{resolve=r})},()=>{})
    const input={loopId:loop.id,messageId:'request-1',content:'Add dash'}
    expect(service.message(input).busy).toBe(true)
    expect(service.message(input).messages).toHaveLength(1)
    expect(ledger.nextQueuedRun(loop.id)).toBeNull()
    expect(seen?.workspaceDir).toBe(loop.workspaceDir)
    resolve({text:JSON.stringify({reply:'Add a short dash.',directives:[{text:'Add a short dash.',sourceMessageIds:['request-1']}]}),tokens:{input:100,output:50,cacheRead:0,cacheWrite:0},sessionId:'independent-chat-session'})
    await new Promise(r=>setTimeout(r,0))
    const state=service.history(loop.id)
    expect(state.busy).toBe(false);expect(state.directives).toHaveLength(1)
    expect(ledger.getRun(phase.id)?.status).toBe('running')
    const consult=ledger.runsForLoop(loop.id).find(r=>r.role==='consult')!
    expect(consult.status).toBe('succeeded');expect(consult.costUsd).toBeGreaterThan(0);expect(consult.sessionId).toBe('independent-chat-session')
    expect(ledger.getLoop(loop.id)?.totalCostUsd).toBe(consult.costUsd)
    expect(ledger.runAggregate(loop.id)).toMatchObject({phaseAttemptCount:1,costUsd:consult.costUsd})
  })
  it('cancels only the consult and can recover an interrupted chat without queuing phase work',async()=>{
    const loop=setup(),phase=implementation(loop.id,1)
    ledger.patchRun(phase.id,{status:'running'})
    const service=new SteeringService(ledger,input=>new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(new Error('Stopped.')))),()=>{})
    service.message({loopId:loop.id,messageId:'cancel-me',content:'Maybe change combat?'})
    service.cancel(loop.id)
    await new Promise(r=>setTimeout(r,0))
    expect(service.history(loop.id).directives).toEqual([])
    expect(ledger.getRun(phase.id)?.status).toBe('running')
    const abandoned=ledger.createRun({loopId:loop.id,round:1,role:'consult',harness:'codex',prompt:'interrupted'})
    ledger.patchRun(abandoned.id,{status:'running'})
    await service.recover()
    expect(ledger.getRun(abandoned.id)?.status).toBe('interrupted')
    expect(ledger.nextQueuedRun(loop.id)).toBeNull()
  })
  it('waits for chat cancellation on quit while the implementation stays running', async () => {
    const loop=setup(), phase=implementation(loop.id,1)
    ledger.patchRun(phase.id,{status:'running'})
    const service=new SteeringService(ledger,input=>new Promise((_,reject)=>input.signal.addEventListener('abort',()=>setTimeout(()=>reject(new Error('Stopped.')),10))),()=>{})
    service.message({loopId:loop.id,messageId:'quit',content:'Add dash'})
    expect(service.hasUnfinished()).toBe(true)
    expect(await service.shutdown()).toBe(true)
    expect(service.hasUnfinished()).toBe(false)
    expect(ledger.getRun(phase.id)?.status).toBe('running')
  })
  it('fails malformed model output without saving partial directives',async()=>{
    const loop=setup()
    const service=new SteeringService(ledger,async()=>({text:JSON.stringify({reply:'Sure',directives:[{text:'Delete everything',sourceMessageIds:['invented']}]}),tokens:null,sessionId:null}),()=>{})
    service.message({loopId:loop.id,messageId:'question',content:'How do abilities work?'})
    await new Promise(r=>setTimeout(r,0))
    expect(service.history(loop.id).directives).toEqual([])
    expect(ledger.runsForLoop(loop.id)[0].status).toBe('failed')
  })
})

describe('input and agent contract',()=>{
  it('rejects malformed and oversized IPC data',()=>{
    for(const value of [null,{}, {loopId:'x',messageId:'y',content:' '},{loopId:'../x',messageId:'y',content:'a'},{loopId:'x',messageId:'y',content:'a'.repeat(12001)}])expect(()=>steeringInput(value)).toThrow()
    expect(()=>parseSteeringReply('{"reply":"ok","directives":null}',new Set())).toThrow()
  })
  it('forces a separate read-only session with a constrained reply schema',()=>{
    const args=consultArgs({attemptId:'consult',prompt:'p',model:'m',workspaceDir:'/workspace',signal:new AbortController().signal},'/private/schema.json')
    expect(args).toContain('read-only');expect(args).toContain('--ignore-user-config');expect(args).toContain('--ephemeral');expect(args).toContain('--output-schema');expect(args).not.toContain('resume');expect(args).not.toContain('--continue')
  })
})
