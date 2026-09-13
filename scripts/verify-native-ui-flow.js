#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium, _electron: electron } = require('playwright');
const { encodeMjpegAvi } = require('./mjpegAvi');

const root = path.resolve(__dirname, '..');
const captureScript = path.join(__dirname, 'capture-native-window.ps1');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertResearcherRunSurface(text, internalIds, label) {
  const rendered = String(text || '');
  for (const id of internalIds.filter(Boolean)) {
    assert(!rendered.includes(id), `${label} exposed the internal identifier ${id}.`);
  }
  assert(!/\bjob id\b|\bjob type\b|claimed by worker|type=(?:seurat|deg)|\b(?:seurat\.pipeline|deg\.find_markers)\.v1\b/i.test(rendered),
    `${label} exposed worker-oriented run details in the researcher surface.`);
}

function sanitizeNativeOverlap(overlap) {
  const evidence = Object.values(overlap?.stateEvidence || {});
  const runtimeIds = Object.values(overlap?.runtimeIds || {});
  return {
    observedAt: overlap?.observedAt || null,
    lanesObserved: Array.isArray(overlap?.slots) ? overlap.slots.length : 0,
    distinctRuntimeIdentities: runtimeIds.length === 2 && new Set(runtimeIds).size === 2,
    ownKeyOnly: evidence.length === 2 && evidence.every(item => (
      item.observedHasGlobalObject === true
      && item.observedActiveSessionKeyCount === 1
      && item.observedOwnKeyPresent === true
      && item.observedForeignKeyCount === 0
    )),
    stateObservations: evidence.map(item => ({
      observedAt: item.observedAt || null,
      hasGlobalObject: item.observedHasGlobalObject === true,
      activeSessionKeyCount: item.observedActiveSessionKeyCount,
      ownKeyPresent: item.observedOwnKeyPresent === true,
      foreignKeyCount: item.observedForeignKeyCount,
    })),
  };
}

function sanitizeBrowserPipeline(result) {
  return {
    pipelineCompleted: Boolean(result?.pipelineJobId && result?.resultAnalysisObjectId),
    checkpointLoadCompleted: Boolean(result?.checkpointLoadJobId),
    normalBridgeCompletion: result?.normalBridgeCompletion === true,
  };
}

function sanitizeBrowserCellChat(result) {
  return {
    completed: result?.status === 'completed',
    summaryAvailable: result?.summaryAvailable === true,
    controlledResultAvailable: result?.controlledResultAvailable === true,
    singleContextConfirmed: result?.singleContextConfirmed === true,
    candidateDisclaimerVisible: result?.candidateDisclaimerVisible === true,
  };
}

function sanitizeBrowserSpatial(result) {
  return {
    completed: true,
    normalBridgeCompletion: result.normalBridgeCompletion === true,
    checkpointOpened: Boolean(result.checkpointLoadJobId),
    immutableSaveCompleted: Boolean(result.checkpointSaveJobId),
    immutableSaveOpened: Boolean(result.savedResultAnalysisObjectId),
  };
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(check, timeoutMs = 30_000, message = 'Timed out waiting for UI state.') {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw lastError || new Error(message);
}

function timestampSegment() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function observePage(page, label, diagnostics) {
  page.on('pageerror', error => diagnostics.pageErrors.push(`[${label}] ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') {
      const location = message.location()?.url;
      diagnostics.consoleErrors.push(`[${label}] ${message.text()}${location ? ` @ ${location}` : ''}`);
    }
  });
  page.on('response', response => {
    if (response.status() >= 500) diagnostics.serverErrors.push(`[${label}] ${response.status()} ${response.url()}`);
    if (response.status() === 429) diagnostics.rateLimits.push(`[${label}] 429 ${response.url()}`);
  });
  page.on('requestfailed', request => {
    diagnostics.requestFailures.push(`[${label}] ${request.method()} ${request.url()} ${request.failure()?.errorText || 'failed'}`);
  });
  page.on('dialog', dialog => {
    const description = `[${label}] ${dialog.type()}: ${dialog.message()}`;
    if (dialog.type() === 'beforeunload') {
      diagnostics.beforeUnloadDialogs.push(description);
      void dialog.accept().catch(error => {
        if (!/No dialog is showing/i.test(error.message)) {
          diagnostics.pageErrors.push(`[${label}] beforeunload handling failed: ${error.message}`);
        }
      });
      return;
    }
    diagnostics.unexpectedDialogs.push(description);
    void dialog.dismiss().catch(error => {
      if (!/No dialog is showing/i.test(error.message)) {
        diagnostics.pageErrors.push(`[${label}] unexpected dialog handling failed: ${error.message}`);
      }
    });
  });
}

async function login(page, lane) {
  await page.getByRole('button', { name: 'Log In', exact: true }).click();
  await page.getByPlaceholder('researcher@lab.edu').fill(lane.email);
  await page.getByLabel('Password', { exact: true }).fill(lane.password);
  await page.getByRole('button', { name: /Open Workbench/ }).click();
  await page.getByRole('button', { name: 'Log out' }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByText(`Private fixture ${lane.index}`, { exact: true }).first()
    .waitFor({ state: 'visible', timeout: 30_000 });
}

async function selectLaneAnalysis(page, lane) {
  await page.evaluate(({ userId, projectId, objectId }) => {
    const safe = value => String(value).replace(/[^A-Za-z0-9_-]/g, '_');
    localStorage.setItem(`traceomics_selected_project_${safe(userId)}`, projectId);
    localStorage.setItem(
      `traceomics_selected_analysis_object_${safe(userId)}_${safe(projectId)}`,
      objectId
    );
  }, { userId: lane.userId, projectId: lane.projectId, objectId: lane.objectId });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByRole('button', { name: 'Log out' }).waitFor({ state: 'visible', timeout: 30_000 });
  const selected = await page.evaluate(({ userId, projectId }) => {
    const safe = value => String(value).replace(/[^A-Za-z0-9_-]/g, '_');
    return localStorage.getItem(
      `traceomics_selected_analysis_object_${safe(userId)}_${safe(projectId)}`
    );
  }, { userId: lane.userId, projectId: lane.projectId });
  assert(selected === lane.objectId, `Lane ${lane.index} did not retain its selected analysis preference.`);
}

async function openSidebarPage(page, label) {
  const button = page.getByRole('button', { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:,|$)`, 'i') });
  await button.waitFor({ state: 'visible', timeout: 30_000 });
  await button.click();
}

async function runSeuratPipeline(page, lane, pipelineInputPath, runDirectory) {
  assert(fs.existsSync(pipelineInputPath), 'The native browser Seurat input fixture is missing.');
  let pipelineJob = null;
  let loadJob = null;
  try {
    await openSidebarPage(page, 'Pipelines');
    await page.getByRole('heading', { name: 'Pipelines', exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 });
    const panel = page.getByTestId('seurat-pipeline-panel');
    await panel.waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('seurat-pipeline-upload').setInputFiles(pipelineInputPath);
    await panel.getByText(path.basename(pipelineInputPath), { exact: true })
      .waitFor({ state: 'visible', timeout: 120_000 });
    const launch = panel.getByRole('button', { name: 'Run Seurat preprocessing', exact: true });
    await waitFor(() => launch.isEnabled(), 30_000, 'Seurat pipeline launch did not enable after upload.');
    await launch.click();
    pipelineJob = await waitFor(async () => {
      const jobs = await page.evaluate(projectId => (
        window.electronAPI.listProjectJobs(projectId, { jobType: 'seurat.pipeline.v1' })
      ), lane.projectId);
      const latest = Array.isArray(jobs) ? jobs[0] : null;
      return latest && ['completed', 'failed', 'canceled'].includes(latest.status) ? latest : null;
    }, 10 * 60_000, 'The browser-launched Seurat pipeline did not reach a terminal state.');
    if (pipelineJob.status !== 'completed' || !pipelineJob.resultAnalysisObjectId) {
      throw new Error(`Seurat pipeline ${pipelineJob.status}: ${pipelineJob.error?.code || 'unknown'} ${pipelineJob.error?.message || ''}`);
    }
    const pipelineLogResponse = await page.evaluate(({ projectId, jobId }) => (
      window.electronAPI.getProjectJobLogs(projectId, jobId)
    ), { projectId: lane.projectId, jobId: pipelineJob.id });
    const pipelineLogs = Array.isArray(pipelineLogResponse?.logs) ? pipelineLogResponse.logs : [];
    const pipelineLogText = JSON.stringify(pipelineLogs);
    assert(!/R_TIMEOUT|R bridge failed|outcome is indeterminate|receipt recovery/i.test(pipelineLogText),
      'The real Seurat pipeline completed only after an R timeout/recovery path.');
    const refreshJob = panel.getByRole('button', { name: 'Refresh run', exact: true });
    await refreshJob.click();
    await panel.getByText(/Saved analysis is ready|Preparing saved analysis/, { exact: false }).first()
      .waitFor({ state: 'visible', timeout: 60_000 });
    assert(await panel.getByText(pipelineJob.resultAnalysisObjectId, { exact: true }).count() === 0,
      'The researcher-facing Seurat panel exposed the internal result analysis identifier.');
    assertResearcherRunSurface(await panel.innerText(), [pipelineJob.id, pipelineJob.resultAnalysisObjectId],
      'Seurat pipeline');
    await page.screenshot({
      path: path.join(runDirectory, 'browser-real-seurat-pipeline.png'), fullPage: false,
    });

    const load = panel.getByRole('button', { name: 'Open saved version', exact: true });
    await waitFor(() => load.isEnabled(), 30_000, 'Completed pipeline checkpoint did not become attachable.');
    await load.click();
    loadJob = await waitFor(async () => {
      const jobs = await page.evaluate(({ projectId, objectId }) => (
        window.electronAPI.listProjectJobs(projectId, {
          jobType: 'checkpoint.load.v1', analysisObjectId: objectId,
        })
      ), { projectId: lane.projectId, objectId: pipelineJob.resultAnalysisObjectId });
      const latest = Array.isArray(jobs) ? jobs[0] : null;
      return latest && ['completed', 'failed', 'canceled'].includes(latest.status) ? latest : null;
    }, 180_000, 'The browser-launched checkpoint load did not reach a terminal state.');
    if (loadJob.status !== 'completed') {
      throw new Error(`Pipeline checkpoint load ${loadJob.status}: ${loadJob.error?.code || 'unknown'} ${loadJob.error?.message || ''}`);
    }
    const attached = panel.getByRole('button', { name: 'Saved version opened', exact: true });
    try {
      await attached.waitFor({ state: 'visible', timeout: 60_000 });
    } catch {
      const refreshLoad = panel.getByRole('button', { name: 'Refresh', exact: true });
      await waitFor(() => refreshLoad.isEnabled(), 30_000,
        'Checkpoint load refresh did not stabilize after durable completion.');
      await refreshLoad.click();
      await attached.waitFor({ state: 'visible', timeout: 60_000 });
    }
    const continueToDeg = panel.getByRole('button', { name: 'Continue to marker analysis', exact: true });
    await waitFor(() => continueToDeg.isEnabled(), 30_000,
      'The attached Seurat pipeline result did not enable downstream analysis.');
    await continueToDeg.click();
    await page.getByRole('heading', { name: 'Markers / Differential Expression', exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 });
    return {
      pipelineJobId: pipelineJob.id,
      resultAnalysisObjectId: pipelineJob.resultAnalysisObjectId,
      checkpointLoadJobId: loadJob.id,
      normalBridgeCompletion: true,
    };
  } catch (error) {
    await page.screenshot({
      path: path.join(runDirectory, 'browser-seurat-pipeline-failure.png'), fullPage: false,
    }).catch(() => {});
    fs.writeFileSync(path.join(runDirectory, 'browser-seurat-pipeline-failure.json'), `${JSON.stringify({
      capturedAt: new Date().toISOString(), error: error.message, pipelineJob, loadJob,
    }, null, 2)}\n`);
    throw error;
  }
}

async function runSpatialSeuratPipeline(page, lane, spatialInputPath, runDirectory) {
  assert(fs.existsSync(spatialInputPath), 'The native browser spatial input fixture is missing.');
  let pipelineJob = null;
  let loadJob = null;
  try {
    await openSidebarPage(page, 'Pipelines');
    await page.getByRole('heading', { name: 'Pipelines', exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 });
    const panel = page.getByTestId('seurat-pipeline-panel');
    await panel.getByRole('button', { name: 'Spatial transcriptomics (Visium)', exact: true }).click();
    await panel.getByText(/classic 10x Visium Space Ranger output bundles/i)
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('seurat-pipeline-upload').setInputFiles(spatialInputPath);
    await panel.getByText(path.basename(spatialInputPath), { exact: true })
      .waitFor({ state: 'visible', timeout: 120_000 });
    const launch = panel.getByRole('button', { name: 'Run spatial Seurat preprocessing', exact: true });
    await waitFor(() => launch.isEnabled(), 60_000,
      'Spatial Seurat launch did not enable after server-side Visium validation.');
    await launch.click();
    pipelineJob = await waitFor(async () => {
      const jobs = await page.evaluate(projectId => (
        window.electronAPI.listProjectJobs(projectId, { jobType: 'spatial.seurat.v1' })
      ), lane.projectId);
      const latest = Array.isArray(jobs) ? jobs[0] : null;
      return latest && ['completed', 'failed', 'canceled'].includes(latest.status) ? latest : null;
    }, 10 * 60_000, 'The browser-launched spatial Seurat pipeline did not reach a terminal state.');
    if (pipelineJob.status !== 'completed' || !pipelineJob.resultAnalysisObjectId) {
      throw new Error(`Spatial Seurat pipeline ${pipelineJob.status}: ${pipelineJob.error?.code || 'unknown'} ${pipelineJob.error?.message || ''}`);
    }
    const logsResponse = await page.evaluate(({ projectId, jobId }) => (
      window.electronAPI.getProjectJobLogs(projectId, jobId)
    ), { projectId: lane.projectId, jobId: pipelineJob.id });
    const logText = JSON.stringify(Array.isArray(logsResponse?.logs) ? logsResponse.logs : []);
    assert(!/R_TIMEOUT|R bridge failed|outcome is indeterminate|receipt recovery/i.test(logText),
      'The real spatial pipeline completed only after an R timeout/recovery path.');
    await panel.getByRole('button', { name: 'Refresh run', exact: true }).click();
    await panel.getByText('Spatial Seurat preprocessing', { exact: true }).waitFor({ timeout: 60_000 });
    assertResearcherRunSurface(await panel.innerText(), [pipelineJob.id, pipelineJob.resultAnalysisObjectId],
      'Spatial Seurat pipeline');
    await page.screenshot({
      path: path.join(runDirectory, 'browser-real-spatial-seurat-pipeline.png'), fullPage: false,
    });

    const load = panel.getByRole('button', { name: 'Open saved version', exact: true });
    await waitFor(() => load.isEnabled(), 30_000, 'Spatial checkpoint did not become attachable.');
    await load.click();
    loadJob = await waitFor(async () => {
      const jobs = await page.evaluate(({ projectId, objectId }) => (
        window.electronAPI.listProjectJobs(projectId, {
          jobType: 'checkpoint.load.v1', analysisObjectId: objectId,
        })
      ), { projectId: lane.projectId, objectId: pipelineJob.resultAnalysisObjectId });
      const latest = Array.isArray(jobs) ? jobs[0] : null;
      return latest && ['completed', 'failed', 'canceled'].includes(latest.status) ? latest : null;
    }, 180_000, 'The browser-launched spatial checkpoint load did not reach a terminal state.');
    if (loadJob.status !== 'completed') {
      throw new Error(`Spatial checkpoint load ${loadJob.status}: ${loadJob.error?.code || 'unknown'} ${loadJob.error?.message || ''}`);
    }
    const attached = panel.getByRole('button', { name: 'Saved version opened', exact: true });
    if (!await attached.isVisible().catch(() => false)) {
      const refreshLoad = panel.getByRole('button', { name: 'Refresh', exact: true });
      await waitFor(() => refreshLoad.isEnabled(), 30_000,
        'Spatial checkpoint load refresh did not stabilize after durable completion.');
      await refreshLoad.click();
    }
    await attached.waitFor({ state: 'visible', timeout: 60_000 });
    const continueToDeg = panel.getByRole('button', { name: 'Continue to marker analysis', exact: true });
    await waitFor(() => continueToDeg.isEnabled(), 30_000,
      'The attached spatial result did not enable downstream analysis.');
    await continueToDeg.click();
    await page.getByRole('heading', { name: 'Markers / Differential Expression', exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 });
    return {
      pipelineJobId: pipelineJob.id,
      resultAnalysisObjectId: pipelineJob.resultAnalysisObjectId,
      checkpointLoadJobId: loadJob.id,
      normalBridgeCompletion: true,
    };
  } catch (error) {
    await page.screenshot({
      path: path.join(runDirectory, 'browser-spatial-pipeline-failure.png'), fullPage: false,
    }).catch(() => {});
    fs.writeFileSync(path.join(runDirectory, 'browser-spatial-pipeline-failure.json'), `${JSON.stringify({
      capturedAt: new Date().toISOString(), error: error.message, pipelineJob, loadJob,
    }, null, 2)}\n`);
    throw error;
  }
}

async function saveCurrentAnalysis(page, lane, sourceObjectId) {
  await openSidebarPage(page, 'UMAP');
  await page.getByRole('heading', { name: 'UMAP Embedding', exact: true }).waitFor({ timeout: 30_000 });
  const recompute = page.getByRole('button', { name: 'Re-compute UMAP', exact: true });
  await recompute.waitFor({ state: 'visible', timeout: 60_000 });
  await recompute.click();
  const save = page.getByRole('button', { name: 'Save current analysis', exact: true });
  await save.waitFor({ state: 'visible', timeout: 180_000 });
  await save.click();
  const saveJob = await waitFor(async () => {
    const jobs = await page.evaluate(({ projectId, objectId }) => (
      window.electronAPI.listProjectJobs(projectId, {
        jobType: 'checkpoint.save.v1', analysisObjectId: objectId,
      })
    ), { projectId: lane.projectId, objectId: sourceObjectId });
    const latest = Array.isArray(jobs) ? jobs[0] : null;
    return latest && ['completed', 'failed', 'canceled'].includes(latest.status) ? latest : null;
  }, 180_000, 'The browser-launched checkpoint save did not reach a terminal state.');
  if (saveJob.status !== 'completed' || !saveJob.resultAnalysisObjectId) {
    throw new Error(`Checkpoint save ${saveJob.status}: ${saveJob.error?.code || 'unknown'} ${saveJob.error?.message || ''}`);
  }
  await page.getByText('Saved and opened as a durable analysis version.', { exact: true })
    .waitFor({ state: 'visible', timeout: 180_000 });
  const loadJob = await waitFor(async () => {
    const jobs = await page.evaluate(({ projectId, objectId }) => (
      window.electronAPI.listProjectJobs(projectId, {
        jobType: 'checkpoint.load.v1', analysisObjectId: objectId,
      })
    ), { projectId: lane.projectId, objectId: saveJob.resultAnalysisObjectId });
    const latest = Array.isArray(jobs) ? jobs[0] : null;
    return latest && ['completed', 'failed', 'canceled'].includes(latest.status) ? latest : null;
  }, 180_000, 'The saved immutable analysis was not opened in the private workspace.');
  assert(loadJob.status === 'completed',
    `Saved immutable analysis load ${loadJob.status}: ${loadJob.error?.code || 'unknown'} ${loadJob.error?.message || ''}`);
  return {
    checkpointSaveJobId: saveJob.id,
    savedResultAnalysisObjectId: saveJob.resultAnalysisObjectId,
    savedCheckpointLoadJobId: loadJob.id,
  };
}

async function attachCheckpoint(page, lane, runDirectory, label) {
  let job = null;
  try {
    await openSidebarPage(page, 'Runs & Results');
    await page.getByRole('heading', { name: 'Runs & Results', exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page.screenshot({ path: path.join(runDirectory, `${label}-runs-and-results.png`), fullPage: false });
    const existingState = await page.evaluate(objectId => (
      window.electronAPI.apiRequest('/pipeline-state', {
        headers: { 'X-Object-ID': objectId },
      })
    ), lane.objectId);
    if (existingState?.exists === true) {
      assert(existingState.has_pca === true,
        `Existing private checkpoint state did not contain PCA for ${label}.`);
      await waitFor(async () => (
        await page.getByRole('heading', { name: 'Restore private live state', exact: true }).count()
      ) === 0, 30_000, `Existing private checkpoint state was not projected for ${label}.`);
      return { alreadyAttached: true };
    }
    const restoreHeading = page.getByRole('heading', { name: 'Open a saved version', exact: true });
    const umapNavigation = page.getByRole('button', { name: /^UMAP(?:,|$)/i });
    if (await restoreHeading.count() === 0 && await umapNavigation.isEnabled()) {
      return { projectedAttached: true };
    }
    const attach = page.getByRole('button', { name: 'Open saved version', exact: true });
    await attach.waitFor({ state: 'visible', timeout: 30_000 });
    await attach.click();
    job = await waitFor(async () => {
      const jobs = await page.evaluate(({ projectId, objectId }) => (
        window.electronAPI.listProjectJobs(projectId, {
          jobType: 'checkpoint.load.v1', analysisObjectId: objectId,
        })
      ), { projectId: lane.projectId, objectId: lane.objectId });
      const latest = Array.isArray(jobs) ? jobs[0] : null;
      return latest && ['completed', 'failed', 'canceled'].includes(latest.status) ? latest : null;
    }, 180_000, `Checkpoint attachment did not complete for ${label}.`);
    if (job.status !== 'completed') {
      throw new Error(`Checkpoint attach ${job.status} for ${label}: ${job.error?.code || 'unknown'} ${job.error?.message || ''}`);
    }
    await waitFor(async () => {
      const state = await page.evaluate(objectId => (
        window.electronAPI.apiRequest('/pipeline-state', {
          headers: { 'X-Object-ID': objectId },
        })
      ), lane.objectId);
      return state?.exists === true && state?.has_pca === true;
    }, 60_000, `Private checkpoint state was not available after attachment for ${label}.`);
    // The durable job may complete before ProjectHistory's polling callback has
    // projected the private attachment into App state. Reloading causes the
    // authoritative pipeline-state probe to rebuild that projection.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await openSidebarPage(page, 'Markers / DEG');
    await page.getByRole('heading', { name: 'Markers / Differential Expression', exact: true })
      .waitFor({ timeout: 30_000 });
    await page.getByText('cluster groups ready', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 });
    await waitFor(async () => (
      page.getByText(/This saved analysis is not open in your private analysis workspace yet/i).isHidden()
    ), 60_000, `Private checkpoint attachment was not projected after reload for ${label}.`);
  } catch (error) {
    const diagnosticPath = path.join(runDirectory, `${label}-attach-failure.json`);
    const screenshotPath = path.join(runDirectory, `${label}-attach-failure.png`);
    const pageState = await page.evaluate(() => ({
      url: window.location.href,
      text: document.body?.innerText?.slice(0, 12_000) || '',
    })).catch(() => ({ url: '', text: '' }));
    fs.writeFileSync(diagnosticPath, `${JSON.stringify({
      capturedAt: new Date().toISOString(), error: error.message, job, pageState,
    }, null, 2)}\n`);
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    throw error;
  }
}

async function showUmap(page) {
  await openSidebarPage(page, 'UMAP');
  await page.getByRole('heading', { name: 'UMAP Embedding', exact: true }).waitFor({ timeout: 30_000 });
  const hasVisiblePlotData = () => page.evaluate(() => (
    [...document.querySelectorAll('.js-plotly-plot')].some(element => {
      const rectangle = element.getBoundingClientRect();
      const visible = rectangle.width > 0 && rectangle.height > 0
        && window.getComputedStyle(element).visibility !== 'hidden';
      return visible && Array.isArray(element.data)
        && element.data.some(trace => trace && trace.x && trace.x.length > 0);
    })
  ));
  try {
    await waitFor(hasVisiblePlotData, 5_000, 'No hydrated UMAP plot data was available.');
  } catch {
    const run = page.getByRole('button', { name: /Run 2D UMAP|Re-compute UMAP/ }).first();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await run.click();
      try {
        await waitFor(hasVisiblePlotData, 60_000, 'UMAP did not render nonempty plot data.');
        return;
      } catch (error) {
        const transient = await page.getByText(
          'Analysis compute is busy. Wait a moment and try again.', { exact: true }
        ).isVisible().catch(() => false);
        if (!transient || attempt === 2) throw error;
        await delay(1_500);
      }
    }
  }
}

async function runOverview(page, lane) {
  await openSidebarPage(page, 'Exploratory Analysis');
  await page.getByRole('heading', { name: 'Exploratory Analysis', exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Run recipe', exact: true }).click();
  const job = await waitFor(async () => {
    const jobs = await page.evaluate(({ projectId, objectId }) => (
      window.electronAPI.listProjectJobs(projectId, {
        jobType: 'explore.summarize.v1', analysisObjectId: objectId,
      })
    ), { projectId: lane.projectId, objectId: lane.objectId });
    const latest = Array.isArray(jobs) ? jobs[0] : null;
    return latest && ['completed', 'failed', 'canceled'].includes(latest.status) ? latest : null;
  }, 10 * 60_000, 'The browser-launched exploratory analysis did not reach a terminal state.');
  if (job.status !== 'completed') {
    throw new Error(`Exploratory browser analysis ${job.status}: ${job.error?.code || 'unknown'} ${job.error?.message || ''}`);
  }
  await page.getByText('Cells', { exact: true }).first().waitFor({ timeout: 60_000 });
  await page.locator('.js-plotly-plot').filter({ visible: true }).first()
    .waitFor({ state: 'visible', timeout: 30_000 });
}

async function runCellChat(page, lane, runDirectory) {
  await openSidebarPage(page, 'CellChat');
  await page.getByRole('heading', { name: 'CellChat communication candidates', exact: true })
    .waitFor({ state: 'visible', timeout: 30_000 });

  const launch = page.getByRole('button', { name: 'Start CellChat Inference', exact: true });
  assert(await launch.isDisabled(), 'CellChat launch was enabled before the required scientific choices were explicit.');
  await page.getByRole('combobox', { name: /Group labels \(required\)/i }).selectOption('seurat_clusters');
  await page.getByRole('combobox', { name: /Species \(required\)/i }).selectOption('human');
  await page.getByRole('combobox', { name: /Database category \(required\)/i }).selectOption('secreted_signaling');
  await page.getByRole('combobox', { name: /Analysis intent \(required\)/i }).selectOption('single_context');
  await waitFor(() => launch.isEnabled(), 30_000,
    'CellChat launch did not enable after every required scientific choice was confirmed.');
  await launch.click();

  const job = await waitFor(async () => {
    const jobs = await page.evaluate(({ projectId, objectId }) => (
      window.electronAPI.listProjectJobs(projectId, {
        jobType: 'cellchat.infer.v1', analysisObjectId: objectId,
      })
    ), { projectId: lane.projectId, objectId: lane.objectId });
    const latest = Array.isArray(jobs) ? jobs[0] : null;
    return latest && ['completed', 'failed', 'canceled'].includes(latest.status) ? latest : null;
  }, 10 * 60_000, 'The browser-launched CellChat analysis did not reach a terminal state.');
  if (job.status !== 'completed') {
    throw new Error(`CellChat browser analysis ${job.status}: ${job.error?.code || 'unknown'} ${job.error?.message || ''}`);
  }

  const artifacts = await page.evaluate(({ projectId, jobId }) => (
    window.electronAPI.listProjectJobArtifacts(projectId, jobId)
  ), { projectId: lane.projectId, jobId: job.id });
  const summary = (Array.isArray(artifacts) ? artifacts : [])
    .find(artifact => artifact.artifactType === 'cellchat_summary');
  const controlledResult = (Array.isArray(artifacts) ? artifacts : [])
    .find(artifact => artifact.artifactType === 'cellchat_results');
  assert(summary, 'The real browser CellChat run did not publish its bounded summary artifact.');
  assert(controlledResult, 'The real browser CellChat run did not publish its controlled result table.');
  assert(summary.metadata?.summary?.analysisIntent === 'single_context',
    'The real browser CellChat summary did not preserve the explicit single-context intent.');

  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  if (await refresh.count()) await refresh.click();
  await page.getByText('summary available', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByText(/CellChat produces candidate predictions/i).waitFor({ state: 'visible', timeout: 30_000 });
  const bodyText = await page.locator('body').innerText();
  assertResearcherRunSurface(bodyText, [job.id, lane.objectId], 'CellChat');
  assert(!/storage[_ -]?(?:key|uri)|state[_ -]?key|claimed by worker/i.test(bodyText),
    'The real browser CellChat surface exposed internal storage or worker details.');
  await page.screenshot({ path: path.join(runDirectory, 'browser-real-cellchat.png'), fullPage: false });

  return {
    status: job.status,
    summaryAvailable: true,
    controlledResultAvailable: true,
    singleContextConfirmed: true,
    candidateDisclaimerVisible: true,
  };
}

async function prepareDegLaunch(page, lane, runDirectory) {
  await openSidebarPage(page, 'Markers / DEG');
  await page.getByRole('heading', { name: 'Markers / Differential Expression', exact: true })
    .waitFor({ timeout: 30_000 });
  const launch = page.getByRole('button', { name: 'Run marker analysis', exact: true });
  try {
    await waitFor(async () => launch.isEnabled(), 60_000, `DEG launch did not enable for lane ${lane.index}.`);
  } catch (error) {
    const messages = {
      savedAnalysisMissing: await page.getByText(/Select a saved analysis before running marker analysis/i).isVisible().catch(() => false),
      readOnly: await page.getByText(/Your project role is read-only/i).isVisible().catch(() => false),
      foreignOwner: await page.getByText(/This analysis belongs to another member/i).isVisible().catch(() => false),
      privateWorkspaceNotReady: await page.getByText(/This saved analysis is not open in your private analysis workspace yet/i).isVisible().catch(() => false),
      computeUnavailable: await page.getByText(/Compute is temporarily unavailable/i).isVisible().catch(() => false),
      clusterGroupsReady: await page.getByText('cluster groups ready', { exact: true }).isVisible().catch(() => false),
      launchDisabled: await launch.isDisabled().catch(() => true),
    };
    const evidenceBase = `electron-lane-${lane.index}-deg-launch-failure`;
    await page.screenshot({ path: path.join(runDirectory, `${evidenceBase}.png`), fullPage: false })
      .catch(() => undefined);
    await fs.promises.writeFile(
      path.join(runDirectory, `${evidenceBase}.json`),
      `${JSON.stringify({ lane: lane.index, messages }, null, 2)}\n`,
      'utf8'
    );
    throw error;
  }
  return launch;
}

async function findLaunchedDegJob(page, lane) {
  return waitFor(async () => {
    const jobs = await page.evaluate(({ projectId, objectId }) => (
      window.electronAPI.listProjectJobs(projectId, {
        jobType: 'deg.find_markers.v1', analysisObjectId: objectId,
      })
    ), { projectId: lane.projectId, objectId: lane.objectId });
    return Array.isArray(jobs) && jobs[0]?.id ? jobs[0] : null;
  }, 30_000, `DEG job was not visible for lane ${lane.index}.`);
}

async function waitForDegResult(page, lane, jobId) {
  const job = await waitFor(async () => {
    const jobs = await page.evaluate(({ projectId, objectId }) => (
      window.electronAPI.listProjectJobs(projectId, {
        jobType: 'deg.find_markers.v1', analysisObjectId: objectId,
      })
    ), { projectId: lane.projectId, objectId: lane.objectId });
    const current = Array.isArray(jobs) ? jobs.find(item => item.id === jobId) : null;
    return current && ['completed', 'failed', 'canceled'].includes(current.status) ? current : null;
  }, 180_000, `DEG job did not reach a terminal state for lane ${lane.index}.`);
  if (job.status !== 'completed') {
    throw new Error(`DEG job ${job.status} for lane ${lane.index}: ${job.error?.code || 'unknown'} ${job.error?.message || ''}`);
  }
  const completed = page.getByText('Marker analysis complete', { exact: true });
  if (!await completed.isVisible().catch(() => false)) {
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
    await refresh.waitFor({ state: 'visible', timeout: 30_000 });
    await refresh.click();
  }
  await completed.waitFor({ state: 'visible', timeout: 60_000 });
}

async function closeElectronApp(app) {
  let child = null;
  try { child = app.process(); } catch { /* app may already be closed */ }
  const closeAttempt = app.close().then(() => true).catch(() => false);
  await Promise.race([closeAttempt, delay(10_000)]);
  if (child && child.exitCode === null) {
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.once('error', resolve);
        killer.once('exit', resolve);
      });
    } else {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* process may have exited */ }
    }
  }
  if (child && child.exitCode === null) {
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      delay(5_000),
    ]);
  }
}

async function removeTemporaryProfileRoot(tempRoot) {
  let lastError = null;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 20) await delay(500);
    }
  }
  throw lastError || new Error('Temporary Electron profile cleanup failed.');
}

function runPowerShellCapture({ windowHandle, outputDirectory, frameCount, frameIntervalMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', captureScript,
      '-WindowHandle', String(windowHandle),
      '-OutputDirectory', outputDirectory,
      '-FrameCount', String(frameCount),
      '-FrameIntervalMs', String(frameIntervalMs),
    ], { cwd: root, windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) return reject(new Error(`Native window capture failed (${code}): ${stderr || stdout}`));
      try {
        const marker = stdout.trim().split(/\r?\n/).reverse().find(line => line.startsWith('{'));
        resolve(JSON.parse(marker));
      } catch (error) {
        reject(new Error(`Native window capture returned invalid metadata: ${error.message}`));
      }
      return undefined;
    });
  });
}

async function focusElectronWindow(electronApp) {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('Electron BrowserWindow is missing.');
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  await delay(500);
}

async function getElectronWindowHandle(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('Electron BrowserWindow is missing.');
    const handle = window.getNativeWindowHandle();
    if (handle.length === 8) return handle.readBigUInt64LE().toString();
    if (handle.length === 4) return String(handle.readUInt32LE());
    throw new Error('Electron returned an unsupported native window handle.');
  });
}

async function captureNativeStill(electronApp, targetPath) {
  await focusElectronWindow(electronApp);
  const windowHandle = await getElectronWindowHandle(electronApp);
  const frameDirectory = `${targetPath}.frames`;
  const metadata = await runPowerShellCapture({
    windowHandle,
    outputDirectory: frameDirectory,
    frameCount: 1,
    frameIntervalMs: 100,
  });
  const frame = path.join(frameDirectory, 'frame_0000.jpg');
  fs.copyFileSync(frame, targetPath);
  fs.rmSync(frameDirectory, { recursive: true, force: true });
  return metadata;
}

async function recordNativeUmap(electronApp, page, runDirectory) {
  await focusElectronWindow(electronApp);
  const windowHandle = await getElectronWindowHandle(electronApp);
  const frameDirectory = path.join(runDirectory, 'electron-umap-frames');
  const frameCount = 60;
  const frameIntervalMs = 100;
  const capture = runPowerShellCapture({
    windowHandle,
    outputDirectory: frameDirectory,
    frameCount,
    frameIntervalMs,
  });
  const plot = page.locator('.js-plotly-plot').filter({ visible: true }).first();
  const bounds = await plot.boundingBox();
  if (bounds) {
    for (let index = 0; index < 24; index += 1) {
      const fraction = index / 23;
      await page.mouse.move(
        bounds.x + bounds.width * (0.18 + 0.64 * fraction),
        bounds.y + bounds.height * (0.35 + 0.18 * Math.sin(fraction * Math.PI * 2)),
        { steps: 2 }
      );
      await delay(180);
    }
  }
  const metadata = await capture;
  const framePaths = fs.readdirSync(frameDirectory)
    .filter(name => /^frame_\d{4}\.jpg$/.test(name)).sort()
    .map(name => path.join(frameDirectory, name));
  assert(framePaths.length === frameCount, `Expected ${frameCount} native frames, found ${framePaths.length}.`);
  const frames = framePaths.map(framePath => fs.readFileSync(framePath));
  const avi = encodeMjpegAvi({
    frames, width: metadata.width, height: metadata.height,
    fps: Math.max(1, Math.round(1000 / frameIntervalMs)),
  });
  const videoPath = path.join(runDirectory, 'electron-native-umap.avi');
  fs.writeFileSync(videoPath, avi);
  fs.copyFileSync(framePaths[0], path.join(runDirectory, 'electron-native-umap.jpg'));
  fs.rmSync(frameDirectory, { recursive: true, force: true });
  assert(avi.subarray(0, 4).toString('ascii') === 'RIFF'
    && avi.subarray(8, 12).toString('ascii') === 'AVI ', 'Generated native UMAP AVI is malformed.');
  return { videoPath, frameCount, width: metadata.width, height: metadata.height, sizeBytes: avi.length };
}

async function launchElectron(origin, profileDirectory) {
  return electron.launch({
    args: [root, `--user-data-dir=${profileDirectory}`],
    env: { ...process.env, TRACEOMICS_DESKTOP_URL: origin },
    timeout: 60_000,
  });
}

function assertCleanDiagnostics(diagnostics) {
  const ignoredConsole = /Failed to load resource: the server responded with a status of 401 \(Unauthorized\)/i;
  const expectedRateLimits = diagnostics.rateLimits.filter(message => (
    /^\[electron-\d+\] 429 /i.test(message)
    && /\/api\/r\/pipeline-state(?:\?|$)/i.test(message)
  ));
  const unexpectedRateLimits = diagnostics.rateLimits.filter(message => !expectedRateLimits.includes(message));
  const consoleErrors = diagnostics.consoleErrors.filter(message => (
    !ignoredConsole.test(message)
    && !(expectedRateLimits.length > 0 && /status of 429 \(Too Many Requests\)/i.test(message))
  ));
  const requestFailures = diagnostics.requestFailures.filter(message => !/net::ERR_ABORTED/i.test(message));
  assert(diagnostics.pageErrors.length === 0, `UI page errors: ${diagnostics.pageErrors.join(' | ')}`);
  assert(diagnostics.serverErrors.length === 0, `UI server errors: ${diagnostics.serverErrors.join(' | ')}`);
  assert(unexpectedRateLimits.length === 0, `Unexpected UI rate limits: ${unexpectedRateLimits.join(' | ')}`);
  assert(consoleErrors.length === 0, `UI console errors: ${consoleErrors.join(' | ')}`);
  assert(requestFailures.length === 0, `UI request failures: ${requestFailures.join(' | ')}`);
  assert(diagnostics.unexpectedDialogs.length === 0,
    `Unexpected UI dialogs: ${diagnostics.unexpectedDialogs.join(' | ')}`);
  return {
    expectedPipelineProbe429: expectedRateLimits.length,
    expectedBeforeUnloadDialogs: diagnostics.beforeUnloadDialogs.length,
  };
}

async function runNativeUiAcceptance({ origin, lanes, pipelineInputPath, spatialInputPath, observeConcurrent }) {
  assert(process.platform === 'win32', 'Native Electron window recording currently requires Windows.');
  assert(Array.isArray(lanes) && lanes.length === 2, 'Two private UI lanes are required.');
  assert(typeof pipelineInputPath === 'string' && pipelineInputPath,
    'A real 10x HDF5 input is required for native browser acceptance.');
  assert(typeof spatialInputPath === 'string' && spatialInputPath,
    'A real classic Visium ZIP input is required for native browser acceptance.');
  assert(typeof observeConcurrent === 'function', 'Concurrent-observation callback is required.');
  const runDirectory = path.join(root, 'playwright', 'report', 'release-acceptance', `native-ui-${timestampSegment()}`);
  fs.mkdirSync(runDirectory, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-native-ui-'));
  const diagnostics = {
    pageErrors: [], consoleErrors: [], serverErrors: [], rateLimits: [], requestFailures: [],
    beforeUnloadDialogs: [], unexpectedDialogs: [],
  };
  let browser = null;
  let browserContext = null;
  const electronApps = [];
  let primaryError = null;
  let cleanupError = null;
  let acceptanceResult = null;
  try {
    browser = await chromium.launch({ headless: true });
    browserContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      recordVideo: { dir: runDirectory, size: { width: 1440, height: 1000 } },
    });
    const browserPage = await browserContext.newPage();
    observePage(browserPage, 'browser-owner', diagnostics);
    await browserPage.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await login(browserPage, lanes[0]);
    assert(await browserPage.getByText(lanes[1].projectName, { exact: true }).count() === 0,
      'Browser owner saw another private project.');
    const browserSeuratPipeline = await runSeuratPipeline(
      browserPage, lanes[0], pipelineInputPath, runDirectory
    );
    lanes[0].fixtureObjectId = lanes[0].objectId;
    lanes[0].objectId = browserSeuratPipeline.resultAnalysisObjectId;
    await showUmap(browserPage);
    await browserPage.screenshot({ path: path.join(runDirectory, 'browser-real-umap.png'), fullPage: false });
    await runOverview(browserPage, lanes[0]);
    await browserPage.screenshot({ path: path.join(runDirectory, 'browser-real-exploration.png'), fullPage: false });
    const browserCellChat = await runCellChat(browserPage, lanes[0], runDirectory);
    const browserSpatialPipeline = await runSpatialSeuratPipeline(
      browserPage, lanes[0], spatialInputPath, runDirectory
    );
    await showUmap(browserPage);
    await browserPage.screenshot({ path: path.join(runDirectory, 'browser-real-spatial-umap.png'), fullPage: false });
    const spatialSave = await saveCurrentAnalysis(
      browserPage, lanes[0], browserSpatialPipeline.resultAnalysisObjectId
    );
    await browserContext.close();
    browserContext = null;
    await browser.close();
    browser = null;

    for (const lane of lanes) {
      const profile = path.join(tempRoot, `profile-${lane.index}`);
      fs.mkdirSync(profile, { recursive: true });
      const app = await launchElectron(origin, profile);
      electronApps.push(app);
      const page = await app.firstWindow({ timeout: 60_000 });
      observePage(page, `electron-${lane.index}`, diagnostics);
      await page.waitForLoadState('domcontentloaded');
      await login(page, lane);
      await selectLaneAnalysis(page, lane);
      assert(await page.getByText(lanes.find(other => other.index !== lane.index).projectName, { exact: true }).count() === 0,
        `Electron lane ${lane.index} saw another private project.`);
      lane.electronApp = app;
      lane.page = page;
    }

    await Promise.all(lanes.map(lane => attachCheckpoint(
      lane.page, lane, runDirectory, `electron-lane-${lane.index}`
    )));
    await showUmap(lanes[0].page);
    const nativeUmap = await recordNativeUmap(lanes[0].electronApp, lanes[0].page, runDirectory);

    const launchButtons = await Promise.all(lanes.map(lane => prepareDegLaunch(lane.page, lane, runDirectory)));
    await Promise.all(launchButtons.map(button => button.click()));
    const launched = await Promise.all(lanes.map(lane => findLaunchedDegJob(lane.page, lane)));
    const jobs = launched.map((job, index) => ({
      id: job.id,
      userId: lanes[index].userId,
      projectId: lanes[index].projectId,
      objectId: lanes[index].objectId,
      lane: lanes[index].index,
    }));
    const nativeObservation = await observeConcurrent(jobs);
    const overlap = nativeObservation?.overlap;
    assert(overlap && Array.isArray(overlap.slots),
      'Native concurrent-observation callback returned no isolation evidence.');
    await Promise.all(lanes.map((lane, index) => waitForDegResult(
      lane.page, lane, jobs[index].id
    )));
    await Promise.all(lanes.map(async (lane, index) => {
      assertResearcherRunSurface(await lane.page.locator('body').innerText(),
        [jobs[index].id, lane.objectId], `Electron lane ${lane.index} DEG`);
    }));
    const nativeStills = [];
    for (const lane of lanes) {
      const target = path.join(runDirectory, `electron-private-lane-${lane.index}-deg.jpg`);
      const metadata = await captureNativeStill(lane.electronApp, target);
      nativeStills.push({ path: target, width: metadata.width, height: metadata.height });
    }

    const diagnosticSummary = assertCleanDiagnostics(diagnostics);
    const manifest = {
      completedAt: new Date().toISOString(),
      browser: {
        seuratPipeline: sanitizeBrowserPipeline(browserSeuratPipeline),
        cellChat: sanitizeBrowserCellChat(browserCellChat),
        spatialPipeline: sanitizeBrowserSpatial({ ...browserSpatialPipeline, ...spatialSave }),
        realPipeline: 'browser-real-seurat-pipeline.png',
        realUmap: 'browser-real-umap.png',
        realExploration: 'browser-real-exploration.png',
        realCellChat: 'browser-real-cellchat.png',
        realSpatialPipeline: 'browser-real-spatial-seurat-pipeline.png',
        realSpatialUmap: 'browser-real-spatial-umap.png',
        videoFormat: 'Playwright WebM',
      },
      electron: {
        profiles: 2,
        nativeUmap: { ...nativeUmap, videoPath: path.basename(nativeUmap.videoPath) },
        degStills: nativeStills.map(item => ({ ...item, path: path.basename(item.path) })),
        runsAndResults: lanes.map(lane => `electron-lane-${lane.index}-runs-and-results.png`),
      },
      overlap: sanitizeNativeOverlap(overlap),
      diagnostics: {
        pageErrors: 0, consoleErrors: 0, serverErrors: 0, requestFailures: 0,
        expectedPipelineProbe429: diagnosticSummary.expectedPipelineProbe429,
        expectedBeforeUnloadDialogs: diagnosticSummary.expectedBeforeUnloadDialogs,
      },
    };
    fs.writeFileSync(path.join(runDirectory, 'acceptance.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    acceptanceResult = { runDirectory, manifest };
  } catch (error) {
    primaryError = error;
    fs.writeFileSync(path.join(runDirectory, 'native-ui-failure.json'), `${JSON.stringify({
      capturedAt: new Date().toISOString(),
      error: error && error.message ? error.message : 'Native UI acceptance failed.',
    }, null, 2)}\n`);
  } finally {
    if (browserContext) await browserContext.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    for (const app of electronApps.reverse()) await closeElectronApp(app);
    try {
      await removeTemporaryProfileRoot(tempRoot);
    } catch (error) {
      cleanupError = error;
    }
    for (const lane of lanes) {
      delete lane.electronApp;
      delete lane.page;
      delete lane.password;
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return acceptanceResult;
}

module.exports = { runNativeUiAcceptance };
