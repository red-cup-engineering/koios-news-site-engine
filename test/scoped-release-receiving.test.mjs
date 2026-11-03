import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {observeRelease} from '../src/release-observation.mjs';
import {executeObservedAuthorized,verifyBinding,TARGET,WRANGLER} from '../src/carrier.mjs';
import {fileURLToPath} from 'node:url';
import {receiveWebsiteRelease} from '../src/release.mjs';

test('lost pending custody after provider work prevents later phases, diagnostics and cleanup',async()=>{
 const lost=new Error('original pending reservation lost');let bound=true,cleanups=0,diagnostics=0,next=0;
 await assert.rejects(observeRelease(async({stage,deferCleanup})=>{
  deferCleanup(()=>{cleanups++;});
  await stage('preview-deploy-verify',()=>{bound=false;return {};});
  await stage('production-deploy-verify',()=>{next++;});
 },{emit:()=>{},checkpoint:async()=>{if(!bound)throw lost;},diagnose:()=>{diagnostics++;}}),error=>error===lost);
 assert.equal(cleanups,0);assert.equal(diagnostics,0);assert.equal(next,0);
});

test('loss after initial provider readback cannot consume authority or deploy',async t=>{
 const root=mkdtempSync(join(tmpdir(),'scoped-site-authority-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const manifestSha256='a'.repeat(64),worker='koios-news-primary-preview-'+manifestSha256.slice(0,12),calls=[];
 const plan={phase:'preview',disposition:'preview-authorized',candidate:{manifestSha256},commands:[{program:WRANGLER,args:['deploy','--name',worker,'--assets','/original/candidate']}]};
 const environment={CLOUDFLARE_ACCOUNT_ID:'337e54ee6dc7d488933f473204a6d89e',CLOUDFLARE_API_TOKEN:'fixture-account'};
 const lost=new Error('state changed after readback');let bound=true;
 await assert.rejects(executeObservedAuthorized({phase:'preview',plan,receiptOut:join(root,'preview.json'),replayRoot:join(root,'authority'),environment,
  checkpoint:async()=>{if(!bound)throw lost;},executor:(_program,args,options)=>{
   assert.deepEqual(options.environment,environment);calls.push(args);bound=false;return {status:0,stdout:'[]',stderr:''};
  }}),error=>error===lost);
 assert.equal(calls.length,1);assert.equal(existsSync(join(root,'authority')),false);assert.equal(existsSync(join(root,'preview.json')),false);
});

test('website receiving rereads its original immutable exact-public-byte receipt',async t=>{
 const root=mkdtempSync(join(tmpdir(),'scoped-site-receiving-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const candidateDir=join(root,'public'),receipts=join(root,'receipts');mkdirSync(candidateDir);mkdirSync(receipts);
 const html=Buffer.from('original public bytes');writeFileSync(join(candidateDir,'index.html'),html);
 const bytes=Buffer.from(JSON.stringify({kind:'news-property.build-manifest/v1',provenance:{origin:'https://koios.news'},artifacts:[{file:'index.html',sha256:createHash('sha256').update(html).digest('hex'),bytes:html.length}]})+'\n'),digest=createHash('sha256').update(bytes).digest('hex');
 writeFileSync(join(candidateDir,'manifest.json'),bytes);
 const receipt=join(receipts,'already-live-audit.json');writeFileSync(receipt,JSON.stringify({kind:'koios.news.cloudflare-production-observation-receipt/v1',candidateManifestSha256:digest,binding:TARGET,
  bindingSha256:verifyBinding(fileURLToPath(new URL('../release/koios-news-primary-binding.json',import.meta.url))).digest,
  probe:{accepted:true,candidateManifestSha256:digest,manifestSha256:digest}}));
 const result={publiclyVerified:true,alreadyLive:true,manifestSha256:digest,receipt};let checks=0;
 assert.equal(await receiveWebsiteRelease(result,{candidateDir,receipts,checkpoint:async()=>{checks++;}}),result);
 assert.ok(checks>=2);
 writeFileSync(join(candidateDir,'index.html'),'replacement');
 await assert.rejects(receiveWebsiteRelease(result,{candidateDir,receipts,checkpoint:async()=>{}}),/digest does not match/u);
});
