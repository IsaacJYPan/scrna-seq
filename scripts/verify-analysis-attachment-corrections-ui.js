#!/usr/bin/env node
'use strict';

// Extend the genuine attachment browser fixture with correction/history
// journeys. Synthetic table/figure bytes remain private managed sources.
async function verifyCorrections(env) {
  const { service, database, page, study, table, figure, accounts, requests, faults, baselineAttachment,
    region, details, api, login, openAnalysis, openOutside, prepare, submit, closeDetails, theme, capture, matrix, until, assert, check, attachmentPath, expectedDiagnostics, faultPaths } = env;
  const acceptedIds = new Set();
  const correctionForm = target => region(target).getByRole('form', { name: 'Correct outside result', exact: true });
  const cards = target => region(target).getByRole('list', { name: 'Attached outside results', exact: true });
  const card = (target, caption) => cards(target).getByRole('listitem').filter({ has: target.getByText(caption, { exact: true }) });
  const revisionsPath = attachmentId => `${attachmentPath()}/${attachmentId}/revisions`;
  const record = value => { acceptedIds.add(value.acceptedRevision.id); return value; };
  async function start(target, caption) { await closeDetails(target); await card(target, caption).getByRole('button', { name: 'Correct caption or source', exact: true }).click(); await correctionForm(target).waitFor(); }
  async function note(target, label, text) {
    const summary = correctionForm(target).locator('summary').filter({ hasText: 'Add supplied origin and references (optional)' });
    if (!(await summary.locator('..').evaluate(node => node.open))) await summary.click();
    await correctionForm(target).getByLabel(label, { exact: true }).fill(text);
  }
  async function save(target, attachmentId, expected = 201) {
    const pathname = revisionsPath(attachmentId); if (expected >= 400) expectedDiagnostics.add(`${expected} ${pathname}`);
    const waiting = target.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === 'POST');
    await correctionForm(target).getByRole('button', { name: 'Save correction', exact: true }).click();
    const response = await waiting, value = await response.json(); assert(response.status() === expected, `An actual correction returned status ${response.status()} instead of ${expected}.`);
    if (response.ok()) { record(value); await region(target).getByRole('region', { name: 'Attachment confirmed', exact: true }).waitFor(); }
    return value;
  }
  async function refresh(target, caption) {
    const waiting = target.waitForResponse(response => new URL(response.url()).pathname === attachmentPath() && response.request().method() === 'GET');
    await region(target).getByRole('button', { name: 'Refresh results', exact: true }).click(); await waiting; await card(target, caption).waitFor();
  }
  async function history(target) {
    const summary = details(target).locator('summary').filter({ hasText: /^Saved revisions$/ });
    if (!(await summary.locator('..').evaluate(node => node.open))) await summary.click();
    await details(target).getByRole('list', { name: 'Attachment revision history', exact: true }).getByRole('listitem').first().waitFor();
  }
  async function openSaved(target, attachmentId, revision) {
    const waiting = target.waitForResponse(response => new URL(response.url()).pathname === `${revisionsPath(attachmentId)}/${revision.id}`);
    await details(target).getByRole('button', { name: `Open revision ${revision.revisionNumber}`, exact: true }).click();
    const value = await (await waiting).json();
    assert(value.revision.id === revision.id && value.revision.reference.versionId === revision.reference.versionId && value.revision.reference.sha256 === revision.reference.sha256, 'Opening a historical revision substituted a different source.');
    await details(target).getByRole('heading', { name: revision.caption, exact: true }).waitFor(); return value;
  }

  await closeDetails(page); await page.setViewportSize({ width: 1366, height: 768 }); await theme(page, 'light');
  const originalCaption = 'Correction history fixture: original CSV evidence.';
  await prepare(page, table, originalCaption, { 'Where this result came from': 'Original supplied context.', 'Supporting document reference': 'Original document citation.' });
  const first = record(await submit(page)), attachmentId = first.attachment.id;
  await start(page, originalCaption);
  await correctionForm(page).getByLabel('Result caption', { exact: true }).fill('Owner correction: clarify the original sample table.');
  const second = await save(page, attachmentId);
  assert(second.acceptedRevision.revisionNumber === 2 && second.acceptedRevision.previousRevisionId === first.acceptedRevision.id && second.acceptedRevision.reference.sha256 === table.sha256, 'A caption correction did not append against its exact predecessor.');
  await region(page).getByRole('button', { name: 'Inspect saved correction', exact: true }).click(); await history(page);
  await matrix(page, 'correction-history', () => details(page).getByRole('list', { name: 'Attachment revision history', exact: true }).scrollIntoViewIfNeeded());
  await openSaved(page, attachmentId, first.acceptedRevision); await details(page).getByRole('cell', { name: 'one, two', exact: true }).waitFor();
  await matrix(page, 'original-csv-revision', () => details(page).getByRole('table').scrollIntoViewIfNeeded());
  check('An actual caption correction appends an exact predecessor-bound revision; history opens the original caption, supplied context and checked CSV bytes in both themes and laptop/phone layouts.');

  await database.query("UPDATE project_members SET role='analyst' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.colleague.id]);
  const colleague = await login('colleague'); await openAnalysis(colleague, study); await openOutside(colleague);
  const sourceReads = requests.filter(item => item.actor === 'colleague' && /\/artifact-versions\//.test(item.pathname)).length;
  await start(colleague, second.acceptedRevision.caption);
  await correctionForm(colleague).getByLabel('Result caption', { exact: true }).fill('Colleague correction: better interpretation without private data access.');
  const third = await save(colleague, attachmentId);
  assert(third.acceptedSourceAccess === 'restricted' && third.attachment.sourceAccess === 'restricted' && third.acceptedRevision.createdByUserId === accounts.colleague.id, 'A collaborator caption correction acquired private source ownership.');
  await region(colleague).getByRole('button', { name: 'Inspect saved correction', exact: true }).click();
  await details(colleague).getByText('This source remains private to its owner. The attachment has not granted access to the file.', { exact: true }).waitFor();
  await matrix(colleague, 'collaborator-correction-private-source');
  assert(requests.filter(item => item.actor === 'colleague' && /\/artifact-versions\//.test(item.pathname)).length === sourceReads, 'A caption-only collaborator correction read another owner\'s file.');
  const ownedThird = await api(page, `${revisionsPath(attachmentId)}/${third.acceptedRevision.id}`);
  assert(ownedThird.sourceAccess === 'available', 'The revision author replaced the original source owner.');
  check('A real second-account analyst corrects supplied context while private source ownership and byte access stay with the original owner.');

  await page.setViewportSize({ width: 1366, height: 768 });
  await region(page).getByRole('button', { name: 'Attach outside result', exact: true }).waitFor();
  await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
  await history(page); await details(page).getByRole('button', { name: 'Refresh revisions', exact: true }).click();
  await until(async () => !(await region(page).getByRole('button', { name: 'Attach outside result', exact: true }).count()), 'A fresh history read left stale writer controls after a real downgrade.');
  assert(await details(page).getByRole('cell', { name: 'one, two', exact: true }).isVisible(), 'A read-only history response removed permitted original evidence.');
  await capture(page, 'fresh-history-read-disables-stale-writer');
  await database.query("UPDATE project_members SET role='owner' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
  await refresh(page, third.acceptedRevision.caption);
  await region(page).getByRole('button', { name: 'Attach outside result', exact: true }).waitFor();
  await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
  await history(page); await openSaved(page, attachmentId, first.acceptedRevision);
  await until(async () => !(await region(page).getByRole('button', { name: 'Attach outside result', exact: true }).count()), 'A fresh exact revision read left stale writer controls after a real downgrade.');
  await capture(page, 'fresh-exact-read-disables-stale-writer');
  await database.query("UPDATE project_members SET role='owner' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
  check('Fresh history and exact-revision reads apply actual downgraded write authority while preserving permitted private evidence; an explicit catalog refresh can observe restored access.');

  await closeDetails(page); await refresh(page, third.acceptedRevision.caption); await start(page, third.acceptedRevision.caption);
  const intended = 'Owner keeps this deliberate caption while reconciling a competing edit.';
  await correctionForm(page).getByLabel('Result caption', { exact: true }).fill(intended); await note(page, 'Where this result came from', 'Owner deliberately changed this origin note.');
  await start(colleague, third.acceptedRevision.caption); await note(colleague, 'Supporting document reference', 'Newer colleague document citation retained on rebase.');
  const fourth = await save(colleague, attachmentId);
  await save(page, attachmentId, 409);
  assert(await correctionForm(page).getByLabel('Result caption', { exact: true }).inputValue() === intended, 'A competing edit discarded the researcher\'s caption.');
  await matrix(page, 'correction-conflict-keeps-draft', () => region(page).getByRole('region', { name: 'Newer attachment revision', exact: true }).scrollIntoViewIfNeeded());
  await region(page).getByRole('button', { name: 'Keep my edits with latest revision', exact: true }).click();
  assert(await correctionForm(page).getByLabel('Supporting document reference', { exact: true }).inputValue() === 'Newer colleague document citation retained on rebase.', 'Reconciliation did not adopt untouched newer context.');
  const fifth = await save(page, attachmentId);
  assert(fifth.acceptedRevision.previousRevisionId === fourth.acceptedRevision.id && fifth.acceptedRevision.caption === intended && fifth.acceptedRevision.suppliedOrigin.origin === 'Owner deliberately changed this origin note.', 'Deliberate reconciliation did not preserve edits or bind the new expected head.');
  check('A genuine competing correction produces an exact-head conflict; deliberate reconciliation preserves edited caption/origin and adopts untouched newer context before another save.');

  await start(page, fifth.acceptedRevision.caption); await correctionForm(page).getByRole('button', { name: 'Choose saved file', exact: true }).click();
  await correctionForm(page).getByRole('radio', { name: new RegExp(figure.name) }).check();
  await correctionForm(page).getByLabel('Result caption', { exact: true }).fill('Owner source correction: retain the supplied raster as new evidence.');
  const sixth = await save(page, attachmentId);
  assert(sixth.acceptedRevision.reference.versionId === figure.versionId && sixth.acceptedRevision.reference.sha256 === figure.sha256, 'A source correction failed to bind the exact new managed figure.');
  await region(page).getByRole('button', { name: 'Inspect saved correction', exact: true }).click();
  const image = details(page).getByRole('img', { name: /Preview of Synthetic supplied heatmap/ }); await image.waitFor();
  assert(await image.evaluate(node => node.complete && node.naturalWidth === 480), 'The corrected exact raster failed real decoding.');
  await history(page); await openSaved(page, attachmentId, first.acceptedRevision); await details(page).getByRole('cell', { name: 'one, two', exact: true }).waitFor();
  assert((await api(page, `${attachmentPath()}/requests/${first.requestId}`)).attachment.headRevisionId === sixth.acceptedRevision.id, 'Inspecting the original revision rolled back the current source.');
  check('Changing a source retains an exact new PNG version while original history still verifies the earlier CSV bytes; opening old evidence never moves the current head.');

  await closeDetails(page); await start(page, sixth.acceptedRevision.caption);
  const lostCaption = 'Original accepted correction with a genuinely lost acknowledgement.';
  await correctionForm(page).getByLabel('Result caption', { exact: true }).fill(lostCaption);
  const lost = service.interceptNextResponse({ method: 'POST', pathname: revisionsPath(attachmentId), mode: 'drop' }); faults.push(lost); faultPaths.add(revisionsPath(attachmentId));
  await correctionForm(page).getByRole('button', { name: 'Save correction', exact: true }).click(); await until(() => lost.observation(), 'The real correction acknowledgement was not dropped after acceptance.');
  const input = requests.filter(item => item.method === 'POST' && item.pathname === revisionsPath(attachmentId) && item.actor === 'owner').at(-1).input;
  const recovery = region(page).getByRole('region', { name: 'Attachment recovery', exact: true });
  await until(() => recovery.getByRole('button', { name: 'Check attachment outcome', exact: true }).isEnabled(), 'Lost correction did not retain its original frozen request.');
  await closeDetails(colleague); await refresh(colleague, lostCaption); await start(colleague, lostCaption);
  await correctionForm(colleague).getByLabel('Result caption', { exact: true }).fill('Newer colleague correction is current after the lost acknowledgement.');
  const eighth = await save(colleague, attachmentId);
  await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === `${attachmentPath()}/requests/${input.requestId}`);
  await recovery.getByRole('button', { name: 'Check attachment outcome', exact: true }).click(); const seventh = record(await (await waiting).json());
  await region(page).getByRole('region', { name: 'Attachment confirmed', exact: true }).waitFor();
  assert(seventh.canWrite === false && seventh.acceptedRevision.revisionNumber === 7 && seventh.acceptedRevision.caption === lostCaption && seventh.attachment.headRevisionId === eighth.acceptedRevision.id, 'Recovery substituted the current head for the original accepted correction.');
  await region(page).getByText('A newer revision is current. This receipt confirms the original saved revision.', { exact: true }).waitFor();
  await region(page).getByRole('button', { name: 'Inspect saved correction', exact: true }).click();
  await details(page).getByRole('heading', { name: lostCaption, exact: true }).waitFor(); await details(page).getByRole('img').waitFor();
  await matrix(page, 'recovered-old-correction-current-reader', () => details(page).getByRole('heading', { name: lostCaption, exact: true }).scrollIntoViewIfNeeded());
  assert(!(await region(page).getByRole('button', { name: 'Attach outside result', exact: true }).count()), 'Recovering an old correction restored fresh writer controls.');
  const retained = await api(page, `${attachmentPath()}/requests/${input.requestId}`); assert(retained.attachment.headRevisionId === eighth.acceptedRevision.id, 'Old accepted correction recovery moved the current head backwards.');
  check('A genuinely accepted lost correction is recovered after a newer second-account correction and owner-to-reader downgrade; the UI opens the original accepted revision, preserves the newer head and grants no write authority.');

  await page.setViewportSize({ width: 1366, height: 768 }); await history(page);
  const delayed = service.interceptNextResponse({ method: 'GET', pathname: `${revisionsPath(attachmentId)}/${first.acceptedRevision.id}`, mode: 'hold' }); faults.push(delayed);
  await details(page).getByRole('button', { name: 'Open revision 1', exact: true }).click(); await until(() => delayed.observation(), 'The exact historical read was not genuinely held.');
  await card(page, baselineAttachment.acceptedRevision.caption).getByRole('button', { name: 'Inspect result and context', exact: true }).click(); await details(page).getByRole('cell', { name: 'one, two', exact: true }).waitFor(); delayed.release();
  await page.waitForTimeout(350); assert(await details(page).getByRole('heading', { name: baselineAttachment.acceptedRevision.caption, exact: true }).isVisible(), 'A late history read redirected the newer selected result.');
  await capture(page, 'late-historical-read-keeps-newer-selection');
  await database.query("UPDATE project_members SET role='owner' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
  await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.colleague.id]);
  await closeDetails(page); await refresh(page, eighth.acceptedRevision.caption);
  await start(page, eighth.acceptedRevision.caption);
  const lastCaption = 'Accepted correction stays recoverable after a fresh read-only catalog fences its old reply.';
  await correctionForm(page).getByLabel('Result caption', { exact: true }).fill(lastCaption);
  const readonly = service.interceptNextResponse({ method: 'POST', pathname: revisionsPath(attachmentId), mode: 'hold' }); faults.push(readonly);
  await correctionForm(page).getByRole('button', { name: 'Save correction', exact: true }).click(); await until(() => readonly.observation(), 'The final genuine accepted correction acknowledgement was not held.');
  const readonlyInput = requests.filter(item => item.method === 'POST' && item.pathname === revisionsPath(attachmentId) && item.actor === 'owner').at(-1).input;
  await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
  await refresh(page, lastCaption);
  await until(() => recovery.getByRole('button', { name: 'Check attachment outcome', exact: true }).isEnabled(), 'A fresh read-only catalog did not fence the older correction acknowledgement.');
  readonly.release(); await page.waitForTimeout(350);
  assert(!(await region(page).getByRole('button', { name: 'Attach outside result', exact: true }).count()) && !(await region(page).getByRole('region', { name: 'Attachment confirmed', exact: true }).count()), 'An older accepted correction restored writer controls after a current read-only catalog.');
  await capture(page, 'fresh-readonly-catalog-fences-held-correction');
  const reading = page.waitForResponse(response => new URL(response.url()).pathname === `${attachmentPath()}/requests/${readonlyInput.requestId}`);
  await recovery.getByRole('button', { name: 'Check attachment outcome', exact: true }).click(); const ninth = record(await (await reading).json());
  await region(page).getByRole('region', { name: 'Attachment confirmed', exact: true }).waitFor();
  assert(ninth.canWrite === false && ninth.acceptedRevision.revisionNumber === 9 && ninth.acceptedRevision.caption === lastCaption, 'A read-only catalog fence lost or changed the original accepted correction.');
  check('A genuine read-only catalog response fences an older held accepted correction without erasing readable evidence or its pending UUID; deliberate receipt recovery confirms the original ninth revision without renewed writes.');
  const rows = await database.query('SELECT id,revision_number,source_owner_user_id,actor_user_id FROM research_analysis_attachment_revisions WHERE attachment_id=$1 ORDER BY revision_number', [attachmentId]);
  assert(rows.rows.length === 9 && rows.rows.every(row => Number(row.source_owner_user_id) === accounts.owner.id) && Number(rows.rows[2].actor_user_id) === accounts.colleague.id, 'Immutable history lost a revision or conflated authorship and source ownership.');
  assert(acceptedIds.size === 9, 'The correction fixture did not account for every genuine accepted revision.');
  await database.query("UPDATE project_members SET role='owner' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
  await closeDetails(page); await refresh(page, ninth.acceptedRevision.caption); await until(() => region(page).getByRole('button', { name: 'Attach outside result', exact: true }).isVisible(), 'The restored writer could not continue the original baseline checks.');
  check('A genuine late historical response preserves the newer selection, while all nine immutable revisions retain the independent original source owner.');
  return acceptedIds.size;
}

if (require.main === module) require('./verify-analysis-attachments-ui').main({ verifyCorrections }).catch(failure => { console.error(failure.message); process.exitCode = 1; });
module.exports = { verifyCorrections };
