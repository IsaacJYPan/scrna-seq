'use strict';

const form = document.querySelector('#connection-form');
const picker = document.querySelector('#saved-target');
const nameInput = document.querySelector('#target-name');
const kindInput = document.querySelector('#target-kind');
const endpointInput = document.querySelector('#server-url');
const error = document.querySelector('#error');
const savedStatus = document.querySelector('#saved-status');
const connectButton = document.querySelector('#connect');
const saveButton = document.querySelector('#save');
const removeButton = document.querySelector('#remove');
let profiles = [];
let editedId = null;
let busy = false;
let sshChallenge = null;
let sshRequest = 0;
const hostVerification = document.querySelector('#ssh-host-verification');
const cancelSsh = document.querySelector('#cancel-ssh');
const identityInput = document.querySelector('#ssh-identity');
const trustButton = document.querySelector('#trust-host');
const tunnelButton = document.querySelector('#connect-ssh-service');
const disconnectButton = document.querySelector('#disconnect-target');

function updateConnectionFields() {
  const ssh = kindInput.value === 'ssh';
  const locked = busy || Boolean(sshChallenge);
  document.querySelector('#endpoint-fields').hidden = false;
  document.querySelector('#ssh-endpoint-hint').hidden = !ssh;
  endpointInput.required = !ssh;
  endpointInput.disabled = locked;
  tunnelButton.hidden = !ssh;
  tunnelButton.disabled = locked || !endpointInput.value.trim();
  disconnectButton.disabled = locked;
  const sshFields = document.querySelector('#ssh-fields');
  sshFields.hidden = !ssh;
  sshFields.disabled = !ssh;
  document.querySelector('#ssh-host').required = ssh;
  document.querySelector('#remote-host').required = ssh;
  document.querySelector('#remote-port').required = ssh;
  for (const input of form.querySelectorAll('#target-name, #target-kind, #ssh-host, #ssh-user, #ssh-port, #ssh-identity, #remote-host, #remote-port')) input.disabled = locked;
  picker.disabled = locked; saveButton.disabled = locked; removeButton.disabled = locked;
  document.querySelector('#choose-identity').disabled = locked;
  document.querySelector('#clear-identity').disabled = locked;
  connectButton.disabled = locked;
  connectButton.textContent = ssh ? 'Verify SSH access' : 'Save and connect';
  document.querySelector('#unlock-identity').disabled = locked || !identityInput.value;
  cancelSsh.hidden = !ssh || (!busy && !sshChallenge);
  endpointInput.placeholder = kindInput.value === 'local' ? 'http://localhost:3000' : 'https://analysis.example.org';
}

function selectProfile(id) {
  const profile = profiles.find(item => item.id === id);
  editedId = profile?.id || null;
  nameInput.value = profile?.name || '';
  kindInput.value = profile?.kind || 'https';
  endpointInput.value = profile?.endpoint || '';
  const ssh = profile?.ssh || {};
  document.querySelector('#ssh-host').value = ssh.host || '';
  document.querySelector('#ssh-user').value = ssh.username || '';
  document.querySelector('#ssh-port').value = ssh.port || '';
  identityInput.value = ssh.identityFile || '';
  document.querySelector('#remote-host').value = ssh.remoteHost || '127.0.0.1';
  document.querySelector('#remote-port').value = ssh.remotePort || 3000;
  removeButton.hidden = !profile;
  savedStatus.hidden = true;
  error.hidden = true;
  sshChallenge = null; hostVerification.hidden = true; cancelSsh.hidden = true;
  updateConnectionFields();
}

async function refreshProfiles(selectedId) {
  const state = await window.desktopShell.getTargetProfiles();
  profiles = state.profiles;
  picker.replaceChildren();
  const empty = document.createElement('option');
  empty.value = ''; empty.textContent = 'New target'; picker.append(empty);
  for (const profile of profiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.name + (profile.kind === 'ssh' ? ' — SSH' : '');
    picker.append(option);
  }
  picker.value = selectedId === undefined ? state.selectedProfileId || '' : selectedId || '';
  selectProfile(picker.value);
  const target = state.currentTarget;
  disconnectButton.hidden = target?.kind !== 'ssh' || target.status !== 'connected';
  document.querySelector('#current-target').textContent = target?.status === 'connected'
    ? 'Connected project service: ' + target.name + ' · ' + target.endpoint
    : target?.status === 'configuration_only'
      ? target.name + ': SSH configuration saved. No managed SSH connection is active.'
      : target?.sshTunnel ? target.name + ': SSH tunnel disconnected. ' + (target.sshTunnel.message || 'Reconnect to continue.') : 'No service connected.';
  const sshStatus = state.sshStatuses?.[picker.value];
  if (sshStatus?.state === 'authenticated') {
    savedStatus.textContent = target?.id === picker.value && target.status === 'connected'
      ? 'SSH authentication verified. The HTTPS project service is connected.'
      : 'SSH authentication verified for ' + sshStatus.username + '@' + sshStatus.host + '. The project service has not been opened.';
    savedStatus.hidden = false;
  }
  if (state.warning) { error.textContent = state.warning; error.hidden = false; }
}

function draftProfile() {
  const profile = { ...(editedId ? { id: editedId } : {}), name: nameInput.value, kind: kindInput.value };
  if (profile.kind === 'ssh') {
    const username = document.querySelector('#ssh-user').value;
    profile.ssh = { host: document.querySelector('#ssh-host').value,
      ...(username ? { username } : {}), port: document.querySelector('#ssh-port').value,
      remoteHost: document.querySelector('#remote-host').value,
      remotePort: document.querySelector('#remote-port').value,
      ...(identityInput.value ? { identityFile: identityInput.value } : {}) };
    if (endpointInput.value.trim()) profile.endpoint = endpointInput.value;
  } else profile.endpoint = endpointInput.value;
  return profile;
}

function setBusy(value) {
  busy = value;
  picker.disabled = value;
  saveButton.disabled = value;
  removeButton.disabled = value;
  document.querySelector('#choose-identity').disabled = value;
  document.querySelector('#clear-identity').disabled = value;
  trustButton.disabled = value || !document.querySelector('#ssh-host-verified').checked;
  cancelSsh.hidden = kindInput.value !== 'ssh' || (!value && !sshChallenge);
  updateConnectionFields();
}
function showError(reason) {
  error.textContent = String(reason?.message || 'The target could not be saved.')
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  error.hidden = false;
}
async function save(connect) {
  if (!form.reportValidity()) return;
  setBusy(true); error.hidden = true; savedStatus.hidden = true;
  try {
    if (connect) {
      if (kindInput.value === 'ssh') {
        const request = ++sshRequest;
        connectButton.textContent = 'Checking SSH access…';
        const profile = await window.desktopShell.saveTargetProfile(draftProfile());
        await refreshProfiles(profile.id);
        if (request !== sshRequest) throw new Error('SSH verification was canceled.');
        showSshResult(await window.desktopShell.verifySshTarget(profile));
        return;
      }
      connectButton.textContent = 'Checking connection…';
      await window.desktopShell.saveAndConnectTargetProfile(draftProfile());
      return;
    }
    const profile = await window.desktopShell.saveTargetProfile(draftProfile());
    editedId = profile.id;
    await refreshProfiles(profile.id);
    savedStatus.textContent = profile.kind === 'ssh'
      ? 'SSH configuration saved. Verify SSH access to check the host identity and authentication; no tunnel was started.'
      : 'Target profile saved. Connect to use this project service.';
    savedStatus.hidden = false;
  } catch (reason) { showError(reason); }
  finally { setBusy(false); }
}

picker.addEventListener('change', () => selectProfile(picker.value));
kindInput.addEventListener('change', updateConnectionFields);
endpointInput.addEventListener('input', updateConnectionFields);
tunnelButton.addEventListener('click', async () => {
  if (!form.reportValidity() || !endpointInput.value.trim()) return;
  setBusy(true); error.hidden = true; savedStatus.hidden = true;
  try { await window.desktopShell.saveAndConnectTargetProfile(draftProfile()); }
  catch (reason) { showError(reason); }
  finally { setBusy(false); }
});
disconnectButton.addEventListener('click', async () => {
  setBusy(true); error.hidden = true;
  try { await window.desktopShell.disconnectTarget(); await refreshProfiles(editedId); }
  catch (reason) { showError(reason); }
  finally { setBusy(false); }
});
saveButton.addEventListener('click', () => save(false));
form.addEventListener('submit', event => { event.preventDefault(); void save(true); });
function showSshResult(result) {
  editedId = result.profileId || editedId;
  sshChallenge = result.state === 'verify-host' ? result : null;
  hostVerification.hidden = !sshChallenge;
  if (sshChallenge) {
    document.querySelector('#ssh-discovered-host').textContent = result.host + ':' + result.port + ' · ' + result.username;
    document.querySelector('#ssh-host-verified').checked = false;
    const list = document.querySelector('#ssh-fingerprints'); list.replaceChildren();
    for (const [index, entry] of result.fingerprints.entries()) {
      const label = document.createElement('label'); label.className = 'fingerprint-label';
      const input = document.createElement('input'); input.type = 'radio'; input.name = 'host-fingerprint'; input.value = entry.fingerprint; input.checked = index === 0;
      const description = document.createElement('span'); description.textContent = entry.algorithm;
      const fingerprint = document.createElement('code'); fingerprint.textContent = entry.fingerprint;
      description.append(fingerprint); label.append(input, description); list.append(label);
    }
    savedStatus.textContent = (result.route?.length ? 'Verified jump route: ' + result.route.join(' → ') + '. ' : '')
      + 'The host is not trusted yet. Verify its fingerprint before authenticating.';
  } else savedStatus.textContent = 'SSH authentication verified for ' + result.username + '@' + result.host + '. '
    + (result.stages?.length ? 'Route: ' + result.stages.map(stage => stage.alias).join(' → ') + '. ' : '')
    + 'The project service has not been opened.';
  savedStatus.hidden = false;
}
document.querySelector('#ssh-host-verified').addEventListener('change', () => {
  trustButton.disabled = busy || !document.querySelector('#ssh-host-verified').checked;
});
trustButton.addEventListener('click', async () => {
  if (!sshChallenge || !document.querySelector('#ssh-host-verified').checked) return;
  const fingerprint = document.querySelector('input[name="host-fingerprint"]:checked')?.value;
  setBusy(true); error.hidden = true;
  try { showSshResult(await window.desktopShell.confirmSshHost(sshChallenge.challengeId, fingerprint)); }
  catch (reason) { sshChallenge = null; hostVerification.hidden = true; showError(reason); }
  finally { setBusy(false); }
});
cancelSsh.addEventListener('click', async () => {
  try {
    sshRequest++;
    await window.desktopShell.cancelSshVerification();
    sshChallenge = null; hostVerification.hidden = true; cancelSsh.hidden = true;
    updateConnectionFields();
  } catch (reason) { showError(reason); }
});
document.querySelector('#choose-identity').addEventListener('click', async () => {
  try { const selected = await window.desktopShell.chooseSshIdentity(); if (selected) identityInput.value = selected; updateConnectionFields(); }
  catch (reason) { showError(reason); }
});
document.querySelector('#clear-identity').addEventListener('click', () => { identityInput.value = ''; updateConnectionFields(); });
document.querySelector('#unlock-identity').addEventListener('click', async () => {
  try { await window.desktopShell.unlockSshIdentity(identityInput.value); savedStatus.textContent = 'Complete the native OpenSSH agent prompt, then retry SSH verification.'; savedStatus.hidden = false; }
  catch (reason) { showError(reason); }
});
document.querySelector('#open-host-trust').addEventListener('click', () => window.desktopShell.openSshHostTrust().catch(showError));
removeButton.addEventListener('click', async () => {
  if (!editedId) return;
  setBusy(true);
  try { await window.desktopShell.removeTargetProfile(editedId); await refreshProfiles(''); }
  catch (reason) { showError(reason); }
  finally { setBusy(false); }
});
if (window.desktopShell) refreshProfiles().catch(showError);
else showError(new Error('Use TraceOmics desktop to configure execution targets.'));
