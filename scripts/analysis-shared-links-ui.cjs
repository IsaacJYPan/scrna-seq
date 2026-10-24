'use strict';

const crypto = require('node:crypto');
const assert = (value, message) => { if (!value) throw new Error(message); };

// Called by the genuine producer-off sharing journey. It uses the same HTTPS,
// cookie accounts, immutable retained bytes and actual service response faults.
async function verifySharedLinks(context) {
  const { service, database, page: owner, baselineColleague, accounts, api, openPublications, openPublic,
    detail, capture, intercept, faults, faultPaths, expected, check, until, publicationId, packageSha, study, browser, registerPage } = context;
  assert(typeof registerPage === 'function' && baselineColleague, 'Register the fresh shared-link pages and original colleague context.');
  const analysisPath = `/api/projects/${service.project.id}/analyses/${study.id}`;
  const publicationPath = `${analysisPath}/snapshot-publications/${publicationId}`;
  const ownedContexts = [], ownedFaults = [], directReads = [];
  const oldRole = (await database.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, accounts.colleague.id])).rows[0]?.role;
  const originalScience = Number((await database.query('SELECT COUNT(*) AS n FROM private_r_executions')).rows[0].n);
  const originalJobs = Number((await database.query('SELECT COUNT(*) AS n FROM jobs')).rows[0].n);
  let loggedOutEverySession = false, draft = null, savedName = study.name;
  const held = input => { const value = intercept(input); faults.push(value); ownedFaults.push(value); return value; };
  const landing = target => target.getByRole('main', { name: 'Shared analysis snapshot', exact: true });
  const question = target => landing(target).getByRole('region', { name: 'Saved research question', exact: true });
  const caption = item => item.attachment?.caption || item.origin?.attachment?.caption || item.origin?.caption;
  const selectFinding = (target, item) => landing(target).getByRole('list', { name: 'Retained finding selection', exact: true })
    .getByRole('button').filter({ hasText: caption(item) }).click();
  const live = async target => {
    await target.bringToFront();
    await question(target).getByRole('heading', { name: savedName, exact: true }).waitFor();
  };
  function watch(target, actor = 'colleague') {
    registerPage(target, actor);
    target.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) directReads.push({ page: target, method: request.method(), pathname: url.pathname });
    });
    return target;
  }
  async function fresh(url, actor = 'colleague') {
    const profile = await browser.newContext({ viewport: { width: 1366, height: 768 } }); ownedContexts.push(profile);
    const empty = await profile.storageState();
    assert(empty.cookies.length === 0 && empty.origins.length === 0, 'A direct-link recipient inherited a workspace/browser selection.');
    const target = watch(await profile.newPage(), actor); await target.goto(url); return target;
  }
  async function directLogin(target, actor = 'colleague') {
    const button = target.getByRole('button', { name: 'Open shared snapshot', exact: true }); await button.waitFor();
    assert(!(await target.getByRole('button', { name: 'Start temporary demo', exact: true }).count()), 'A private shared link offered automatic guest/demo access.');
    await target.getByPlaceholder('researcher@lab.edu').fill(accounts[actor].email);
    await target.getByLabel('Password', { exact: true }).fill(service.account.password); await button.click(); await live(target);
  }
  async function matrix(target, name, focus) {
    for (const [width, height] of [[1366, 768], [1440, 900], [390, 844]]) {
      await target.setViewportSize({ width, height });
      for (const theme of ['light', 'dark']) {
        const actual = await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
        if (actual !== theme) await target.getByRole('button', { name: `Switch to ${theme} mode`, exact: true }).click();
        if (focus) await focus(); await capture(target, `${name}-${theme}-${width}`);
      }
    }
  }
  async function clipboardPermission(target, permissions) {
    // Overrides belong to the browser-context session. A temporary CDP session
    // drops its permission override when detached, before the actual UI click.
    await target.context().grantPermissions(permissions, { origin: new URL(service.endpoint).origin });
    return target.evaluate(async () => ({
      write: (await navigator.permissions.query({ name: 'clipboard-write' })).state,
      read: (await navigator.permissions.query({ name: 'clipboard-read' })).state,
    }));
  }
  async function restoreMembership() {
    await database.query(`INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)
      ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role`, [service.project.id, accounts.colleague.id, oldRole || 'viewer']);
  }
  async function restoreBaselineLogin() {
    if (!loggedOutEverySession) return;
    await baselineColleague.goto(service.endpoint);
    await baselineColleague.getByPlaceholder('researcher@lab.edu').fill(accounts.colleague.email);
    await baselineColleague.getByLabel('Password', { exact: true }).fill(service.account.password);
    await baselineColleague.getByRole('button', { name: /Open Workbench/ }).click();
    await baselineColleague.getByText('Connection details', { exact: true }).waitFor();
    await openPublications(baselineColleague, study); await openPublic(baselineColleague);
    loggedOutEverySession = false;
  }
  try {
    await owner.bringToFront(); await openPublications(owner, study); await openPublic(owner);
    const accepted = await api(owner, publicationPath);
    assert(accepted.snapshotSha256 === packageSha && accepted.policy.state === 'published', 'Copy link did not begin from the exact active accepted publication.');
    savedName = accepted.package.analysis.name;
    const exactHash = '#/shared-snapshots/v1/' + [accepted.serviceId, service.project.id, study.id, publicationId, packageSha].join('/');
    const exactUrl = new URL(service.endpoint); exactUrl.search = ''; exactUrl.hash = exactHash;
    const link = detail(owner).getByRole('region', { name: 'Share exact snapshot link', exact: true });
    await link.waitFor(); const deniedClipboard = await clipboardPermission(owner, []);
    assert(deniedClipboard.write === 'denied', 'The actual browser clipboard-write permission was not denied: ' + JSON.stringify(deniedClipboard));
    await link.getByRole('button', { name: 'Copy link', exact: true }).click();
    await link.getByText('Automatic copy failed. Select and copy the exact link below.', { exact: true }).waitFor();
    const copiedUrl = await link.getByRole('textbox', { name: 'Shared snapshot link', exact: true }).inputValue();
    assert(copiedUrl === exactUrl.href && new URL(copiedUrl).search === '', 'Copy fallback changed the exact service/project/analysis/publication/SHA target or leaked query data.');
    await link.getByRole('button', { name: 'Select link', exact: true }).click();
    assert(await link.getByRole('textbox', { name: 'Shared snapshot link', exact: true }).evaluate(node => node.selectionStart === 0 && node.selectionEnd === node.value.length), 'The failed-clipboard fallback did not select the full exact link.');
    await capture(owner, 'shared-link-native-clipboard-denied-selectable-fallback');
    const grantedClipboard = await clipboardPermission(owner, ['clipboard-write', 'clipboard-read']);
    assert(grantedClipboard.write === 'granted' && grantedClipboard.read === 'granted', 'The actual browser clipboard permissions were not granted: ' + JSON.stringify(grantedClipboard));
    await link.getByRole('button', { name: 'Copy link', exact: true }).click();
    await link.getByText('Link copied. The recipient must sign in and already have project access.', { exact: true }).waitFor();
    assert(await owner.evaluate(() => navigator.clipboard.readText()) === copiedUrl, 'The actual clipboard did not contain the exact accepted shared URL.');

    const attached = accepted.package.results.find(item => item.attachment || item.origin?.kind === 'attachment-revision');
    assert(attached, 'The direct-link journey needs one actual included attachment discussion.');
    const attachment = attached.attachment || attached.origin.attachment;
    const commentsPath = `${analysisPath}/attachments/${attachment.attachmentId}/revisions/${attachment.revisionId}/comments`;
    const note = 'AS05: review this exact saved comparison, without opening the producer session.';
    await api(owner, commentsPath, { method: 'POST', status: 201, body: { requestId: crypto.randomUUID(), body: note } });
    const direct = await fresh(copiedUrl);
    await direct.getByRole('button', { name: 'Open shared snapshot', exact: true }).waitFor();
    assert(direct.url() === copiedUrl && !directReads.some(item => item.page === direct && item.pathname.startsWith(analysisPath)), 'A signed-out shared link resolved project data or lost its exact target.');
    await capture(direct, 'shared-link-fresh-recipient-keeps-target-at-sign-in');
    await directLogin(direct);
    assert(direct.url() === copiedUrl && await question(direct).getByText(`Saved analysis ${accepted.package.analysis.version}`, { exact: true }).count(), 'A fresh signed-in recipient advanced to the live analysis head or lost the copied target.');
    await landing(direct).getByRole('cell', { name: 'control', exact: true }).waitFor();
    await landing(direct).getByRole('cell', { name: 'treated', exact: true }).waitFor();
    assert(!(await direct.getByRole('button', { name: /Run|Publish to project|Prepare private preview|Withdraw from project/, exact: true }).count()), 'The read-only link mounted scientific/editor/sharing mutation controls.');
    await matrix(direct, 'shared-link-fresh-reader-exact-saved-question-and-counts', () => question(direct).scrollIntoViewIfNeeded());
    const image = accepted.package.results.find(item => item.view.family === 'image'); assert(image, 'The direct-link journey needs the genuine retained R figure.');
    await selectFinding(direct, image);
    const figure = landing(direct).getByRole('img', { name: /Computed condition figure/ });
    await until(async () => await figure.count() && await figure.evaluate(node => node.complete && node.naturalWidth > 0), 'The fresh direct-link reader did not decode the retained genuine R figure.');
    await matrix(direct, 'shared-link-retained-real-r-figure-producer-off', () => figure.scrollIntoViewIfNeeded());
    const source = landing(direct).getByRole('region', { name: 'Prepared supporting source', exact: true });
    await source.getByRole('button', { name: 'View supporting source', exact: true }).click();
    await source.getByText('Saved supporting source checksum verified', { exact: true }).waitFor();
    assert((await source.locator('pre[aria-label="Retained saved source"]').textContent()).includes('set.seed(1919)'), 'The direct reader saw a new or incorrect supporting-source version.');
    await matrix(direct, 'shared-link-exact-retained-supporting-source', () => source.scrollIntoViewIfNeeded());
    check('An actually copied accepted URL survives fresh signed-out access and real second-account login, opening the original question/version/counts/genuine R figure/exact supporting source after compute, originals and private preparation are gone; actual denied clipboard permission has a selectable truthful fallback.');

    await selectFinding(direct, attached);
    const discussion = landing(direct).getByRole('region', { name: `Current discussion for saved revision ${attachment.revisionNumber}`, exact: true });
    assert(!directReads.some(item => item.page === direct && item.pathname === commentsPath), 'Current discussion was fetched before explicit opening.');
    await discussion.getByRole('button', { name: 'Read revision discussion', exact: true }).click(); await discussion.getByText(note, { exact: true }).waitFor();
    await matrix(direct, 'shared-link-live-exact-revision-discussion', () => discussion.scrollIntoViewIfNeeded());
    const localFault = held({ method: 'GET', pathname: commentsPath, mode: 'drop' }); faultPaths.add(commentsPath);
    await discussion.getByRole('button', { name: 'Refresh discussion', exact: true }).click(); await until(() => localFault.observation(), 'The genuine current-discussion response was not interrupted.');
    await discussion.getByRole('alert').waitFor();
    assert(await question(direct).getByRole('heading', { name: savedName, exact: true }).count()
      && await landing(direct).getByRole('cell', { name: 'control', exact: true }).count(), 'An unavailable independent discussion erased permitted retained findings.');
    await capture(direct, 'shared-link-discussion-unavailable-retained-findings-kept');
    await discussion.getByRole('button', { name: 'Refresh discussion', exact: true }).click(); await discussion.getByText(note, { exact: true }).waitFor();
    check('The landing opens only the included exact saved-revision live discussion on request; an interrupted discussion stays local, and a deliberate refresh recovers comments without a source or execution grant.');

    const wrongService = new URL(copiedUrl); wrongService.hash = exactHash.replace(accepted.serviceId, 'svc_' + (accepted.serviceId === 'svc_' + 'f'.repeat(32) ? 'e' : 'f').repeat(32));
    const wrongSha = new URL(copiedUrl); wrongSha.hash = exactHash.slice(0, -64) + (packageSha === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64));
    for (const [name, url, heading] of [
      ['wrong-workspace', wrongService.href, 'Connect to the linked workspace'],
      ['wrong-package-sha', wrongSha.href, 'This exact snapshot could not be confirmed'],
      ['invalid-future-route', new URL('#/shared-snapshots/v99/not-a-target', copiedUrl).href, 'This shared snapshot link could not be read'],
    ]) {
      const negative = watch(await direct.context().newPage()); await negative.goto(url);
      await negative.getByRole('heading', { name: heading, exact: true }).waitFor();
      assert(!(await negative.getByRole('region', { name: 'Saved research question', exact: true }).count()), 'An invalid exact link displayed a different protected snapshot.');
      if (name !== 'wrong-package-sha') assert(!directReads.some(item => item.page === negative && item.pathname.startsWith(analysisPath)), 'An unconfirmed workspace/invalid route requested linked resources.');
      await capture(negative, `shared-link-${name}-no-fallback`); await negative.close();
    }
    await live(direct);
    await direct.context().clearCookies(); await landing(direct).getByRole('button', { name: 'Check current access', exact: true }).click();
    await direct.getByRole('button', { name: 'Open shared snapshot', exact: true }).waitFor();
    assert(!(await direct.getByRole('region', { name: 'Saved research question', exact: true }).count()) && direct.url() === copiedUrl, 'A genuine missing session retained protected content or discarded the exact link.');
    await directLogin(direct);
    const sessionDrop = held({ method: 'GET', pathname: '/api/auth/session', mode: 'drop' }); faultPaths.add('/api/auth/session');
    await landing(direct).getByRole('button', { name: 'Check current access', exact: true }).click(); await until(() => sessionDrop.observation(), 'The genuine session observation was not interrupted.');
    await direct.getByRole('heading', { name: 'The workspace could not be reached', exact: true }).waitFor();
    assert(!(await direct.getByRole('button', { name: 'Open shared snapshot', exact: true }).count()), 'An interrupted workspace check was incorrectly treated as signed out.');
    await capture(direct, 'shared-link-workspace-check-outage-distinct-from-expired-session');
    await landing(direct).getByRole('button', { name: 'Try again', exact: true }).click(); await live(direct);
    check('Wrong workspace, wrong immutable SHA and malformed future links never substitute data; actual cookie401 returns to exact-target sign-in, while an interrupted real workspace-session response remains a retryable outage rather than false sign-out.');

    const imagePath = `${publicationPath}/views/${image.viewId}`;
    const beforeUnavailable = directReads.filter(item => item.page === direct && item.pathname === imagePath).length;
    const brokenRead = held({ method: 'GET', pathname: imagePath, mode: 'drop' }); faultPaths.add(imagePath);
    await selectFinding(direct, image); await until(() => brokenRead.observation(), 'The genuine retained image response was not interrupted.');
    const retained = landing(direct).getByRole('region', { name: 'Retained prepared finding', exact: true });
    await retained.getByRole('alert').waitFor(); await direct.waitForTimeout(150);
    assert(await question(direct).getByRole('heading', { name: savedName, exact: true }).count()
      && directReads.filter(item => item.page === direct && item.pathname === imagePath).length === beforeUnavailable + 1,
    'An unavailable retained item erased the saved package or automatically repeated the failed body read.');
    await capture(direct, 'shared-link-retained-item-unavailable-no-automatic-retry');
    await retained.getByRole('button', { name: 'Retry retained view', exact: true }).click();
    await until(async () => await figure.count() && await figure.evaluate(node => node.complete && node.naturalWidth > 0), 'Explicit retry did not recover the exact retained image.');
    await selectFinding(direct, attached); await landing(direct).getByRole('cell', { name: 'control', exact: true }).waitFor();
    check('An interrupted retained item remains a local unavailable view with its package identity and other permitted findings intact; no automatic retry/source rebuild occurs, and only an explicit retained-view retry recovers its checked bytes.');

    const oldFull = held({ method: 'GET', pathname: publicationPath, mode: 'hold' });
    await landing(direct).getByRole('button', { name: 'Check current access', exact: true }).click(); await until(() => oldFull.observation(), 'The exact authorized full response was not held before route navigation.');
    await direct.evaluate(hash => { location.hash = hash; }, wrongSha.hash);
    await direct.getByRole('heading', { name: 'This exact snapshot could not be confirmed', exact: true }).waitFor(); oldFull.release();
    await direct.waitForTimeout(150);
    assert(!(await direct.getByRole('region', { name: 'Saved research question', exact: true }).count()), 'An older held exact-link reply stole later route navigation.');
    await direct.evaluate(hash => { location.hash = hash; }, exactHash); await live(direct);

    const beforeLogout = held({ method: 'GET', pathname: publicationPath, mode: 'hold' });
    await landing(direct).getByRole('button', { name: 'Check current access', exact: true }).click(); await until(() => beforeLogout.observation(), 'The actual authorized full response was not held before logout.');
    expected.add('401 /api/runtime/compute-status'); expected.add('401 /api/r/session-id'); expected.add('401 /api/r/pipeline-state');
    await landing(direct).getByRole('button', { name: 'Sign out', exact: true }).click(); loggedOutEverySession = true;
    await direct.getByRole('button', { name: 'Open shared snapshot', exact: true }).waitFor(); beforeLogout.release();
    await direct.waitForTimeout(150); assert(!(await direct.getByRole('region', { name: 'Saved research question', exact: true }).count()), 'A held full success restored protected content after actual all-session logout.');
    await directLogin(direct);
    await selectFinding(direct, attached); await landing(direct).getByRole('cell', { name: 'control', exact: true }).waitFor();
    const rawPath = `${publicationPath}/views/${image.viewId}`, oldRaw = held({ method: 'GET', pathname: rawPath, mode: 'hold' });
    await selectFinding(direct, image); await until(() => oldRaw.observation(), 'The actual retained image was not held before membership revocation.');
    await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, accounts.colleague.id]); expected.add(`404 ${publicationPath}`);
    await landing(direct).getByRole('button', { name: 'Check current access', exact: true }).click();
    await direct.getByRole('heading', { name: 'This shared snapshot is not available to this account', exact: true }).waitFor(); oldRaw.release();
    await direct.waitForTimeout(150); assert(!(await direct.getByRole('region', { name: 'Saved research question', exact: true }).count())
      && !(await direct.getByRole('img').count()), 'A held raw image restored revoked direct-link findings.');
    await capture(direct, 'shared-link-membership-revoked-held-image-fenced');
    await restoreMembership(); await landing(direct).getByRole('button', { name: 'Try again', exact: true }).click(); await live(direct);
    check('Actual held full responses cannot steal later exact-link navigation or restore content after all-session logout; a genuinely authorized held image stays hidden after current membership removal, and explicit restored access returns to the original retained identity.');

    // A link arriving while an editing workspace is mounted must not unmount it.
    await owner.bringToFront(); await openPublications(owner, study);
    const panel = owner.getByRole('region', { name: 'Published analysis snapshots', exact: true });
    await panel.getByRole('button', { name: 'Back to analysis', exact: true }).click();
    const editor = owner.getByRole('textbox', { name: 'Research question or notes', exact: true });
    const originalDraft = await editor.inputValue(); draft = { editor, value: originalDraft };
    const persisted = (await database.query('SELECT description FROM research_analyses WHERE id=$1', [study.id])).rows[0].description;
    await editor.fill('AS05_UNSAVED_WORKSPACE_DRAFT');
    await owner.evaluate(hash => { location.hash = hash; }, exactHash);
    const banner = owner.getByRole('complementary', { name: 'Shared snapshot link', exact: true }); await banner.waitFor();
    assert(await editor.inputValue() === 'AS05_UNSAVED_WORKSPACE_DRAFT', 'Receiving a shared link unmounted or replaced the active unsaved workspace.');
    const created = gateForPage(owner.context(), target => watch(target, 'owner'));
    await banner.getByRole('link', { name: 'Open shared snapshot in new tab', exact: true }).click(); const popup = await created;
    await live(popup);
    assert(await editor.inputValue() === 'AS05_UNSAVED_WORKSPACE_DRAFT'
      && (await database.query('SELECT description FROM research_analyses WHERE id=$1', [study.id])).rows[0].description === persisted,
    'Opening a shared snapshot alongside current work saved, lost or replaced an unsent scientific draft.');
    await capture(popup, 'shared-link-new-tab-alongside-unsaved-workspace'); await popup.close();
    await owner.bringToFront(); await editor.fill(originalDraft); draft = null;

    const allowedReads = new Set(['/api/auth/policy', '/api/auth/session', '/api/auth/installation', publicationPath, commentsPath]);
    for (const item of directReads) {
      const allowed = item.method === 'GET' && (allowedReads.has(item.pathname)
        || item.pathname.startsWith(`${publicationPath}/views/`) || item.pathname.startsWith(`${publicationPath}/documents/`))
        || item.method === 'POST' && ['/api/auth/login', '/api/auth/logout'].includes(item.pathname);
      assert(allowed, 'A direct read-only shared landing dispatched an unrelated request: ' + item.method + ' ' + item.pathname);
    }
    for (const profile of ownedContexts) for (const target of profile.pages()) {
      const stored = await target.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).join('\n'));
      assert(!/set\.seed\(1919\)|AS05: review|PRIVATE_UNSELECTED|PRIVATE_CAPTURE_PATH/.test(stored), 'The direct landing persisted scientific source, comments or excluded private data.');
    }
    assert(Number((await database.query('SELECT COUNT(*) AS n FROM private_r_executions')).rows[0].n) === originalScience
      && Number((await database.query('SELECT COUNT(*) AS n FROM jobs')).rows[0].n) === originalJobs, 'Direct shared-link inspection dispatched scientific execution.');
    check('An arriving exact link preserves an active unsaved workspace and opens a separate read-only tab; fresh direct pages use only auth, installation, exact retained publication/view/source and requested discussion reads, with no project lists, runtime probes, source grants, scientific dispatch or scientific browser persistence.');
    return { copiedUrl, clipboard: { denied: deniedClipboard, granted: grantedClipboard } };
  } finally {
    for (const value of ownedFaults) value.release();
    await restoreMembership();
    if (draft) await draft.editor.fill(draft.value).catch(() => {});
    await restoreBaselineLogin();
    for (const profile of ownedContexts) await profile.close().catch(() => {});
    await owner.bringToFront().catch(() => {});
  }
}

function gateForPage(profile, register) {
  return new Promise(resolve => profile.once('page', target => { register(target); resolve(target); }));
}

// The main journey performs a real withdrawal and original-acceptance replay
// before this fresh-profile reader opens the same URL copied while active.
async function verifyWithdrawnSharedLink(context) {
  const { copiedUrl, browser, service, accounts, registerPage, capture, check } = context;
  assert(typeof copiedUrl === 'string' && new URL(copiedUrl).origin === new URL(service.endpoint).origin,
    'Reopen only the originally copied fixture URL for the actual withdrawn-reader journey.');
  const parts = new URL(copiedUrl).hash.split('/'), projectId = parts[4], analysisId = parts[5], publicationId = parts[6], snapshotSha = parts[7];
  assert(parts.length === 8 && parts[1] === 'shared-snapshots' && parts[2] === 'v1'
    && /^proj_[a-f0-9]{16,40}$/.test(projectId) && /^ra_[a-f0-9]{24}$/.test(analysisId)
    && /^aspub_[a-f0-9]{24}$/.test(publicationId) && /^[a-f0-9]{64}$/.test(snapshotSha), 'The saved withdrawn-reader URL is not the exact accepted locator.');
  const publicationPath = `/api/projects/${projectId}/analyses/${analysisId}/snapshot-publications/${publicationId}`;
  const profile = await browser.newContext({ viewport: { width: 1366, height: 768 } }), requests = [];
  try {
    const empty = await profile.storageState(); assert(empty.cookies.length === 0 && empty.origins.length === 0, 'The withdrawn-link reader inherited an authenticated workspace.');
    const target = registerPage(await profile.newPage(), 'colleague');
    target.on('request', request => { const pathname = new URL(request.url()).pathname; if (pathname.startsWith('/api/')) requests.push({ pathname, method: request.method() }); });
    await target.goto(copiedUrl); await target.getByRole('button', { name: 'Open shared snapshot', exact: true }).waitFor();
    await target.getByPlaceholder('researcher@lab.edu').fill(accounts.colleague.email);
    await target.getByLabel('Password', { exact: true }).fill(service.account.password);
    await target.getByRole('button', { name: 'Open shared snapshot', exact: true }).click();
    const landing = target.getByRole('main', { name: 'Shared analysis snapshot', exact: true });
    const tombstone = landing.getByRole('region', { name: 'Withdrawn shared snapshot', exact: true });
    await tombstone.getByRole('heading', { name: 'Snapshot withdrawn', exact: true }).waitFor();
    assert(target.url() === copiedUrl && !(await landing.getByRole('region', { name: 'Saved research question', exact: true }).count())
      && !(await landing.getByRole('list', { name: 'Retained finding selection', exact: true }).count())
      && !(await landing.getByRole('region', { name: 'Prepared supporting source', exact: true }).count()), 'An exact withdrawn URL restored a package or selected a new active snapshot.');
    const identity = landing.locator('details').filter({ has: target.getByText('Linked workspace and exact snapshot', { exact: true }) });
    await identity.locator('summary').click();
    await identity.getByText(publicationId, { exact: true }).waitFor(); await identity.getByText(snapshotSha, { exact: true }).waitFor();
    for (const [width, height] of [[1366, 768], [390, 844]]) {
      await target.setViewportSize({ width, height });
      for (const theme of ['light', 'dark']) {
        const current = await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
        if (current !== theme) await target.getByRole('button', { name: `Switch to ${theme} mode`, exact: true }).click();
        await tombstone.scrollIntoViewIfNeeded(); await capture(target, `shared-link-fresh-reader-withdrawn-tombstone-${theme}-${width}`);
      }
    }
    await landing.getByRole('button', { name: 'Check current access', exact: true }).click();
    await tombstone.getByRole('heading', { name: 'Snapshot withdrawn', exact: true }).waitFor();
    const allowed = new Set(['/api/auth/policy', '/api/auth/session', '/api/auth/installation', publicationPath]);
    assert(requests.every(item => item.method === 'GET' && allowed.has(item.pathname) || item.method === 'POST' && item.pathname === '/api/auth/login'),
      'A withdrawn direct link read original/raw/source/discussion/private/compute data or performed a non-auth mutation.');
    const stored = await target.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).join('\n'));
    assert(!/set\.seed\(1919\)|AS05: review|PRIVATE_UNSELECTED|PRIVATE_CAPTURE_PATH/.test(stored), 'A withdrawn link persisted scientific or private content.');
    check('A fresh second-account browser reopens the same originally copied URL after actual withdrawal and acceptance replay, seeing only its exact immutable tombstone in both themes/laptop/390 with no raw findings, supporting source, discussion, private or compute access.');
  } finally {
    await profile.close(); await context.page?.bringToFront().catch(() => {});
  }
}

module.exports = { verifySharedLinks, verifyWithdrawnSharedLink };
