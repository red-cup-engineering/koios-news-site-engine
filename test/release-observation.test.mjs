import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observeRelease,readPublicBaseline} from '../src/release-observation.mjs';
const sha='a'.repeat(64),revision='b'.repeat(40);
const receipt=phase=>({kind:phase==='preview'?'koios.news.cloudflare-preview-deployment-receipt/v1':'koios.news.cloudflare-release-receipt/v1',
 candidateManifestSha256:sha,probe:{accepted:true,candidateManifestSha256:sha,manifestSha256:sha}});
const options=events=>({revision,runId:'38142736555',runAttempt:'1',emit:row=>events.push(row)});

test('baseline body consumption stays inside exactly the original attempt and timeout budgets',async()=>{
 const original=new DOMException('unpublished sensitive message','TimeoutError'),delays=[],signals=[];
 let calls=0;
 await assert.rejects(readPublicBaseline({fetchImpl:async(url,config)=>{
  calls++;assert.equal(url,'https://koios.news/manifest.json');signals.push(config.signal);
  return{ok:true,arrayBuffer:async()=>{throw original;}};
 },wait:async ms=>delays.push(ms)}),error=>error===original);
 assert.equal(calls,6);assert.deepEqual(delays,[1000,2000,3000,4000,5000]);
 assert.equal(new Set(signals).size,6);assert.ok(signals.every(signal=>signal instanceof AbortSignal));
});

test('preview failure after an attempted effect is unreconciled, never replayed, and cleanup cannot mask it',async()=>{
 const events=[],original=new DOMException('secret raw URL and token','TimeoutError'),cleanupError=new TypeError('private cleanup output');
 let mutations=0,cleanups=0;
 await assert.rejects(observeRelease(async({stage,bindCandidate,deferCleanup})=>{
  bindCandidate(sha);deferCleanup(()=>{cleanups++;throw cleanupError;});
  await stage('preview-deploy-verify',()=>{mutations++;throw original;});
 },options(events)),error=>error===original);
 assert.equal(mutations,1);assert.equal(cleanups,1);
 const terminal=events.at(-1);assert.equal(terminal.phase,'preview-deploy-verify');
 assert.equal(terminal.errorClass,'TimeoutError');assert.equal(terminal.cleanupErrorClass,'TypeError');
 assert.deepEqual(terminal.effects,{preview:'attempted-unreconciled',production:'not-attempted'});
 assert.equal(terminal.cleanup,'attempted-unreconciled');
 assert.equal(JSON.stringify(events).includes('secret'),false);assert.equal(JSON.stringify(events).includes('private'),false);
});

test('production timeout keeps accepted preview evidence and an unreconciled production effect',async()=>{
 const events=[],original=new DOMException('timeout','TimeoutError');let calls=0;
 await assert.rejects(observeRelease(async({stage,bindCandidate,deferCleanup})=>{
  bindCandidate(sha);deferCleanup(()=>{});
  await stage('preview-deploy-verify',()=>receipt('preview'));
  await stage('production-deploy-verify',()=>{calls++;throw original;});
 },options(events)),error=>error===original);
 assert.equal(calls,1);assert.deepEqual(events.at(-1).effects,{preview:'publicly-verified',production:'attempted-unreconciled'});
 assert.equal(events.at(-1).phase,'production-deploy-verify');assert.equal(events.at(-1).cleanup,'completed');
});

test('cleanup-only failure preserves successful publication evidence without claiming whole-run success',async()=>{
 const events=[],original=new Error('cleanup failed');
 await assert.rejects(observeRelease(async({stage,bindCandidate,deferCleanup})=>{
  bindCandidate(sha);deferCleanup(()=>{throw original;});
  await stage('production-deploy-verify',()=>receipt('release'));
 },options(events)),error=>error===original);
 assert.equal(events.at(-1).phase,'preview-cleanup');assert.equal(events.at(-1).status,'failed');
 assert.equal(events.at(-1).effects.production,'publicly-verified');
});


test('caught failed receipt stage cannot be laundered into terminal release success',async()=>{
 const events=[];let deployments=0,cleanups=0;
 await assert.rejects(observeRelease(async({stage,bindCandidate,deferCleanup})=>{
  bindCandidate(sha);deferCleanup(()=>{cleanups++;throw new TypeError('cleanup after refused receipt');});
  const invalid=receipt('preview');invalid.probe.accepted=false;
  try{await stage('preview-deploy-verify',()=>{deployments++;return invalid;});}
  catch(error){assert.match(error.message,/no exact accepted public receipt/);}
  return {publiclyVerified:true};
 },options(events)),{message:'Release phase returned no exact accepted public receipt'});
 assert.equal(deployments,1);assert.equal(cleanups,1);
 assert.equal(events.at(-1).cleanup,'attempted-unreconciled');
 assert.equal(events.at(-1).cleanupErrorClass,'TypeError');
 assert.equal(events.at(-1).phase,'preview-deploy-verify');
 assert.equal(events.at(-1).status,'failed');
 assert.equal(events.at(-1).effects.preview,'attempted-unreconciled');
});

test('a caught failed phase refuses any later deployment, retaining the first failure',async()=>{
 const events=[];let laterDeployments=0,cleanups=0;
 await assert.rejects(observeRelease(async({stage,bindCandidate,deferCleanup})=>{
  bindCandidate(sha);deferCleanup(()=>{cleanups++;});
  const invalid=receipt('preview');invalid.probe.accepted=false;
  try{await stage('preview-deploy-verify',()=>invalid);}catch{}
  try{await stage('production-deploy-verify',()=>{laterDeployments++;return receipt('production');});}
  catch(error){assert.match(error.message,/failed release phase|already attempted/);}
  return {publiclyVerified:true};
 },options(events)),{message:'Release phase returned no exact accepted public receipt'});
 assert.equal(laterDeployments,0,'a failed phase cannot be followed by another deployment effect');
 assert.equal(cleanups,1);
 assert.deepEqual(events.at(-1).effects,{preview:'attempted-unreconciled',production:'not-attempted'});
 assert.equal(events.at(-1).phase,'preview-deploy-verify');
});

test('an already verified deployment phase cannot execute a second time',async()=>{
 const events=[];let mutations=0;let caught=false;
 await assert.rejects(observeRelease(async({stage,bindCandidate})=>{
  bindCandidate(sha);
  await stage('production-deploy-verify',()=>{mutations++;return receipt('production');});
  try{await stage('production-deploy-verify',()=>{mutations++;return receipt('production');});}
  catch(error){caught=true;assert.match(error.message,/already attempted/);}
  return {publiclyVerified:true};
 },options(events)),/already attempted/);
 assert.equal(caught,true);
 assert.equal(mutations,1,'a duplicate stage must refuse before another provider call');
 assert.equal(events.at(-1).status,'failed');
 assert.equal(events.at(-1).effects.production,'publicly-verified');
});

test('caught undefined thrown from a stage remains a terminal failure',async()=>{
 const events=[];let caught=false;
 try{await observeRelease(async({stage})=>{
  try{await stage('baseline-read',()=>{throw undefined;});}catch(error){assert.equal(error,undefined);}
  return {publiclyVerified:true};
 },options(events));}
 catch(error){caught=true;assert.equal(error,undefined);}
 assert.equal(caught,true);
 assert.equal(events.at(-1).status,'failed');
 assert.equal(events.at(-1).phase,'baseline-read');
});

for(const phase of ['preview','production'])for(const change of ['missing','mismatched','mismatched-receipt-candidate','mismatched-probe-candidate','unaccepted','wrong-kind','unbound'])
 test(`${phase} ${change} receipt refuses release success and preserves unresolved effect custody`,async()=>{
  const events=[];let executions=0,cleanups=0;
  await assert.rejects(observeRelease(async({stage,bindCandidate,deferCleanup})=>{
   if(change!=='unbound')bindCandidate(sha);
   deferCleanup(()=>{cleanups++;});
   const value=receipt(phase);
   if(change==='mismatched')value.probe.manifestSha256='c'.repeat(64);
   if(change==='mismatched-receipt-candidate')value.candidateManifestSha256='d'.repeat(64);
   if(change==='mismatched-probe-candidate')value.probe.candidateManifestSha256='d'.repeat(64);
   if(change==='unaccepted')value.probe.accepted=false;
   if(change==='wrong-kind')value.kind='unrecognized-provider-reply';
   await stage(phase+'-deploy-verify',()=>{executions++;return change==='missing'?undefined:value;});
  },options(events)),{message:'Release phase returned no exact accepted public receipt'});
  assert.equal(executions,1,'effect may not be replayed after an ambiguous provider result');
  assert.equal(cleanups,1,'the original cleanup path remains available');
  assert.equal(events.at(-1).status,'failed');
  assert.equal(events.at(-1).phase,phase+'-deploy-verify');
  assert.equal(events.at(-1).effects[phase],'attempted-unreconciled');
  assert.equal(events.at(-1).cleanup,'completed');
  assert.equal(events.some(row=>row.status==='completed'&&row.phase===phase+'-deploy-verify'),false);
 });

for(const phase of ['preview','production'])test(`exact accepted ${phase} receipt still qualifies release phase`,async()=>{
 const events=[];
 await observeRelease(async({stage,bindCandidate})=>{
  bindCandidate(sha);
  return stage(phase+'-deploy-verify',()=>receipt(phase));
 },options(events));
 assert.equal(events.at(-1).status,'completed');
 assert.equal(events.at(-1).effects[phase],'publicly-verified');
 assert.equal(events.at(-1).phase,'complete');
});

test('untrusted diagnostic identifiers and exception names never enter the fixed projection',async()=>{
 const events=[],original={name:'secret-value',message:'private-value'};
 await assert.rejects(observeRelease(async({stage,bindCandidate})=>{
  bindCandidate(sha+'\n');await stage('baseline-read',()=>{throw original;});
 },{...options(events),revision:revision+'\n',runId:'secret',runAttempt:'1\n'}),error=>error===original);
 const row=events.at(-1);assert.equal(row.revision,null);assert.equal(row.runId,null);assert.equal(row.runAttempt,null);
 assert.equal(row.candidateManifestSha256,null);assert.equal(row.errorClass,'Error');
 assert.equal(JSON.stringify(events).includes('secret'),false);assert.equal(JSON.stringify(events).includes('private'),false);
});

test('reporting failure and thrown undefined do not convert operation failure into success',async()=>{
 let rejected=false;
 try{await observeRelease(async({stage})=>stage('baseline-read',()=>{throw undefined;}),{emit:()=>{throw new Error('unavailable log');}});}
 catch(error){rejected=true;assert.equal(error,undefined);}
 assert.equal(rejected,true);
});


test('throwing name accessors cannot replace the original failure or prevent cleanup',async()=>{
 const events=[],original={},cleanupFailure={};let cleaned=0;
 Object.defineProperty(original,'name',{get(){throw new Error('private accessor failure');}});
 Object.defineProperty(cleanupFailure,'name',{get(){throw new Error('private cleanup accessor failure');}});
 await assert.rejects(observeRelease(async({stage,deferCleanup})=>{
  deferCleanup(()=>{cleaned++;throw cleanupFailure;});
  await stage('preview-deploy-verify',()=>{throw original;});
 },options(events)),error=>error===original);
 assert.equal(cleaned,1);assert.equal(events.at(-1).phase,'preview-deploy-verify');
 assert.equal(events.at(-1).errorClass,'Error');assert.equal(events.at(-1).cleanupErrorClass,'Error');
 assert.equal(JSON.stringify(events).includes('private'),false);
});

test('alternating exception-name accessor is read once per diagnostic classification',async()=>{
 const events=[],original={};let reads=0;
 Object.defineProperty(original,'name',{get(){return ++reads%2===1?'TypeError':'SECRET_UNTRUSTED_NAME';}});
 await assert.rejects(observeRelease(async({stage})=>stage('baseline-read',()=>{throw original;}),options(events)),error=>error===original);
 assert.equal(reads,2);assert.equal(events.find(row=>row.status==='failed').errorClass,'TypeError');
 assert.equal(events.at(-1).errorClass,'Error');assert.equal(JSON.stringify(events).includes('SECRET'),false);
});
