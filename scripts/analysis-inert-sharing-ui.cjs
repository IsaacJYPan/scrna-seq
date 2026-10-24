'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = (value, message) => { if (!value) throw new Error(message); };

// This separate imported-source journey follows the full actual-R mixed-family
// journey. These literal files are outside results, not workflow-produced output.
async function verifyInertSharing(context) {
  const { service, database, accounts, api, importFixture, login, restart, openAnalysis, openPublications, openPublic,
    prep, panel, detail, matrix, intercept, faults, faultPaths, expected, requests, check, until } = context;
  let owner = context.page;
  await database.query("UPDATE project_members SET role='owner' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
  owner = await restart();
  const header = '\uFEFF# INERT_VISIBLE_SOURCE_ONLY\r\n<script>window.__inertExecuted=1;fetch("/api/inert-source-executed")</script>\r\ncount <- ncol(obj)\r\nprint("café 🧬")\r\n';
  const sourceText = header + 'Unselected later log line.\r\n'.repeat(1000) + 'C4_UNSELECTED_PRIVATE_SUFFIX';
  const fullJson = '{\r\n  "nested": {"huge": 9007199254740993, "tiny": 1e-400, "label": "café 🧬"},\r\n  "duplicate": 1, "duplicate": 2,\r\n  "literal": "<img src=\"inert-only\" onerror=\"window.__inertExecuted=2\">"\r\n}\r\n';
  // Escape the attribute quotes in the JSON string while keeping its raw numeric
  // spelling, duplicate occurrences, CRLF and nested structure deliberately intact.
  const jsonText = fullJson.replace('src="inert-only" onerror="window.__inertExecuted=2"', 'src=\\"inert-only\\" onerror=\\"window.__inertExecuted=2\\"');
  JSON.parse(jsonText); // Fixture validity only; the app must never parse/rewrite it.
  const importedText = await importFixture(owner, 'Imported literal R notes', 'literal-notes.txt', sourceText);
  const importedJson = await importFixture(owner, 'Imported nested JSON source', 'nested-source.json', jsonText);
  const importedEmpty = await importFixture(owner, 'Imported empty text', 'empty-source.txt', '');
  const reference = value => ({ kind: 'artifact-version', versionId: value.versionId, sha256: value.sha256 });
  const study = (await api(owner, `/api/projects/${service.project.id}/analyses`, { method: 'POST', status: 201, body: {
    requestId: crypto.randomUUID(), name: 'Literal source excerpts', description: 'Inspect deliberately selected outside text without executing or normalizing it.',
    references: [importedText, importedJson, importedEmpty].map(reference),
  } })).analysis;
  const base = `/api/projects/${service.project.id}/analyses/${study.id}`, preparations = `${base}/snapshot-preparations`, publications = `${base}/snapshot-publications`;
  const later = (await api(owner, base, { method: 'PATCH', body: { expectedVersion: study.version, description: 'A later overview remains separate from the exact source selections.' } })).analysis;
  await openAnalysis(owner, study); await owner.getByRole('button', { name: 'Prepare sharing', exact: true }).click();
  let choices = prep(owner).getByRole('form', { name: 'Prepare private snapshot', exact: true });
  const chooseVersion = async version => { await choices.getByRole('radio', { name: new RegExp(`Saved version ${version} ·`) }).check(); };
  await chooseVersion(study.version);
  const linked = () => choices.getByRole('region', { name: `Linked in saved analysis ${study.version}`, exact: true });
  const sourceOptionReads = () => requests.filter(item => item.method === 'GET' && item.pathname === `${preparations}/options` && item.optionKind === 'analysis-inert-references');
  assert(sourceOptionReads().length === 0, 'Source text metadata was loaded before explicit expansion.');
  await linked().getByText('Text and JSON source excerpts (optional)', { exact: true }).click();
  const sourceChoices = linked().getByRole('list', { name: 'Linked text and JSON sources', exact: true });
  await sourceChoices.getByRole('button', { name: 'Select source prefix', exact: true }).first().waitFor();
  assert(sourceOptionReads().length === 1 && sourceOptionReads()[0].optionAnalysisVersion === String(study.version), 'The explicit source-text metadata query did not bind exactly the chosen saved version.');
  assert(!(await choices.getByText('INERT_VISIBLE_SOURCE_ONLY', { exact: false }).count()), 'A chooser read original source text.');
  const selectSource = async (source, position, caption, maxBytes) => {
    await sourceChoices.getByRole('listitem').filter({ has: owner.getByText(source.name, { exact: true }) })
      .getByRole('button', { name: 'Select source prefix', exact: true }).click();
    await linked().getByRole('textbox', { name: `Caption for linked finding ${position}`, exact: true }).fill(caption);
    await linked().getByRole('spinbutton', { name: `Maximum source bytes for linked finding ${position}`, exact: true }).fill(String(maxBytes));
    assert(!(await linked().getByRole('checkbox', { name: `Include source text for linked finding ${position}`, exact: true }).isChecked()), 'A new source selection silently consented to text inclusion.');
  };
  const cutText = header.slice(0, header.indexOf('🧬')), selectedBytes = Buffer.byteLength(cutText) + 2;
  const captions = ['Literal R notes through the last complete character', 'Exact nested JSON source without numeric conversion', 'A one-byte bound with no complete character', 'An honestly empty text source'];
  await selectSource(importedText, 1, captions[0], selectedBytes);
  await selectSource(importedJson, 2, captions[1], 16384);
  await selectSource(importedText, 3, captions[2], 1);
  await selectSource(importedEmpty, 4, captions[3], 16384);
  const beforeConsent = requests.filter(item => item.method === 'POST' && item.pathname === preparations).length;
  await choices.getByRole('button', { name: 'Prepare private preview', exact: true }).click();
  assert(requests.filter(item => item.method === 'POST' && item.pathname === preparations).length === beforeConsent
    && await choices.evaluate(form => !form.checkValidity()), 'Missing explicit source-text inclusion reached the server.');
  for (let position = 1; position <= 4; position++) await linked().getByRole('checkbox', { name: `Include source text for linked finding ${position}`, exact: true }).check();
  await chooseVersion(later.version); assert(!(await choices.getByRole('checkbox', { name: /Include source text for linked finding/ }).count()), 'An older source prefix draft leaked to the later saved version.');
  await chooseVersion(study.version);
  assert(await linked().getByRole('checkbox', { name: 'Include source text for linked finding 1', exact: true }).isChecked()
    && await linked().getByRole('spinbutton', { name: 'Maximum source bytes for linked finding 1', exact: true }).inputValue() === String(selectedBytes), 'Returning to a saved version lost its explicit prefix or consent.');
  await matrix(owner, 'inert-explicit-source-selection-and-consent', () => linked().getByRole('checkbox', { name: 'Include source text for linked finding 1', exact: true }).scrollIntoViewIfNeeded());
  const heldPreparation = intercept({ method: 'POST', pathname: preparations, mode: 'hold' }); faults.push(heldPreparation);
  await choices.getByRole('button', { name: 'Prepare private preview', exact: true }).click();
  await until(() => heldPreparation.observation(), 'The genuine inert preparation acknowledgement was not held.');
  const accepted = heldPreparation.observation();
  assert(accepted.status === 201 && accepted.value?.state === 'ready', 'The genuine source-prefix preparation did not become ready.');
  owner = await restart(); heldPreparation.release();
  await openAnalysis(owner, study); await owner.getByRole('button', { name: 'Prepare sharing', exact: true }).click();
  await prep(owner).getByRole('button', { name: 'Saved preparations', exact: true }).click(); await prep(owner).getByRole('button', { name: 'Open private preparation', exact: true }).click();
  await prep(owner).getByRole('heading', { name: 'Ready for private review', exact: true }).waitFor();
  const candidate = await api(owner, `${preparations}/${accepted.value.preparationId}`);
  assert(candidate.recipe.results.length === 4 && candidate.recipe.results.every(item => item.kind === 'inert-analysis-reference' && item.includeSourceText === true)
    && candidate.package.analysis.version === study.version, 'Recovered source-prefix intent changed its saved version or explicit inclusion.');
  const originalBodies = [], expectedText = [cutText, jsonText, '', ''];
  const selectFinding = async (target, scope, caption) => scope.getByRole('list', { name: 'Retained finding selection', exact: true }).getByRole('button').filter({ hasText: caption }).click();
  for (const [index, result] of candidate.package.results.entries()) {
    const body = await api(owner, `${preparations}/${candidate.preparationId}/views/${result.viewId}`); originalBodies.push(body);
    assert(result.view.schema === 'traceomics.fixed-result-view.v4' && body.text === expectedText[index]
      && body.includedSourceBytes === Buffer.byteLength(expectedText[index]) && body.maxBytes === candidate.recipe.results[index].view.maxBytes
      && body.sourceBytes === result.source.sizeBytes && body.truncated === (body.includedSourceBytes < body.sourceBytes), 'The exact source prefix lost its spelling, BOM, byte bound or truncation facts.');
    await selectFinding(owner, prep(owner), captions[index]);
    const text = prep(owner).getByLabel('Saved text preview', { exact: true }); await text.waitFor();
    assert(await text.textContent() === expectedText[index], 'The actual private text renderer changed the selected source characters.');
    await text.focus(); await owner.keyboard.press('ArrowDown');
    assert(!(await prep(owner).locator('script, img').count()) && await owner.evaluate(() => window.__inertExecuted === undefined), 'Selected code-like source executed or rendered markup.');
    await matrix(owner, `inert-private-exact-${index + 1}`, () => text.scrollIntoViewIfNeeded());
  }
  assert(originalBodies[0].maxBytes - originalBodies[0].includedSourceBytes === 2 && originalBodies[2].includedSourceBytes === 0
    && originalBodies[2].sourceBytes > 0 && originalBodies[2].truncated && originalBodies[3].sourceBytes === 0 && !originalBodies[3].truncated,
  'A multibyte cut, no-complete-character prefix or empty source was misrepresented.');
  check('Explicit source-text inclusion and per-saved-version byte bounds survive a genuine accepted lost reply and browser restart; actual private previews preserve BOM/CRLF/JSON lexemes, escape code, and distinguish empty sources from zero complete characters.');

  await prep(owner).getByRole('button', { name: 'Publish to project', exact: true }).click();
  const confirmation = panel(owner).getByRole('region', { name: 'Confirm exact snapshot publication', exact: true });
  await confirmation.getByText('Selected text and JSON source excerpts are included as plain text. Only the reviewed prefixes are shared; JSON syntax is not checked.', { exact: true }).waitFor();
  await matrix(owner, 'inert-exact-prefix-publication-confirmation', () => confirmation.scrollIntoViewIfNeeded());
  const heldPublish = intercept({ method: 'POST', pathname: publications, mode: 'hold' }); faults.push(heldPublish);
  await confirmation.getByRole('button', { name: 'Publish to project', exact: true }).click(); await until(() => heldPublish.observation(), 'The genuine inert publication reply was not held.');
  const publicationId = heldPublish.observation().value.acceptance.publicationId;
  const originalIntent = requests.filter(item => item.actor === 'owner' && item.method === 'POST' && item.pathname === publications).at(-1).input;
  owner = await restart(); heldPublish.release(); await openPublications(owner, study);
  await panel(owner).getByRole('button', { name: 'Your sharing activity', exact: true }).click();
  await panel(owner).getByRole('button', { name: 'Check accepted sharing action', exact: true }).click(); await panel(owner).getByRole('heading', { name: 'Publication accepted', exact: true }).waitFor();
  assert(requests.filter(item => item.actor === 'owner' && item.method === 'POST' && item.pathname === publications).length === 1, 'Recovering the accepted inert publication submitted another action.');
  for (const imported of [importedText, importedJson, importedEmpty]) {
    const row = (await database.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [imported.versionId])).rows[0];
    const filename = path.resolve(service.storageRoot, ...row.storage_key.split('/'));
    assert(filename.startsWith(path.resolve(service.storageRoot) + path.sep), 'Inert original removal escaped the owned fixture.'); fs.unlinkSync(filename);
  }
  await api(owner, `${preparations}/${candidate.preparationId}`, { method: 'DELETE', body: { requestId: candidate.requestId, requestSha256: candidate.requestSha256 } });
  await api(owner, base, { method: 'PATCH', body: { expectedVersion: later.version, references: [], description: 'New live heads cannot change accepted literal excerpts.' } });
  let colleague = await login('colleague'); await openPublications(colleague, study); await openPublic(colleague);
  const published = await api(colleague, `${publications}/${publicationId}`);
  assert(published.snapshotSha256 === candidate.snapshotSha256 && published.package.analysis.version === study.version, 'The colleague received a newer source-prefix package.');
  const beforeRead = requests.length;
  for (const [index, result] of published.package.results.entries()) {
    assert(JSON.stringify(await api(colleague, `${publications}/${publicationId}/views/${result.viewId}`)) === JSON.stringify(originalBodies[index]), 'A retained source prefix changed after original loss.');
    await api(colleague, `${publications}/${publicationId}/views/${result.viewId}?maxBytes=16384`, { status: 400 });
    await selectFinding(colleague, detail(colleague), captions[index]); const text = detail(colleague).getByLabel('Saved text preview', { exact: true }); await text.waitFor();
    assert(await text.textContent() === expectedText[index] && !(await detail(colleague).locator('script, img').count()), 'Colleague source text was normalized, expanded or rendered as markup.');
    await matrix(colleague, `inert-colleague-source-free-${index + 1}`, () => text.scrollIntoViewIfNeeded());
  }
  assert(!requests.slice(beforeRead).some(item => /\/api\/artifact-versions\//.test(item.pathname)), 'Published source-prefix inspection read an original source.');
  for (const imported of [importedText, importedJson]) await api(colleague, `/api/artifact-versions/${service.project.id}/${imported.versionId}`, { status: 404 });
  await api(colleague, `${preparations}/${candidate.preparationId}`, { status: 404 });
  const audit = (await database.query("SELECT * FROM project_audit_events WHERE project_id=$1 AND action LIKE 'snapshot.%'", [service.project.id])).rows;
  for (const exposed of [JSON.stringify(published), JSON.stringify(audit)]) assert(!exposed.includes('C4_UNSELECTED_PRIVATE_SUFFIX')
    && !exposed.includes('INERT_VISIBLE_SOURCE_ONLY') && !exposed.includes(service.storageRoot), 'Public metadata or audit copied source text, its unselected suffix or private paths.');
  check('A fresh colleague reads the exact imported text and nested JSON after original files, private preparation and live references are removed, with runtime stopped, fixed no-query bounds and no original-source grant or fetch.');

  async function refresh(target) {
    await panel(target).getByRole('button', { name: 'Refresh sharing access', exact: true }).click();
    await until(() => panel(target).getByRole('button', { name: 'Refresh sharing access', exact: true }).isEnabled(), 'Inert sharing access refresh did not settle.');
  }
  await selectFinding(colleague, detail(colleague), captions[1]); await detail(colleague).getByLabel('Saved text preview', { exact: true }).waitFor();
  const heldRead = intercept({ method: 'GET', pathname: `${publications}/${publicationId}/views/${published.package.results[0].viewId}`, mode: 'hold' }); faults.push(heldRead);
  await selectFinding(colleague, detail(colleague), captions[0]); await until(() => heldRead.observation(), 'The authorized literal body was not held for the revocation race.');
  await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, accounts.colleague.id]); expected.add(`404 ${publications}?limit=30`);
  await refresh(colleague); await until(async () => !(await detail(colleague).getByRole('heading', { name: 'Published to this project', exact: true }).count()), 'Revocation retained protected inert content.');
  heldRead.release(); await colleague.waitForTimeout(200); assert(!(await panel(colleague).getByLabel('Saved text preview', { exact: true }).count()), 'An older retained text reply restored revoked content.');
  await matrix(colleague, 'inert-revoked-held-prefix-fenced', () => panel(colleague).scrollIntoViewIfNeeded());
  await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')", [service.project.id, accounts.colleague.id]); await refresh(colleague); await openPublic(colleague);
  const broken = published.package.results[1]; expected.add(`409 ${publications}/${publicationId}/views/${broken.viewId}`);
  // Narrow legacy-retained-corruption fault in this owned disposable fixture.
  try {
    await database.query('BEGIN'); await database.query("SET LOCAL session_replication_role='replica'");
    await database.query('UPDATE research_analysis_snapshot_blobs SET content=set_byte(content,0,(get_byte(content,0)+1)%256) WHERE preparation_id=$1 AND id=$2', [candidate.preparationId, broken.viewId]); await database.query('COMMIT');
  } catch (error) { await database.query('ROLLBACK'); throw error; }
  await detail(colleague).getByRole('button', { name: 'Check current snapshot access', exact: true }).click();
  await selectFinding(colleague, detail(colleague), captions[1]);
  await detail(colleague).getByText('This retained view is unavailable. Its exact saved identity is kept and has not been regenerated.', { exact: true }).waitFor();
  await matrix(colleague, 'inert-corruption-preserves-acceptance-no-regeneration', () => detail(colleague).getByRole('region', { name: 'Retained prepared finding', exact: true }).scrollIntoViewIfNeeded());
  check('Current membership revocation fences a held literal-body success; corrupt retained JSON preserves acceptance and other findings without reading, rebuilding or normalizing originals.');

  await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
  owner = await restart(); await openPublications(owner, study); await openPublic(owner);
  colleague = await login('colleague'); await openPublications(colleague, study); await openPublic(colleague);
  await selectFinding(colleague, detail(colleague), captions[2]); await detail(colleague).getByLabel('Saved text preview', { exact: true }).waitFor();
  const older = intercept({ method: 'GET', pathname: `${publications}/${publicationId}/views/${published.package.results[0].viewId}`, mode: 'hold' }); faults.push(older);
  await selectFinding(colleague, detail(colleague), captions[0]); await until(() => older.observation(), 'The authorized literal body was not held before withdrawal.');
  await detail(owner).getByRole('button', { name: 'Withdraw from project', exact: true }).click();
  const drop = intercept({ method: 'POST', pathname: `${publications}/${publicationId}/withdrawals`, mode: 'drop' }); faults.push(drop); faultPaths.add(`${publications}/${publicationId}/withdrawals`);
  await panel(owner).getByRole('button', { name: 'Confirm withdrawal', exact: true }).click(); await until(() => drop.observation(), 'The inert withdrawal acknowledgement was not dropped.');
  await refresh(colleague); await detail(colleague).getByRole('heading', { name: 'Snapshot withdrawn', exact: true }).waitFor();
  older.release(); await colleague.waitForTimeout(200); assert(!(await detail(colleague).getByLabel('Saved text preview', { exact: true }).count()), 'An older literal body restored withdrawn content.');
  await panel(owner).getByRole('region', { name: 'Original sharing request', exact: true }).getByRole('button', { name: 'Check original sharing request', exact: true }).click();
  await panel(owner).getByRole('heading', { name: 'Withdrawal accepted', exact: true }).waitFor();
  await matrix(owner, 'inert-reader-publisher-withdrawal-recovered', () => panel(owner).getByRole('region', { name: 'Accepted sharing action', exact: true }).scrollIntoViewIfNeeded());
  await matrix(colleague, 'inert-colleague-withdrawn-literal-tombstone', () => detail(colleague).scrollIntoViewIfNeeded());
  const replay = await api(owner, publications, { method: 'POST', body: originalIntent });
  assert(replay.current.policy.state === 'withdrawn' && replay.current.package === null
    && !(await database.query('SELECT 1 FROM research_analysis_snapshot_blobs WHERE preparation_id=$1', [candidate.preparationId])).rowCount, 'Inert replay reactivated content or withdrawal kept the final unneeded retained lease.');
  for (const target of [owner, colleague]) {
    const stored = await target.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).join('\n'));
    assert(!/INERT_VISIBLE_SOURCE_ONLY|C4_UNSELECTED_PRIVATE_SUFFIX|9007199254740993/.test(stored) && !stored.includes(candidate.requestId)
      && await target.evaluate(() => window.__inertExecuted === undefined), 'Literal source entered browser storage or executed.');
  }
  assert(!requests.some(item => item.pathname === '/api/inert-source-executed')
    && requests.filter(item => item.method === 'POST' && item.pathname === preparations).length === 1
    && (await database.query('SELECT count(*)::int AS n FROM research_analysis_snapshot_publications WHERE analysis_id=$1', [study.id])).rows[0].n === 1,
  'Inert inspection executed source or duplicated the original preparation/publication.');
  check('A downgraded source-text publisher recovers a genuinely lost withdrawal reply; held literal bodies stay fenced, final leases release, replay never reactivates content, and scientific text stays out of browser persistence.');
}

module.exports = { verifyInertSharing };
