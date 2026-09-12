import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const scripts=['A','B'].map(id=>({id,title:`腳本 ${id}`,tableId:'t',larkUrl:'https://fixture.test/base/app?table=t',bindings:[{recordId:id,tableId:'t',number:id,text:`TC ${id}`,sub:''}],steps:[{action:'screenshot',tcId:id}]}));
 let current=null,hold=false,stopped=false;const calls=[];
 await page.addInitScript(()=>{window.EventSource=class extends EventTarget{close(){}}});
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url());let data={ok:true};
  if(url.pathname.endsWith('/recorded-scripts'))data.scripts=scripts;
  else if(url.pathname.endsWith('/agents'))data.agents=[];
  else if(url.pathname.endsWith('/backend-credentials'))data.credentials=[];
  else if(url.pathname.endsWith('/tc-list')||url.pathname.endsWith('/custom-tcs'))data.tcs=[];
  else if(url.pathname.endsWith('/run')){const body=req.postDataJSON();calls.push(body);current={id:body.recordedScriptId,sessionId:'run-'+calls.length,dryRun:body.dryRun};stopped=false;data.sessionId=current.sessionId;}
  else if(url.pathname.endsWith('/stop')){stopped=true;}
  else if(url.pathname.endsWith('/status'))data={status:!current?'idle':hold&&!stopped?'running':'done',sessionId:current?.sessionId};
  else if(url.pathname.endsWith('/results')) data.runs=current?[{runId:'old',results:[]},{runId:current.sessionId,stopped,results:[{recordId:current.id,task:`TC ${current.id}`,outcome:current.id==='B'?'fail':'pass',assertions:1,allShotPaths:[],notes:'fixture',published:!current.dryRun}]}]:[];
  await route.fulfill({json:data});
 });
 await page.goto('http://127.0.0.1:5199/scripts/ui-checks/uat-status-fixture.html');
 await page.getByRole('checkbox',{name:'執行 腳本 A',exact:true}).check();
 await page.getByRole('checkbox',{name:'執行 腳本 B',exact:true}).check();
 await page.getByRole('button',{name:'腳本 B優先',exact:true}).click();
 assert.match(await page.locator('.uat-script-order li').first().innerText(),/腳本 B/);
 await page.getByRole('button',{name:'試跑選取腳本',exact:true}).click();
 await page.getByText('2. 腳本 A · 已完成',{exact:true}).waitFor();
 assert.deepEqual(calls.map(x=>x.recordedScriptId),['B','A']);assert.ok(calls.every(x=>x.dryRun));
 await page.getByRole('button',{name:'正式執行選取腳本',exact:true}).click();assert.equal(calls.length,2);
 await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(calls.length,2);
 await page.getByRole('button',{name:'正式執行選取腳本',exact:true}).click();
 await page.getByRole('button',{name:'確認執行佇列',exact:true}).click();
 await page.getByText('2. 腳本 A · 已完成',{exact:true}).waitFor();
 assert.equal(calls.length,4);assert.ok(calls.slice(2).every(x=>x.dryRun===false));
 await page.screenshot({path:'C:/Users/user/AppData/Local/Temp/script-batch-results.png'});
 hold=true;
 await page.getByRole('button',{name:'試跑選取腳本',exact:true}).click();
 await page.getByText('1. 腳本 B · 執行中',{exact:true}).waitFor();
 await page.getByRole('button',{name:'停止整個佇列',exact:true}).click();
 await page.getByText('2. 腳本 A · 已停止／取消',{exact:true}).waitFor();
 assert.equal(calls.length,5);
 assert.deepEqual(errors,[]);
 console.log('PASS UI multi-select, reorder, real queue wiring, exact results, formal confirmation and cancel pending scripts');
}finally{await browser.close()}
