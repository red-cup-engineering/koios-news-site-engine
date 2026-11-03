import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {isAbsolute,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditProduction,planSelfAuthorized,executeObservedAuthorized,acceptPreviewProbe,observeProductionVersionScoped,verifyBinding,verifyCandidate,TARGET,WRANGLER,runPinnedWrangler,runPinnedWranglerScoped} from './carrier.mjs';
import {observeRelease,readPublicBaseline} from './release-observation.mjs';
import {retainReleaseFailure} from './release-diagnostics.mjs';

/** Publish this website's immutable build through its existing preview and
 * rollback controls. The newsroom supplies inputs; the website owns delivery. */
export async function releaseWebsite({candidateDir,receipts,environment=process.env,revision=environment.GITHUB_SHA,
 checkpoint=async()=>{},stagingRoot,emit,fetchImpl=fetch,executor}={}) {
 if(!environment||typeof checkpoint!=='function'||typeof fetchImpl!=='function')throw new TypeError('Website release requires selected environment and execution capabilities');
 environment=Object.freeze({...environment});
 const run=executor??(stagingRoot===undefined?runPinnedWrangler:runPinnedWranglerScoped);
 const scopedFetch=async(...args)=>{await checkpoint();const response=await fetchImpl(...args);await checkpoint();return response;};
 await checkpoint();
 candidateDir=resolve(candidateDir);receipts=resolve(receipts);
 mkdirSync(receipts,{recursive:true});
 const bindingPath=fileURLToPath(new URL('../release/koios-news-primary-binding.json',import.meta.url));
 const result=await observeRelease(async({stage,bindCandidate,deferCleanup})=>{
  const prior=await stage('baseline-read',async()=>{
   const bytes=await readPublicBaseline({fetchImpl:scopedFetch,checkpoint});await checkpoint();writeFileSync(join(receipts,'baseline.json'),bytes);return bytes;
  });
  const manifest=await stage('candidate-read',()=>readFileSync(join(candidateDir,'manifest.json')));
  const manifestSha256=createHash('sha256').update(manifest).digest('hex');
  bindCandidate(manifestSha256);
  if(manifest.equals(prior)){
   const audit=await stage('already-live-audit',()=>auditProduction({candidateDir,bindingPath,receiptOut:join(receipts,'already-live-audit.json'),fetchImpl:scopedFetch,checkpoint}));
   return {commit:revision,manifestSha256:audit.candidateManifestSha256,publiclyVerified:true,alreadyLive:true,receipt:audit.receiptPath};
  }
  const preview=await stage('preview-plan',()=>{
   const before=JSON.parse(prior),after=JSON.parse(manifest);
   const routes=new Set(after.artifacts.map(row=>row.file));
   for(const row of before.artifacts)if(/^posts\/[^/]+\/index.html$/.test(row.file)&&!routes.has(row.file))throw new Error(`release would lose public article ${row.file}`);
   return planSelfAuthorized({phase:'preview',candidateDir,bindingPath});
  });
  const worker=`${TARGET.workerName}-preview-${preview.candidate.manifestSha256.slice(0,12)}`;
  const previewUrl=`https://${worker}.561-group.workers.dev/`;
  deferCleanup(async()=>{
   await checkpoint();const result=await run(WRANGLER,['delete','--name',worker,'--force'],{environment,checkpoint,stagingRoot});await checkpoint();
   if(result.status!==0&&!/not found|does not exist|10007|10090/i.test(`${result.stdout}\n${result.stderr}`))throw new Error('preview cleanup failed');
  });
  await stage('preview-deploy-verify',()=>executeObservedAuthorized({phase:'preview',plan:preview,receiptOut:join(receipts,'preview.json'),replayRoot:join(receipts,'authority'),url:previewUrl,environment,executor:run,fetchImpl:scopedFetch,checkpoint,stagingRoot}));
  await stage('preview-probe',()=>acceptPreviewProbe({candidateDir,bindingPath,url:previewUrl,receiptOut:join(receipts,'probe.json'),fetchImpl:scopedFetch,checkpoint}));
  await stage('rollback-binding',async()=>{
   const version=await observeProductionVersionScoped({environment,executor:run,checkpoint,stagingRoot});
   await checkpoint();writeFileSync(join(receipts,'rollback.json'),JSON.stringify({kind:'koios.news.cloudflare-rollback-binding/v1',...TARGET,bindingSha256:verifyBinding(bindingPath).digest,priorVersionId:version.versionId}));
  });
  const release=await stage('release-plan',()=>planSelfAuthorized({phase:'release',candidateDir,bindingPath,rollbackPath:join(receipts,'rollback.json'),previewReceiptPath:join(receipts,'probe.json'),productionBaselinePath:join(receipts,'baseline.json')}));
  const received=await stage('production-deploy-verify',()=>executeObservedAuthorized({phase:'release',plan:release,receiptOut:join(receipts,'release.json'),replayRoot:join(receipts,'authority'),url:'https://koios.news/',environment,executor:run,fetchImpl:scopedFetch,checkpoint,stagingRoot}));
  return {commit:revision,manifestSha256,publiclyVerified:true,receipt:received.receiptPath};
 },{revision,runId:environment.GITHUB_RUN_ID,runAttempt:environment.GITHUB_RUN_ATTEMPT,emit,checkpoint,diagnose:async(error,{phase,candidateManifestSha256})=>{
   await checkpoint();
   const diagnosticPath=error?.diagnosticPath??retainReleaseFailure({error,phase,
    receiptOut:join(receipts,phase),environment,attributes:candidateManifestSha256?{'koios.release.candidate.sha256':candidateManifestSha256}:{}});
   if(error&&typeof error==='object')error.diagnosticPath=diagnosticPath;
   return diagnosticPath;
 }});
 return receiveWebsiteRelease(result,{candidateDir,receipts,checkpoint});
}

/** Read the original immutable receiving carrier, without invoking a provider. */
export async function receiveWebsiteRelease(result,{candidateDir,receipts,checkpoint}={}) {
 if(typeof checkpoint!=='function')throw new TypeError('Website receiving needs original active custody');
 await checkpoint();
 const path=join(resolve(receipts),result?.alreadyLive?'already-live-audit.json':'release.json');
 if(result?.receipt!==path||result.publiclyVerified!==true)throw new TypeError('Website result does not name its original received carrier');
 const receipt=JSON.parse(readFileSync(path,'utf8')),manifestSha256=verifyCandidate(candidateDir).manifestDigest;
 const binding=verifyBinding(fileURLToPath(new URL('../release/koios-news-primary-binding.json',import.meta.url)));
 const expectedKind=result.alreadyLive?'koios.news.cloudflare-production-observation-receipt/v1':'koios.news.cloudflare-release-receipt/v1';
 if(receipt.kind!==expectedKind||receipt.bindingSha256!==binding.digest||Object.entries(TARGET).some(([key,value])=>receipt.binding?.[key]!==value)
  ||receipt.candidateManifestSha256!==manifestSha256||result.manifestSha256!==manifestSha256||receipt.probe?.accepted!==true
  ||receipt.probe.candidateManifestSha256!==manifestSha256||receipt.probe.manifestSha256!==manifestSha256)
  throw new Error('Original website receipt did not receive the exact public candidate');
 await checkpoint();return result;
}

export function releaseWebsiteScoped(options) {
 if(!options?.environment||typeof options.environment!=='object'||Array.isArray(options.environment)||typeof options?.checkpoint!=='function'
  ||typeof options?.stagingRoot!=='string'||!isAbsolute(options.stagingRoot))throw new TypeError('Scoped website release needs original environment, owner staging and active custody');
 return releaseWebsite(options);
}
