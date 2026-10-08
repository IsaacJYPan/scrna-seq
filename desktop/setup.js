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

function updateConnectionFields() {
  const ssh = kindInput.value === 'ssh';
  document.querySelector('#endpoint-fields').hidden = ssh;
  endpointInput.required = !ssh;
  endpointInput.disabled = ssh;
  const sshFields = document.querySelector('#ssh-fields');
  sshFields.hidden = !ssh;
  sshFields.disabled = !ssh;
  document.querySelector('#ssh-host').required = ssh;
  document.querySelector('#remote-host').required = ssh;
  document.querySelector('#remote-port').required = ssh;
  connectButton.disabled = busy || ssh;
  connectButton.textContent = ssh ? 'SSH connection pending' : 'Save and connect';
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
  document.querySelector('#ssh-port').value = ssh.port || 22;
  document.querySelector('#remote-host').value = ssh.remoteHost || '127.0.0.1';
  document.querySelector('#remote-port').value = ssh.remotePort || 3000;
  removeButton.hidden = !profile;
  savedStatus.hidden = true;
  error.hidden = true;
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
    option.textContent = profile.name + (profile.kind === 'ssh' ? ' — SSH configuration' : '');
    picker.append(option);
  }
  picker.value = selectedId === undefined ? state.selectedProfileId || '' : selectedId || '';
  selectProfile(picker.value);
  const target = state.currentTarget;
  document.querySelector('#current-target').textContent = target?.status === 'connected'
    ? 'Connected project service: ' + target.name + ' · ' + target.endpoint
    : target?.status === 'configuration_only'
      ? target.name + ': SSH configuration saved. No managed SSH connection is active.'
      : 'No service connected.';
  if (state.warning) { error.textContent = state.warning; error.hidden = false; }
}

function draftProfile() {
  const profile = { ...(editedId ? { id: editedId } : {}), name: nameInput.value, kind: kindInput.value };
  if (profile.kind === 'ssh') {
    const username = document.querySelector('#ssh-user').value;
    profile.ssh = { host: document.querySelector('#ssh-host').value,
      ...(username ? { username } : {}), port: document.querySelector('#ssh-port').value,
      remoteHost: document.querySelector('#remote-host').value,
      remotePort: document.querySelector('#remote-port').value };
  } else profile.endpoint = endpointInput.value;
  return profile;
}

function setBusy(value) {
  busy = value;
  picker.disabled = value;
  saveButton.disabled = value;
  removeButton.disabled = value;
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
      connectButton.textContent = 'Checking connection…';
      await window.desktopShell.saveAndConnectTargetProfile(draftProfile());
      return;
    }
    const profile = await window.desktopShell.saveTargetProfile(draftProfile());
    editedId = profile.id;
    await refreshProfiles(profile.id);
    savedStatus.textContent = profile.kind === 'ssh'
      ? 'SSH configuration saved. Managed SSH connection is pending; no tunnel was started.'
      : 'Target profile saved. Connect to use this project service.';
    savedStatus.hidden = false;
  } catch (reason) { showError(reason); }
  finally { setBusy(false); }
}

picker.addEventListener('change', () => selectProfile(picker.value));
kindInput.addEventListener('change', updateConnectionFields);
saveButton.addEventListener('click', () => save(false));
form.addEventListener('submit', event => { event.preventDefault(); if (kindInput.value !== 'ssh') void save(true); });
removeButton.addEventListener('click', async () => {
  if (!editedId) return;
  setBusy(true);
  try { await window.desktopShell.removeTargetProfile(editedId); await refreshProfiles(''); }
  catch (reason) { showError(reason); }
  finally { setBusy(false); }
});
if (window.desktopShell) refreshProfiles().catch(showError);
else showError(new Error('Use TraceOmics desktop to configure execution targets.'));
