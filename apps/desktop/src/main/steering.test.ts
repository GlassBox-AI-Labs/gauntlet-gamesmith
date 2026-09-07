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
import { consultArgs } from './steering-agent'
import { parseSteeringReply, steeringInput } from '../shared/steering'
import type { BuildModels } from '../shared/build'

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

describe('input and agent contract',()=>{
  it('rejects malformed and oversized IPC data',()=>{
    for(const value of [null,{}, {buildId:'x',messageId:'y',content:' '},{buildId:'../x',messageId:'y',content:'a'},{buildId:'x',messageId:'y',content:'a'.repeat(12001)}])expect(()=>steeringInput(value)).toThrow()
    expect(()=>parseSteeringReply('{"reply":"ok","directives":null}',new Set())).toThrow()
  })
  it('resumes the lead in read-only mode with a constrained reply schema',()=>{
    const args=consultArgs({attemptId:'consult',prompt:'p',model:MODEL_IDS.codexSol,resumeId:'lead-thread',effort:'high',workspaceDir:'/workspace',signal:new AbortController().signal},'/private/schema.json')
    expect(args).toContain('sandbox_mode="read-only"');expect(args).toContain('--ignore-user-config');expect(args).not.toContain('--ephemeral');expect(args).toContain('--output-schema');expect(args.slice(0,3)).toEqual(['exec','resume','lead-thread']);expect(args).not.toContain('--continue')
  })
  it('resumes Claude with only read tools and without exposing customization or edit tools', () => {
    const args = consultArgs({ attemptId: 'consult', prompt: 'p', model: MODEL_IDS.claudeFable, resumeId: 'lead-thread', effort: 'high', workspaceDir: '/workspace', signal: new AbortController().signal }, '/private/schema.json')
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', 'lead-thread'])
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', 'Read,Grep,Glob'])
    expect(args).toContain('--safe-mode'); expect(args).toContain('--strict-mcp-config'); expect(args).toContain('dontAsk')
    expect(args).toContain('--json-schema'); expect(args).not.toContain('--bare'); expect(args).not.toContain('--dangerously-skip-permissions')
  })
})
