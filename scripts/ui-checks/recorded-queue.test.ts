import assert from 'node:assert/strict'
import { runRecordedQueue, type QueueEntry } from '../../src/features/uat/recorded-queue'
const make = () => ['b','a'].map(id => ({id,title:id,state:'waiting',results:[]} as QueueEntry))
let entries=make(), calls:string[]=[], current='', cancelled=false
const update=(i:number,p:Partial<QueueEntry>)=>{entries[i]={...entries[i],...p}}
await runRecordedQueue(entries,{agentId:'server',dryRun:true,cancelled:()=>false,update,started:()=>{},pause:async()=>{},request:async(url,body)=>{
 if(url.endsWith('/run')){current=(body as any).recordedScriptId;calls.push(current);assert.equal((body as any).dryRun,true);return {sessionId:'run-'+current}}
 if(url.endsWith('/status'))return {sessionId:'run-'+current,status:'done'}
 return {runs:[{runId:'old',results:[{outcome:'pass'}]},{runId:'run-'+current,results:[{outcome:current==='b'?'fail':'pass'}]}]}
}})
assert.deepEqual(calls,['b','a']);assert.equal(entries[0].results[0].outcome,'fail');assert.equal(entries[1].state,'done')
entries=make();calls=[]
await runRecordedQueue(entries,{agentId:'server',dryRun:false,cancelled:()=>cancelled,update,started:()=>{cancelled=true},pause:async()=>{},request:async(url,body)=>{
 if(url.endsWith('/run')){calls.push((body as any).recordedScriptId);return {sessionId:'only'}}
 if(url.endsWith('/stop')){calls.push('stop');return {ok:true}}
 if(url.endsWith('/status'))return {sessionId:'only',status:calls.includes('stop')?'error':'running'}
 return {runs:[]}
}})
assert.deepEqual(calls,['b','stop']);assert.ok(entries.every(e=>e.state==='cancelled'))
entries=make();calls=[]
await runRecordedQueue(entries,{agentId:'server',dryRun:true,cancelled:()=>false,update,started:()=>{},pause:async()=>{},request:async(url)=>{
 if(url.endsWith('/run')){calls.push('run');return {sessionId:'mine'}}
 return {sessionId:'someone-else',status:'done'}
}})
assert.equal(calls.length,1);assert.equal(entries[0].state,'error');assert.equal(entries[1].state,'cancelled')
entries=make();calls=[]
await runRecordedQueue(entries,{agentId:'server',dryRun:true,cancelled:()=>false,update,started:()=>{},pause:async()=>{},request:async(url)=>{
 if(url.endsWith('/run')){calls.push('run');throw Error('409 busy')}
 return {}
}})
assert.equal(calls.length,1);assert.equal(entries[0].state,'error');assert.equal(entries[1].state,'cancelled')
console.log('PASS ordered execution, FAIL continuation, exact run results, cancellation during start, foreign session and startup error halt')
