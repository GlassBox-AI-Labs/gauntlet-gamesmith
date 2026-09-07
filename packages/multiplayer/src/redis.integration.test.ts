import { describe, it, expect } from 'vitest'
import { RedisRoomStore } from './redis'
import { MultiplayerServer } from './server'
import { createClient } from 'redis'
import { randomUUID } from 'node:crypto'
import { clientMessage, type Snapshot, type State } from './index'
const url=process.env.MULTIPLAYER_TEST_REDIS
const scope='c'.repeat(32)
describe.skipIf(!url)('shared Redis room protocol', () => {
  it('coordinates separate relay instances, isolates rooms, and enforces ownership and deadlines', async () => {
    const namespace='test-'+randomUUID(), a=new RedisRoomStore(url!,namespace), b=new RedisRoomStore(url!,namespace)
    const raw=createClient({url}); await raw.connect()
    const serverA=new MultiplayerServer(a,'a'.repeat(64),'ws://localhost'), serverB=new MultiplayerServer(b,'a'.repeat(64),'ws://localhost')
    const input={scope,gameId:randomUUID(),releaseId:randomUUID(),name:'One',manifest:{version:1,mode:'relay',maxPlayers:6,sessionSeconds:180} as const}
    try {
      const first=await serverA.join(input),second=await serverB.join({...input,name:'Two'})
      expect(first.room.startAt).toBeNull(); expect(first.room.endAt).toBeNull()
      expect(second.room.id).toBe(first.room.id); expect(second.room.players).toHaveLength(2)
      const ref=serverA.verify(first.ticket), other=serverB.verify(second.ticket)
      await expect(b.start(other)).rejects.toThrow('first player')
      const room=await a.start(ref); expect(room.endAt!-room.startAt!).toBe(180000)
      const separate=await serverB.join(input); expect(separate.room.id).not.toBe(room.id)
      await b.leave(serverB.verify(separate.ticket))
      await expect(b.read(serverB.verify(separate.ticket))).rejects.toThrow('expired')
      const key=`${namespace}:{${scope}}:room:${room.id}`
      await raw.set(key,JSON.stringify({...room,startAt:Date.now()-1000,endAt:Date.now()+30000}),{PXAT:room.expiresAt})
      const received: Snapshot[]=[]; const off=await b.subscribe(ref,s=>received.push(s))
      await a.publish(ref,{type:'state',playerId:ref.playerId,seq:1,at:Date.now(),state:{x:1}})
      await new Promise(r=>setTimeout(r,50));expect(received).toHaveLength(1)
      await a.publish(ref,{type:'state',playerId:ref.playerId,seq:1,at:Date.now(),state:{x:999}})
      await new Promise(r=>setTimeout(r,25));expect(received).toHaveLength(1)
      const states: State[] = [
        { x: 2, y: 12, z: -4, vx: 0, vy: 2, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1, animation: 'gliding' },
        { tile: 4, switchOn: true, revision: 2, puzzle: 'bridge' },
      ]
      for (const [index, state] of states.entries()) {
        const message = { type: 'state' as const, seq: index + 2, at: Date.now(), state }
        expect(clientMessage.parse(message)).toEqual(message)
        await a.publish(ref, { ...message, playerId: ref.playerId })
        await new Promise(r=>setTimeout(r,50))
        expect(received.at(-1)?.state).toEqual(state)
      }
      expect(received).toHaveLength(3)
      await raw.set(key,JSON.stringify({...room,startAt:Date.now()-180001,endAt:Date.now()-1}),{PXAT:room.expiresAt})
      await a.publish(ref,{type:'state',playerId:ref.playerId,seq:4,at:Date.now(),state:{x:2}})
      await new Promise(r=>setTimeout(r,25));expect(received).toHaveLength(3)
      await off()
    } finally { for await(const keys of raw.scanIterator({MATCH:`${namespace}:*`,COUNT:100})) if(keys.length) await raw.del(keys);raw.destroy();await a.close();await b.close() }
  })
})
