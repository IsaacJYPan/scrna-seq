#!/usr/bin/env node
'use strict';

// Comments exercise actual project accounts, exact retained revisions and
// durable receipts. Synthetic evidence uses the existing private fixture.
const crypto = require('node:crypto');
const { verifyCorrections } = require('./verify-analysis-attachment-corrections-ui');

async function verifyDiscussion(env) {
  const { service, database, page, study, table, accounts, requests, faults, region, details, api, login,
    openAnalysis, openOutside, prepare, submit, closeDetails, theme, capture, matrix, until, assert, check, attachmentPath, expectedDiagnostics, faultPaths } = env;
  const acceptedIds = new Set();
  const discussion = (target, number) => details(target).getByRole('region', { name: `Discussion for revision ${number}`, exact: true });
  const comments = (target, number) => discussion(target, number).getByRole('list', { name: 'Revision comments', exact: true });
  const editor = (target, number) => discussion(target, number).getByRole('textbox', { name: 'Comment on this revision', exact: true });
  const recovery = (target, number) => discussion(target, number).getByRole('region', { name: 'Comment recovery', exact: true });
  const card = (target, caption) => region(target).getByRole('list', { name: 'Attached outside results', exact: true }).getByRole('listitem').filter({ has: target.getByText(caption, { exact: true }) });
  const commentPath = revision => `${attachmentPath()}/${revision.attachmentId}/revisions/${revision.id}/comments`;
  const receiptPath = input => `${attachmentPath()}/comment-requests/${input.requestId}`;
  const analysisPath = attachmentPath().replace(/\/attachments$/, '');
  let analysisVersion = 1;
  const record = value => { acceptedIds.add(value.comment.id); return value; };
  const latestInput = (actor, revision) => requests.filter(item => item.actor === actor && item.method === 'POST' && item.pathname === commentPath(revision)).at(-1)?.input;
  async function inspect(target, caption, number) {
    await closeDetails(target); await card(target, caption).getByRole('button', { name: 'Inspect result and context', exact: true }).click();
    await until(() => discussion(target, number).getByRole('button', { name: 'Refresh discussion', exact: true }).isEnabled(), 'Discussion did not finish its real read.');
  }
  async function history(target) {
    const summary = details(target).locator('summary').filter({ hasText: /^Saved revisions$/ });
    if (!(await summary.locator('..').evaluate(node => node.open))) await summary.click();
    await details(target).getByRole('list', { name: 'Attachment revision history', exact: true }).getByRole('listitem').first().waitFor();
  }
  async function openRevision(target, revision) {
    await history(target); await details(target).getByRole('button', { name: `Open revision ${revision.revisionNumber}`, exact: true }).click();
    await details(target).getByRole('heading', { name: revision.caption, exact: true }).waitFor();
    await until(() => discussion(target, revision.revisionNumber).getByRole('button', { name: 'Refresh discussion', exact: true }).isEnabled(), 'The selected exact revision discussion did not load.');
  }
  async function post(target, revision, body) {
    await editor(target, revision.revisionNumber).fill(body);
    const waiting = target.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === commentPath(revision));
    await discussion(target, revision.revisionNumber).getByRole('button', { name: 'Post comment', exact: true }).click();
    const response = await waiting; assert(response.status() === 201, 'A fresh real comment was not accepted once.');
    const value = record(await response.json());
    await comments(target, revision.revisionNumber).getByText(value.comment.body, { exact: true }).waitFor(); return value;
  }
  async function refreshDiscussion(target, revision) {
    const waiting = target.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === commentPath(revision));
    await discussion(target, revision.revisionNumber).getByRole('button', { name: 'Refresh discussion', exact: true }).click();
    const result = await (await waiting).json();
    await until(() => discussion(target, revision.revisionNumber).getByRole('button', { name: 'Refresh discussion', exact: true }).isEnabled(), 'Refreshing discussion left loading stuck.'); return result;
  }
  async function recover(target, revision, input) {
    const waiting = target.waitForResponse(response => new URL(response.url()).pathname === receiptPath(input));
    await recovery(target, revision.revisionNumber).getByRole('button', { name: 'Check comment outcome', exact: true }).click();
    const value = record(await (await waiting).json());
    await discussion(target, revision.revisionNumber).getByText(`Your comment is saved on revision ${revision.revisionNumber}.`, { exact: true }).waitFor(); return value;
  }
  async function setStatus(status) {
    const current = (await api(page, analysisPath)).analysis;
    assert(current.version === analysisVersion, 'Discussion unexpectedly advanced the analysis draft.');
    const result = await api(page, analysisPath, { method: 'PATCH', body: { expectedVersion: current.version, status } });
    assert(result.analysis.status === status && result.analysis.version === current.version + 1, 'Explicit archive/restoration did not create exactly one analysis revision.');
    analysisVersion = result.analysis.version;
  }

  await closeDetails(page); await page.setViewportSize({ width: 1366, height: 768 }); await theme(page, 'light');
  const caption = 'Discussion fixture: original sample summary.';
  await prepare(page, table, caption); const created = await submit(page), first = created.acceptedRevision;
  await region(page).getByRole('button', { name: 'Inspect attached result', exact: true }).click();
  await editor(page, 1).waitFor();
  const ownerBody = 'Could we verify both condition labels?\n<img src=x onerror=alert(1)> is plain text here.';
  await post(page, first, ownerBody);
  assert(await discussion(page, 1).locator('img,iframe,script').count() === 0, 'Plain discussion text rendered executable or embedded content.');
  const colleague = await login('colleague'); await openAnalysis(colleague, study); await openOutside(colleague);
  const beforeSourceReads = requests.filter(item => item.actor === 'colleague' && /\/artifact-versions\//.test(item.pathname)).length;
  await inspect(colleague, caption, 1);
  assert(!(await region(colleague).getByRole('button', { name: 'Attach outside result', exact: true }).count()), 'A current project reader gained evidence write controls.');
  await comments(colleague, 1).getByText(ownerBody, { exact: true }).waitFor();
  await post(colleague, first, 'Reader discussion: the supplied table helps check the experimental groups.');
  await matrix(colleague, 'reader-private-source-discussion', () => discussion(colleague, 1).getByRole('heading', { name: /^Discussion/ }).scrollIntoViewIfNeeded());
  assert(requests.filter(item => item.actor === 'colleague' && /\/artifact-versions\//.test(item.pathname)).length === beforeSourceReads, 'Discussion fetched private source bytes for a project reader.');
  check('Two genuine accounts discuss the exact first revision; project readers see captured authors and plain multiline text without evidence write authority, executable markup or private source requests.');

  const draftOne = 'Unsubmitted observation specific to original revision one.';
  const draftTwo = 'Independent unsent observation specific to corrected revision two.';
  await editor(page, 1).fill(draftOne); await closeDetails(page);
  await card(page, caption).getByRole('button', { name: 'Correct caption or source', exact: true }).click();
  const correction = region(page).getByRole('form', { name: 'Correct outside result', exact: true });
  const newCaption = 'Discussion fixture: corrected interpretation, same exact sample source.';
  await correction.getByLabel('Result caption', { exact: true }).fill(newCaption);
  const waitingCorrection = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${attachmentPath()}/${first.attachmentId}/revisions`);
  await correction.getByRole('button', { name: 'Save correction', exact: true }).click();
  const changed = await (await waitingCorrection).json(), second = changed.acceptedRevision;
  assert(second.revisionNumber === 2 && second.previousRevisionId === first.id, 'The discussion fixture did not retain a genuine predecessor-bound correction.');
  await region(page).getByRole('button', { name: 'Inspect saved correction', exact: true }).click();
  await discussion(page, 2).getByText('No comments on this revision yet.', { exact: true }).waitFor();
  await editor(page, 2).fill(draftTwo); await openRevision(page, first);
  assert(await editor(page, 1).inputValue() === draftOne, 'Switching revisions discarded the original comment draft.');
  await comments(page, 1).getByText(ownerBody, { exact: true }).waitFor();
  const older = await post(page, first, draftOne);
  assert(older.revisionId === first.id && older.headRevisionId === second.id && older.comment.revisionId === first.id, 'Commenting on earlier evidence followed the current head.');
  await openRevision(page, second); assert(await editor(page, 2).inputValue() === draftTwo, 'Earlier discussion overwrote a different revision draft.');
  await discussion(page, 2).getByText('No comments on this revision yet.', { exact: true }).waitFor();
  await matrix(page, 'new-revision-separate-draft', () => discussion(page, 2).getByRole('form').scrollIntoViewIfNeeded());
  await openRevision(page, first);
  await matrix(page, 'original-revision-retained-discussion', () => comments(page, 1).scrollIntoViewIfNeeded());
  check('A genuine correction starts a separate discussion; old comments stay on revision one, current-head context never retargets a comment, and unsent drafts remain independent while navigating both revisions.');

  const lostBody = 'Accepted earlier-revision comment with an actually lost acknowledgement.';
  await editor(page, 1).fill(lostBody);
  const lost = service.interceptNextResponse({ method: 'POST', pathname: commentPath(first), mode: 'drop' }); faults.push(lost); faultPaths.add(commentPath(first));
  await discussion(page, 1).getByRole('button', { name: 'Post comment', exact: true }).click();
  await until(() => lost.observation(), 'The genuine comment acknowledgement was not dropped after acceptance.');
  const lostInput = latestInput('owner', first); assert(lostInput?.requestId, 'The browser did not freeze the original comment UUID.');
  await until(() => recovery(page, 1).getByRole('button', { name: 'Check comment outcome', exact: true }).isEnabled(), 'A lost acknowledgement did not expose explicit recovery.');
  await openRevision(page, second); assert(await editor(page, 2).inputValue() === draftTwo, 'A pending earlier comment stole the later draft.');
  await openRevision(page, first); await recovery(page, 1).getByText(lostBody, { exact: true }).waitFor();
  await setStatus('archived');
  const archived = await refreshDiscussion(page, first); assert(archived.canComment === false, 'A fresh archived analysis read retained comment authority.');
  const recovered = await recover(page, first, lostInput);
  assert(recovered.comment.body === lostBody && recovered.comment.revisionId === first.id && recovered.canComment === false && recovered.headRevisionId === second.id, 'Archived recovery changed the original accepted comment or authority.');
  assert(await editor(page, 1).isDisabled(), 'An accepted original receipt reopened comments on an archived analysis.');
  await matrix(page, 'archived-original-comment-recovery', () => discussion(page, 1).getByRole('form').scrollIntoViewIfNeeded());
  await setStatus('active'); await refreshDiscussion(page, first);
  check('An actual accepted lost comment keeps its frozen revision and UUID across navigation; an archived analysis can recover that original receipt without allowing fresh comments or moving newer evidence.');

  await openRevision(page, second);
  let aborted = false;
  const abortComment = async route => {
    if (!aborted && route.request().method() === 'POST' && new URL(route.request().url()).pathname === commentPath(second)) { aborted = true; await route.abort('failed'); }
    else await route.continue();
  };
  await page.route('**/comments', abortComment); faultPaths.add(commentPath(second));
  await editor(page, 2).fill('A deliberately retried comment must keep the same exact target and UUID.');
  await discussion(page, 2).getByRole('button', { name: 'Post comment', exact: true }).click();
  await until(() => recovery(page, 2).getByRole('button', { name: 'Check comment outcome', exact: true }).isEnabled(), 'The upstream abort did not retain the original comment.');
  await page.unroute('**/comments', abortComment);
  const original = latestInput('owner', second); expectedDiagnostics.add(`404 ${receiptPath(original)}`);
  await recovery(page, 2).getByRole('button', { name: 'Check comment outcome', exact: true }).click();
  await recovery(page, 2).getByRole('button', { name: 'Retry original comment', exact: true }).waitFor();
  const attempts = requests.filter(item => item.method === 'POST' && item.pathname === commentPath(second)).length;
  await matrix(page, 'unconfirmed-revision-comment', () => recovery(page, 2).scrollIntoViewIfNeeded());
  assert(requests.filter(item => item.method === 'POST' && item.pathname === commentPath(second)).length === attempts, 'A comment status check or layout change automatically posted again.');
  const retried = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === commentPath(second));
  await recovery(page, 2).getByRole('button', { name: 'Retry original comment', exact: true }).click();
  record(await (await retried).json()); await comments(page, 2).getByText(original.body, { exact: true }).waitFor();
  assert(JSON.stringify(latestInput('owner', second)) === JSON.stringify(original), 'Deliberate retry changed the original comment request or revision target.');
  check('A real upstream abort followed by a missing owner receipt stays unconfirmed; only deliberate retry submits the identical frozen comment UUID, body and revision.');

  await editor(page, 2).fill('Accepted comment whose held reply must be fenced by a fresh archived read.');
  const held = service.interceptNextResponse({ method: 'POST', pathname: commentPath(second), mode: 'hold' }); faults.push(held);
  await discussion(page, 2).getByRole('button', { name: 'Post comment', exact: true }).click(); await until(() => held.observation(), 'The real accepted comment reply was not held.');
  const heldInput = latestInput('owner', second);
  await setStatus('archived'); await refreshDiscussion(page, second);
  held.release(); await page.waitForTimeout(350);
  assert(await recovery(page, 2).getByRole('button', { name: 'Check comment outcome', exact: true }).isEnabled(), 'An older held reply erased pending recovery after current comment authority was removed.');
  assert(!(await discussion(page, 2).getByText('Your comment is saved on revision 2.', { exact: true }).count()), 'The stale held reply confirmed itself after the fresh archived read.');
  await capture(page, 'fresh-archived-read-fences-comment-reply');
  const heldReceipt = await recover(page, second, heldInput); assert(heldReceipt.canComment === false, 'Original comment receipt restored stale comment authority.');
  await setStatus('active'); await refreshDiscussion(page, second);
  check('A genuinely newer archived discussion read cancels an older accepted response without losing its UUID; explicit recovery keeps the current read-only authority.');

  const deniedBody = 'Original accepted comment remains recoverable after current membership returns.';
  await editor(page, 2).fill(deniedBody);
  const heldDenial = service.interceptNextResponse({ method: 'POST', pathname: commentPath(second), mode: 'hold' }); faults.push(heldDenial);
  await discussion(page, 2).getByRole('button', { name: 'Post comment', exact: true }).click(); await until(() => heldDenial.observation(), 'The denial fixture did not hold an actual accepted response.');
  const deniedInput = latestInput('owner', second);
  await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, accounts.owner.id]);
  expectedDiagnostics.add(`404 ${commentPath(second)}?limit=30`);
  await discussion(page, 2).getByRole('button', { name: 'Refresh discussion', exact: true }).click();
  await until(async () => !(await details(page).count()), 'Current membership denial retained protected discussion details.');
  heldDenial.release(); await page.waitForTimeout(350);
  assert(!(await region(page).getByText(deniedBody, { exact: true }).count()), 'The older accepted response restored protected discussion after scope denial.');
  await capture(page, 'discussion-current-membership-denied');
  await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')", [service.project.id, accounts.owner.id]);
  await region(page).getByRole('button', { name: 'Refresh results', exact: true }).click(); await card(page, newCaption).waitFor();
  await inspect(page, newCaption, 2); await recovery(page, 2).getByText(deniedBody, { exact: true }).waitFor();
  await recover(page, second, deniedInput);
  await matrix(page, 'restored-membership-original-comment', () => comments(page, 2).scrollIntoViewIfNeeded());
  check('Actual membership revocation clears protected result and discussion content and fences a held success; restoring membership permits explicit recovery of the original immutable comment.');

  for (let index = 0; index < 31; index++) record(await api(page, commentPath(first), { method: 'POST', body: { requestId: crypto.randomUUID(), body: `Bounded discussion entry ${String(index + 1).padStart(2, '0')}.` }, expected: 201 }));
  await openRevision(page, first);
  assert(await comments(page, 1).getByRole('listitem').count() === 30, 'The first discussion page was not bounded at thirty comments.');
  await discussion(page, 1).getByRole('button', { name: 'Load older comments', exact: true }).click();
  await comments(page, 1).getByText(ownerBody, { exact: true }).waitFor();
  const stored = (await database.query('SELECT id,revision_id,body FROM research_analysis_attachment_comments WHERE attachment_id=$1', [first.attachmentId])).rows;
  assert(stored.length === acceptedIds.size && new Set(stored.map(item => item.id)).size === stored.length, 'Comment recovery duplicated immutable discussion entries.');
  assert(stored.filter(item => item.body === ownerBody).length === 1 && stored.find(item => item.body === ownerBody).revision_id === first.id, 'Earlier discussion was copied onto a corrected revision.');
  assert((await api(page, `${attachmentPath()}/${first.attachmentId}/revisions/${second.id}`)).headRevisionId === second.id, 'Discussion changed the evidence head.');
  const browserStorage = await page.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).join('\n'));
  assert(!browserStorage.includes(draftTwo) && !browserStorage.includes(lostBody) && !browserStorage.includes(deniedBody), 'Comment drafts or frozen bodies leaked into browser persistence.');
  await capture(page, 'bounded-discussion-older-page');
  check('Real bounded comment pagination opens older retained discussion; all accepted IDs remain unique, exact evidence heads stay unchanged, and draft or pending bodies never enter browser persistence.');
  await closeDetails(page); await page.setViewportSize({ width: 1366, height: 768 }); await theme(page, 'light');
  return { extraRevisions: 2, analysisVersion };
}

if (require.main === module) require('./verify-analysis-attachments-ui').main({ verifyCorrections: async env => {
  const correctionRevisions = await verifyCorrections(env), discussion = await verifyDiscussion(env);
  return { ...discussion, extraRevisions: correctionRevisions + discussion.extraRevisions };
} }).catch(failure => { console.error(failure.message); process.exitCode = 1; });
module.exports = { verifyDiscussion };
