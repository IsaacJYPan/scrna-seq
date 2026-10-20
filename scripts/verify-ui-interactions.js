#!/usr/bin/env node
'use strict';

// Real pointer paths, keyboard sequences, touch, and recorded transitions.
// Responses are deterministic frontend fixtures; no research data is changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const { prepareVisualPage } = require('./test_visual_ux');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'playwright/report/ui-interactions');
const port = Number(process.env.UI_INTERACTION_PORT || 5183);
const origin = `http://localhost:${port}`;
const checks = [];
const errors = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, condition, detail) {
  checks.push({ name, passed: !!condition, detail });
  assert.ok(condition, `${name}${detail ? ': ' + JSON.stringify(detail) : ''}`);
  console.log('PASS '+name);
}
async function contained(locator, viewport) {
  const rect = await locator.boundingBox();
  return rect && rect.x >= 15 && rect.y >= 15 && rect.x + rect.width <= viewport.width - 15 && rect.y + rect.height <= viewport.height - 15;
}
async function pointerPath(page, from, to) {
  for (let i = 0; i <= 24; i++) {
    await page.mouse.move(from.x + (to.x - from.x)*i/24, from.y + (to.y - from.y)*i/24);
    await pause(15);
  }
}
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(out, name+'.png') });
}
async function saveVideo(context, page, name) {
  const video = page.video();
  await context.close();
  await video.saveAs(path.join(out, name+'.webm'));
}
async function accessible(page, name) {
  const audit = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze();
  const violations = audit.violations.filter(item => ['critical','serious'].includes(item.impact));
  check(name+' accessibility', violations.length===0, violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>node.html).slice(0,4)})));
}

async function workbench(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: out, size: { width: 1440, height: 900 } } });
  const { page, consoleErrors } = await prepareVisualPage(context, { logConsole: false });
  try {
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Add analysis', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Load saved analysis' });
    await dialog.waitFor();
    await page.keyboard.press('Shift+Tab');
    check('Loader retains keyboard focus', await dialog.evaluate(el => el.contains(document.activeElement)));
    await page.keyboard.press('Escape');
    check('Loader Escape returns focus to Add analysis', await page.getByRole('button', { name: 'Add analysis', exact: true }).first().evaluate(el => el === document.activeElement));
    await page.getByRole('button', { name: 'Add analysis', exact: true }).first().click();
    await page.getByRole('button', { name: /PBMC 3k Demo Dataset/ }).click();
    await page.getByText('PBMC_3k_Tutorial', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Object options' }).waitFor();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      for (const width of [1440, 768, 390, 320]) {
        const viewport = { width, height: 900 };
        await page.setViewportSize(viewport);
        const trigger = page.getByRole('button', { name: 'Object options' });
        await trigger.click();
        const action = page.getByRole('button', { name: 'Inspect Data', exact: true });
        // React useId contains colons; getElementById avoids CSS escaping.
        const panelId = await trigger.getAttribute('aria-controls');
        const panel = page.locator(`[id="${panelId}"]`);
        const geometry = await page.evaluate(id => { const r = document.getElementById(id).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; }, panelId);
        check(`${theme} ${width}: menu contained`, geometry.x >= 15 && geometry.y >= 15 && geometry.x+geometry.width <= width-15 && geometry.y+geometry.height <= 885, geometry);
        const a = await trigger.boundingBox(), b = await action.boundingBox();
        check(`${theme} ${width}: touch targets`, a.width >= 44 && a.height >= 44 && b.height >= 44);
        await pointerPath(page, { x:a.x+a.width/2, y:a.y+a.height/2 }, { x:b.x+b.width/2, y:b.y+b.height/2 });
        check(`${theme} ${width}: pointer reaches action`, await action.isVisible());
        await page.mouse.move(1, 1);
        await pause(120);
        check(`${theme} ${width}: moving away preserves click-open menu`, await action.isVisible());
        await trigger.focus(); await page.keyboard.press('Tab');
        check(`${theme} ${width}: Tab enters action`, await action.evaluate(el => el === document.activeElement));
        await page.keyboard.press('Shift+Tab');
        check(`${theme} ${width}: Shift+Tab returns to trigger`, await trigger.evaluate(el => el === document.activeElement));
        await page.keyboard.press('Tab'); await page.keyboard.press('Escape');
        check(`${theme} ${width}: Escape closes and returns focus`, await action.isHidden() && await trigger.evaluate(el => el === document.activeElement));
        await page.keyboard.press('Enter');
        check(`${theme} ${width}: Enter reopens menu`, await action.isVisible());
        await screenshot(page, `menu-${theme}-${width}`);
        await page.mouse.click(4, 4);
        check(`${theme} ${width}: outside press closes menu`, await action.isHidden());
        check(`${theme} ${width}: hidden portal retains controls`, await panel.count() === 1);
      }
    }
    await page.setViewportSize({ width:1440, height:900 });
    const expand = page.getByRole('button', { name:'Expand sidebar', exact:true });
    if (await expand.isVisible()) await expand.click();
    await page.locator('aside button[data-destination="workspace"]').focus();
    await page.setViewportSize({ width:390, height:844 });
    await pause(150);
    check('Breakpoint collapse restores visible navigation focus', await expand.evaluate(el => el === document.activeElement));
    await expand.click();
    const drawer = page.getByRole('dialog', { name:'Workspace navigation' });
    await page.keyboard.press('Shift+Tab');
    check('Phone drawer wraps keyboard focus', await drawer.evaluate(el => el.contains(document.activeElement)));
    await page.keyboard.press('Tab');
    check('Phone drawer forward focus stays inside', await drawer.evaluate(el => el.contains(document.activeElement)));
    await screenshot(page, 'phone-drawer');
    await page.keyboard.press('Escape');
    check('Drawer Escape restores launcher focus', await expand.evaluate(el => el === document.activeElement));
    await expand.click();
    await drawer.getByRole('button', { name:/Data workspace/ }).click();
    check('Selecting a destination closes drawer', await drawer.isHidden());
    const connection = page.getByRole('button', { name:'Connection details', exact:true });
    await connection.click();
    const connectionPanel = page.getByText(/Analysis jobs, recipes, and R commands/).locator('..');
    check('Phone connection details fit viewport', await contained(connectionPanel, page.viewportSize()));
    await screenshot(page, 'phone-connection');
    await page.keyboard.press('Escape');
    await page.emulateMedia({ reducedMotion:'reduce' });
    check('Reduced motion removes button transitions', await connection.evaluate(el => getComputedStyle(el).transitionDuration.split(',').every(value=>parseFloat(value)<=0.01)));
    check('Workbench has no unexpected browser errors', consoleErrors.length === 0, consoleErrors);
  } finally { await saveVideo(context, page, 'workbench-navigation'); }
}

async function demoFixtures(context) {
  const cellCount=2700;
  const baseline = { n_cells:cellCount,
    nFeature_RNA:Array.from({length:cellCount},(_,i)=>800+(i%37)*25),
    nCount_RNA:Array.from({length:cellCount},(_,i)=>1500+(i%73)*40),
    percent_mt:Array.from({length:cellCount},(_,i)=>1+(i%100)/50),
  };
  const pca = { npcs:30, stdevs:Array.from({length:30}, (_,i)=>12/Math.sqrt(i+1)), gene_loadings:{PC1:['LYZ','CD3D']} };
  const points=Array.from({length:cellCount},(_,i)=>{
    const angle=i*2.399963229728653, radius=Math.sqrt((i%1350)/1350)*2;
    return {x:(i<1350?-3:3)+Math.cos(angle)*radius, y:(i<1350?1:-1)+Math.sin(angle)*radius};
  });
  const map = { n_cells:cellCount, n_clusters:2, trace_data:[0,1].map(cluster=>({
    name:`Cluster ${cluster}`,x:points.slice(cluster*1350,(cluster+1)*1350).map(point=>point.x),
    y:points.slice(cluster*1350,(cluster+1)*1350).map(point=>point.y),
  })) };
  const saved = { userId:1, projectId:'demo_ui', currentObjectId:'ao_demo', originalObjectId:'ao_original', stage:'complete', baseline,
    appliedQC:{min_features:200,max_features:2500,mt_threshold:5,min_counts:0}, processing:{scaleFactor:10000,variableFeatures:2000,npcs:30},
    clustering:{dims:10,resolution:0.5,neighbors:30,minDist:0.3}, pca, map };
  await context.addInitScript(value => sessionStorage.setItem('traceomics-analysis-demo-v2', JSON.stringify(value)), saved);
  let failCluster = false;
  let loseSaveReply = false;
  const submitted = [];
  const jobs = new Map();
  const receiptRequests = [];
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), pathname=url.pathname;
    try {
    let body;
    if (pathname === '/api/auth/policy') body={demoMode:true,guidedDemoEnabled:true};
    else if (pathname === '/api/auth/session') body={user:{id:1,email:'ui@demo.invalid'}};
    else if (pathname.endsWith('/jobs') && request.method()==='POST') {
      const input=request.postDataJSON();
      assert.match(input.requestId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
      assert.equal(JSON.parse(await request.frame().evaluate(()=>sessionStorage.getItem('traceomics-analysis-demo-v2'))).pending.requestId,input.requestId);
      const existing=[...jobs.values()].find(job=>job.submission.requestId===input.requestId);
      const id=existing?.id||`job_demo_ui_${jobs.size}`;
      const submission={schema:'traceomics.job-submission.v1',projectId:'demo_ui',requestId:input.requestId,
        requestHash:require('../backend/submissionIdentity').projectSubmissionHash(input),jobId:id,createdAt:new Date().toISOString()};
      if(existing&&existing.submission.requestHash!==submission.requestHash){await route.fulfill({status:409,json:{error:'Submission inputs conflict.'}});return;}
      const job=existing||{id,jobType:input.jobType,analysisObjectId:input.analysisObjectId,status:'completed',attempts:1,
        resultAnalysisObjectId:'ao_saved',submission};
      jobs.set(id,job); body={job};
      if(loseSaveReply&&input.jobType==='checkpoint.save.v1'){
        loseSaveReply=false;
        // Admission succeeded, but the client cannot parse its acknowledgment.
        // It must resolve the retained UUID through GET instead of replaying POST.
        await route.fulfill({status:201,contentType:'application/json',body:'{"job":'});return;
      }
    }
    else if (pathname.includes('/job-submissions/')) {
      const requestId=pathname.split('/').at(-1);receiptRequests.push(requestId);
      const job=[...jobs.values()].find(value=>value.submission.requestId===requestId);
      if(!job){await route.fulfill({status:404,json:{error:'Submission receipt not found.'}});return;}
      body={...job.submission,job:{id:job.id,jobType:job.jobType,analysisObjectId:job.analysisObjectId,status:job.status,attempts:job.attempts}};
    }
    else if (pathname.includes('/jobs/')) {
      const job=jobs.get(pathname.split('/').at(-1));
      if(!job){await route.fulfill({status:404,json:{error:'Job not found.'}});return;}
      body={job};
    }
    else if (pathname.endsWith('/object-info')) body={n_cells:cellCount,n_features:13714};
    else if (pathname.endsWith('/qc-distributions')) body=baseline;
    else if (pathname.endsWith('/pca')) { await pause(500); body={result:pca}; }
    else if (pathname.endsWith('/umap')) { await pause(500); body={result:map}; }
    else if (pathname.endsWith('/cluster')) {
      submitted.push(Object.fromEntries(url.searchParams));
      if(failCluster){failCluster=false;await route.fulfill({status:503,json:{error:'The server is busy. Please retry.'}});return;}
      await pause(350); body={result:{n_clusters:2}};
    } else if (pathname.endsWith('/qc')) body={result:{post_filter_cells:cellCount}};
    else if (pathname.endsWith('/normalize')) body={result:{success:true}};
    else if (pathname.endsWith('/feature-values')) {await pause(250);body={
      expression:Array.from({length:cellCount},(_,i)=>[0,0,1,2,3,4][i%6]),u1:points.map(point=>point.x),u2:points.map(point=>point.y),
    };}
    else {
      errors.push('Unexpected demo endpoint '+pathname);
      await route.fulfill({status:500,json:{error:'Unexpected fixture endpoint.'}});return;
    }
    await route.fulfill({status:200,json:body});
    } catch(error) {
      errors.push(`Demo fixture ${pathname}: ${error.message}`);
      await route.fulfill({status:500,json:{error:'The demo fixture could not complete its response.'}}).catch(()=>{});
    }
  });
  return { submitted,cellCount,jobs,receiptRequests,failNextCluster:()=>{failCluster=true;},loseNextSaveReply:()=>{loseSaveReply=true;} };
}

async function touchWorkbench(browser) {
  const viewport={width:390,height:844};
  const context=await browser.newContext({viewport,hasTouch:true,isMobile:true,recordVideo:{dir:out,size:viewport}});
  const {page}=await prepareVisualPage(context,{logConsole:false});
  try {
    await page.goto(origin);
    await page.getByRole('button',{name:'Add analysis',exact:true}).first().tap();
    await page.getByRole('button',{name:/PBMC 3k Demo Dataset/}).tap();
    const trigger=page.getByRole('button',{name:'Object options'});
    await trigger.tap();
    const action=page.getByRole('button',{name:'Inspect Data',exact:true});
    check('Touch opens saved-analysis menu',await action.isVisible());
    await page.touchscreen.tap(4,4);
    check('Touch outside dismisses saved-analysis menu',await action.isHidden());
    await trigger.tap(); await action.tap();
    await page.waitForFunction(()=>document.querySelector('[data-destination="inspect"]')?.getAttribute('aria-current')==='page');
    check('Touch activates saved-analysis action',await action.isHidden());
    await screenshot(page,'workbench-touch-inspect');
  } finally {await saveVideo(context,page,'workbench-touch');}
}

async function demo(browser, mobile) {
  const viewport = mobile ? {width:390,height:844} : {width:1440,height:900};
  const name=mobile?'demo-touch':'demo-desktop';
  const context=await browser.newContext({viewport,hasTouch:mobile,isMobile:mobile,acceptDownloads:true,recordVideo:{dir:out,size:viewport}});
  const fixture=await demoFixtures(context);
  const page=await context.newPage();
  const activate=locator=>mobile?locator.tap():locator.click();
  page.on('pageerror',error=>errors.push(error.message));
  try {
    await page.goto(origin);
    await page.getByRole('heading',{name:'PBMC3k analysis'}).waitFor();
    await page.waitForFunction(()=>document.querySelector('.js-plotly-plot')?.data?.length>0);
    await accessible(page,name+' entry');
    const resolution=page.getByLabel('Clustering resolution');
    await resolution.fill(''); await resolution.pressSequentially('0.',{delay:100});
    check(`${name}: incomplete decimal remains editable`, await resolution.inputValue()==='0.');
    await resolution.pressSequentially('8',{delay:100});
    check(`${name}: decimal typed continuously`, await resolution.inputValue()==='0.8');
    const distance=page.getByLabel('UMAP minimum distance');
    await distance.fill('');
    check(`${name}: blank input blocks analysis`, await page.getByRole('button',{name:'Run clustering & UMAP'}).isDisabled());
    await distance.pressSequentially('0.4',{delay:70});
    fixture.failNextCluster();
    await page.getByRole('button',{name:'Run clustering & UMAP'}).click();
    await page.getByRole('alert').waitFor();
    check(`${name}: failure preserves embedding`, await page.locator('.scatterlayer .point').count()===fixture.cellCount);
    await screenshot(page,name+'-error');
    fixture.loseNextSaveReply();
    await page.getByRole('button',{name:'Run clustering & UMAP'}).click();
    check(`${name}: busy state blocks duplicate work`, await page.getByRole('button',{name:'Run clustering & UMAP'}).isDisabled());
    await screenshot(page,name+'-busy');
    await page.getByText('Clustering complete: 2 clusters.',{exact:true}).waitFor();
    await page.waitForFunction(()=>!document.querySelector('.demo-reset').disabled);
    check(`${name}: typed decimal reaches request`, fixture.submitted.at(-1).resolution==='0.8');
    const saves=[...fixture.jobs.values()].filter(job=>job.jobType==='checkpoint.save.v1');
    check(`${name}: lost save acknowledgment recovers its exact UUID without another computation`, saves.length===1
      && fixture.receiptRequests.includes(saves[0].submission.requestId) && fixture.submitted.length===2 && saves[0].attempts===1);
    const cluster=page.getByRole('tab',{name:/Clustering/}), pca=page.getByRole('tab',{name:/Normalization/});
    await cluster.focus(); await page.keyboard.press('ArrowLeft');
    check(`${name}: ArrowLeft activates previous tab`, await pca.getAttribute('aria-selected')==='true' && await pca.evaluate(el=>el===document.activeElement));
    await page.getByLabel('Variable genes',{exact:true}).fill('1500');
    check(`${name}: pending PCA edits prevent stale continuation`, await page.getByRole('button',{name:'Continue to clustering'}).isDisabled() && await cluster.isDisabled());
    await page.getByLabel('Variable genes',{exact:true}).fill('2000');
    await pca.focus(); await page.keyboard.press('End');
    check(`${name}: End reaches last enabled tab`, await cluster.getAttribute('aria-selected')==='true');
    await activate(page.getByRole('button',{name:'MS4A1',exact:true}));
    await page.getByRole('heading',{name:'MS4A1 expression'}).waitFor();
    await page.waitForFunction(()=>document.querySelector('.js-plotly-plot')?.data?.[0]?.hovertemplate?.includes('MS4A1'));
    await page.getByRole('region',{name:'UMAP cell embedding'}).scrollIntoViewIfNeeded();
    check(`${name}: gene action preserves readable results`, await page.getByText('66.7%',{exact:true}).isVisible());
    check(`${name}: UMAP preserves equal axis units`,await page.evaluate(()=>{
      const layout=document.querySelector('.js-plotly-plot')._fullLayout;
      return Math.abs(Math.abs(layout.xaxis._m)-Math.abs(layout.yaxis._m))<0.01;
    }));
    const point=page.locator('.scatterlayer .point').first();
    await point.scrollIntoViewIfNeeded();
    const pointRect=await point.boundingBox();
    await page.mouse.move(pointRect.x+pointRect.width/2,pointRect.y+pointRect.height/2);
    await page.locator('.hovertext').first().waitFor();
    check(`${name}: cell hover shows expression`,(await page.locator('.hovertext').first().textContent()).includes('MS4A1'));
    await screenshot(page,name+'-hover');
    const rangeBefore=await page.evaluate(()=>document.querySelector('.js-plotly-plot')._fullLayout.xaxis.range.slice());
    const drag=await page.locator('.nsewdrag').first().boundingBox();
    await page.mouse.move(drag.x+drag.width*.4,drag.y+drag.height*.5); await page.mouse.down();
    await page.mouse.move(drag.x+drag.width*.55,drag.y+drag.height*.5,{steps:25}); await page.mouse.up();
    await pause(150);
    check(`${name}: continuous drag pans plot`,await page.evaluate(before=>document.querySelector('.js-plotly-plot')._fullLayout.xaxis.range.some((value,i)=>value!==before[i]),rangeBefore));
    await page.mouse.move(0,0);
    await accessible(page,name+' expression');
    await page.mouse.move(0,0);
    const downloadButton=page.locator('.modebar-btn[data-title*="Download"]').first();
    check(`${name}: export control available without hover`, await downloadButton.isVisible());
    const downloaded=page.waitForEvent('download'); await activate(downloadButton);
    const file=await downloaded; await file.saveAs(path.join(out,name+'-plot.png'));
    check(`${name}: export produces PNG`, fs.readFileSync(path.join(out,name+'-plot.png')).subarray(1,4).toString()==='PNG');
    if(mobile){
      check('Phone input text prevents focus zoom', await resolution.evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=16));
      const targets=await page.locator('.demo-genes button,.demo-view-switch button,.demo-cluster-key button').evaluateAll(elements=>elements.map(el=>el.getBoundingClientRect().height));
      check('Phone repeated controls have 44px targets', targets.length>0&&targets.every(height=>height>=44),targets);
      const controls=await page.locator('.demo-shell button,.demo-shell input,.demo-shell select,.demo-method summary').evaluateAll(elements=>elements.map(el=>({
        label:el.getAttribute('aria-label')||el.textContent.trim(),height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width,
      })).filter(item=>item.height>0));
      check('Phone actions, fields, and disclosure have 44px targets',controls.every(item=>item.height>=44&&item.width>=44),controls);
      const plotTargets=await page.locator('.modebar-btn').evaluateAll(elements=>elements.map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})));
      check('Phone plot controls have 44px targets',plotTargets.every(rect=>rect.width>=44&&rect.height>=44),plotTargets);
    }
    const scrollBefore=await page.locator('.demo-shell').evaluate(el=>el.scrollTop);
    await page.mouse.move(viewport.width/2,viewport.height/2);
    await page.mouse.wheel(0,scrollBefore>0?-200:200); await pause(200);
    check(`${name}: wheel scroll preserves continuous page navigation`,await page.locator('.demo-shell').evaluate((el,before)=>el.scrollTop!==before,scrollBefore));
    await page.locator('.plotly-notifier').waitFor({state:'hidden',timeout:10000});
    await page.mouse.move(0,0);
    await screenshot(page,name+'-gene');
    await page.getByRole('tab',{name:/Quality control/}).click();
    await activate(page.getByRole('button',{name:'Scatter',exact:true}));
    await page.getByLabel('Maximum mitochondrial counts (%)').fill('');
    check(`${name}: blank QC filter blocks submission`, await page.getByRole('button',{name:'Apply QC'}).isDisabled());
    await page.getByLabel('Maximum mitochondrial counts (%)').pressSequentially('5.5',{delay:70});
    check(`${name}: QC edits require new PCA`, await pca.isDisabled());
    await screenshot(page,name+'-qc');
    await activate(page.getByRole('button',{name:'Apply QC'}));
    await page.getByText(`QC complete: ${fixture.cellCount.toLocaleString('en-US')} cells retained.`,{exact:true}).waitFor();
    await page.getByRole('button',{name:'Run normalization & PCA'}).click();
    await page.getByText('PCA complete: 30 components computed.',{exact:true}).waitFor();
    await page.waitForFunction(()=>!document.querySelector('.demo-reset').disabled);
    await page.getByRole('button',{name:'Continue to clustering'}).click();
    check(`${name}: rerunning QC and PCA clears old embedding`, await page.getByText('UMAP has not been computed').isVisible());
    check(`${name}: page has no horizontal overflow`, await page.evaluate(()=>document.querySelector('.demo-shell').scrollWidth<=innerWidth));
    await screenshot(page,name+'-complete');
  } finally {await saveVideo(context,page,name);}
}

let server, browser;
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  server=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),...(process.argv.includes('--production')?['preview']:[]),'--port',String(port),'--strictPort'],{cwd:root,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    server.stdout.on('data',data=>{if(data.toString().includes('Local:'))resolve();});
    server.stderr.on('data',data=>console.error(data.toString()));
    server.once('exit',code=>reject(new Error('Vite exited '+code)));
    setTimeout(()=>reject(new Error('Vite startup timeout')),30000).unref();
  });
  browser=await chromium.launch({headless:true});
  await workbench(browser);
  await touchWorkbench(browser);
  await demo(browser,false);
  await demo(browser,true);
  check('Recorded workflows have no uncaught browser errors',errors.length===0,errors);
})().catch(error=>{console.error(error);checks.push({name:'Acceptance completed',passed:false,detail:error.message});process.exitCode=1;}).finally(async()=>{
  if(browser)await browser.close(); if(server)server.kill();
  fs.writeFileSync(path.join(out,'acceptance.json'),JSON.stringify({checks,errors},null,2));
  console.log(`${checks.filter(item=>item.passed).length}/${checks.length} passed; recordings and screenshots: ${out}`);
});
