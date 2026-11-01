import { otlpLogRecord } from '@red-cup-engineering/signcell/observability';
import { channel, message, packet, packetToOtlpLogs } from '@red-cup-engineering/signcell/signal';

// The website supplies observed events; SignCell owns their common representation.
// This observer cannot authorize or retry an effect.
const releaseChannel=channel({name:'koios.website.release',resource:{'service.name':'koios.news.website'}});
export function releaseLogPacket(record,{observedAt,causes=[]}){
 const said=message({channel:releaseChannel,observedAt,causes,body:record});
 return {message:said,logs:packetToOtlpLogs(packet({channel:releaseChannel,messages:[said]}),
  {channel:releaseChannel,scopeName:'@causeway-services/koios-news-site/release'})};
}
const present=value=>Array.isArray(value)?value.map(present):value&&typeof value==='object'
 ?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==null&&v!==undefined).map(([k,v])=>[k,present(v)])):value;
function releaseEmitter(){
 let prior;
 return value=>{
  const observedAt=new Date().toISOString(),failed=value.status==='failed';
  const record=otlpLogRecord({observedAt,severityNumber:failed?17:9,severityText:failed?'ERROR':'INFO',
   eventName:'koios.website.release.phase',body:present(value)});
  const emitted=releaseLogPacket(record,{observedAt,causes:prior?[prior]:[]});
  console.error(JSON.stringify(emitted.logs));prior=emitted.message.id;
 };
}
const PHASES=new Set(['baseline-read','candidate-read','already-live-audit','preview-plan',
 'preview-deploy-verify','preview-probe','rollback-binding','release-plan',
 'production-deploy-verify','preview-cleanup']);
const EFFECTS={
 'preview-deploy-verify':['preview','koios.news.cloudflare-preview-deployment-receipt/v1'],
 'production-deploy-verify':['production','koios.news.cloudflare-release-receipt/v1'],
};
const identity=(value,pattern)=>typeof value==='string'&&!/\s/u.test(value)&&pattern.test(value)?value:null;
const errorClass=error=>{
 // A thrown value can have an accessor or Proxy trap. Read once, under guard.
 try{const name=error?.name;return ['Error','TypeError','RangeError','SyntaxError','AbortError','TimeoutError'].includes(name)?name:'Error';}
 catch{return 'Error';}
};

/** Keep body consumption in the same six-attempt, 20-second read budget as headers.
 * No provider command, admission change or deployment retry belongs in this helper. */
export async function readPublicBaseline({fetchImpl=fetch,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 for(let attempt=0;attempt<6;attempt++){
  try{
   const response=await fetchImpl('https://koios.news/manifest.json',{
    headers:{'cache-control':'no-cache'},signal:AbortSignal.timeout(20000),
   });
   if(!response.ok)throw new Error(`live baseline returned ${response.status}`);
   return Buffer.from(await response.arrayBuffer());
  }catch(error){
   if(attempt===5)throw error;
   await wait(1000*(attempt+1));
  }
 }
}

/** A failed mutation-capable call stays unreconciled even if it changed a provider.
 * Only a returned accepted receipt advances its effect witness. Cleanup failure
 * never replaces the original exception; both fixed classes appear in the report. */
export async function observeRelease(operation,{emit,
 diagnose,revision=process.env.GITHUB_SHA,runId=process.env.GITHUB_RUN_ID,runAttempt=process.env.GITHUB_RUN_ATTEMPT}={}){
 const binding={revision:identity(revision,/^[a-f0-9]{40}$/u),
  runId:identity(runId,/^[1-9][0-9]{0,19}$/u),runAttempt:identity(runAttempt,/^[1-9][0-9]{0,7}$/u)};
 emit??=releaseEmitter();
 const effects={preview:'not-attempted',production:'not-attempted'};
 let candidateManifestSha256=null,phase=null,failedPhase=null,stageFailed=false,firstStageFailure,cleanup,cleanupStatus='not-attempted';
 const report=(status,extra={})=>{
  // Diagnostics must not replace the work's original result or exception.
  try{emit({kind:'koios.website-release-progress/v1',...binding,candidateManifestSha256,
   phase,status,effects:{...effects},cleanup:cleanupStatus,...extra});}catch{}
 };
 const bindCandidate=digest=>{
  const candidate=identity(digest,/^[a-f0-9]{64}$/u);
  // Reasserting the same identity is idempotent; changing or invalidating it
  // poisons this release even if the caller catches the exception.
  if(!stageFailed&&candidate!==null
   &&(candidateManifestSha256===null||candidateManifestSha256===candidate)){
   candidateManifestSha256=candidate;return;
  }
  const error=new Error(stageFailed
   ?'Cannot bind candidate after failed release phase; reconcile first'
   :'Release candidate binding invalid or changed; reconcile first');
  if(!stageFailed){stageFailed=true;firstStageFailure=error;failedPhase='candidate-read';phase='candidate-read';}
  report('failed',{errorClass:errorClass(error)});
  throw error;
 };
 const stage=async(name,work)=>{
  if(!PHASES.has(name)||typeof work!=='function')throw new Error('Unknown release observation phase');
  phase=name;
  const effect=EFFECTS[name];
  // Failed stages cannot be hidden by callers or followed by another effect.
  // An attempted provider mutation cannot be replayed within this release.
  const blocked=stageFailed&&name!=='preview-cleanup';
  const repeated=!!effect&&effects[effect[0]]!=='not-attempted';
  if(effect&&!blocked&&!repeated)effects[effect[0]]='attempted-unreconciled';
  if(name==='preview-cleanup')cleanupStatus='attempted-unreconciled';
  if(!blocked&&!repeated)report('started');
  try{
   if(blocked)throw new Error('Cannot continue after failed release phase; reconcile first');
   if(repeated)throw new Error('Release effect already attempted; reconcile before replay');
   const result=await work();
   if(effect){
    // A provider call may have mutated Cloudflare without returning an exact
    // public receipt. Refuse success, preserve attempted-unreconciled custody,
    // and let the caller's original cleanup path run without retrying the effect.
    const verified=result?.kind===effect[1]&&result?.probe?.accepted===true
     &&candidateManifestSha256!==null&&result.candidateManifestSha256===candidateManifestSha256
     &&result.probe.candidateManifestSha256===candidateManifestSha256
     &&result.probe.manifestSha256===candidateManifestSha256;
    if(!verified)throw new Error('Release phase returned no exact accepted public receipt');
    effects[effect[0]]='publicly-verified';
   }
   if(name==='preview-cleanup')cleanupStatus='completed';
   report('completed');return result;
  }catch(error){
   // Preserve the first stage failure, including a thrown undefined value;
   // cleanup or a caught exception cannot turn the attempt into success.
   if(!stageFailed){stageFailed=true;firstStageFailure=error;failedPhase=name;}
   let diagnosticPath;
   try{diagnosticPath=diagnose?.(error,{phase:name,candidateManifestSha256});}catch{}
   report('failed',{errorClass:errorClass(error),...(diagnosticPath?{diagnosticPath}:{})});throw error;
  }
 };
 let result,failure,originalPhase,cleanupFailure,failed=false,cleanupFailed=false;
 try{
  result=await operation({stage,bindCandidate,
   deferCleanup:work=>{
    if(cleanup||typeof work!=='function')throw new Error('Release cleanup already assigned');
    cleanup=work;
   },
  });
 }catch(error){
  // A later blocked stage must not overwrite a caught earlier refusal.
  failed=true;failure=stageFailed?firstStageFailure:error;originalPhase=failedPhase??phase;
 }
 if(cleanup){
  try{await stage('preview-cleanup',cleanup);}
  catch(error){cleanupFailed=true;cleanupFailure=error;if(!failed){failed=true;failure=firstStageFailure;originalPhase=failedPhase??'preview-cleanup';}}
 }
 if(!failed&&stageFailed){failed=true;failure=firstStageFailure;originalPhase=failedPhase;}
 if(failed){
  phase=originalPhase;
  report('failed',{terminal:true,errorClass:errorClass(failure),
   ...(!cleanupFailed?{}:{cleanupErrorClass:errorClass(cleanupFailure)})});
  throw failure;
 }
 phase='complete';report('completed',{terminal:true});return result;
}
