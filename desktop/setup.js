'use strict';

const form = document.querySelector('#connection-form');
const input = document.querySelector('#server-url');
const error = document.querySelector('#error');
const button = document.querySelector('#connect');

async function restoreSavedServer() {
  const savedUrl = await window.desktopShell?.getServerUrl();
  if (savedUrl) input.value = savedUrl;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  button.disabled = true;
  try {
    await window.desktopShell.configureServer(input.value);
  } catch (reason) {
    error.textContent = reason instanceof Error ? reason.message : 'Unable to save that server address.';
    error.hidden = false;
    button.disabled = false;
    input.focus();
  }
});

restoreSavedServer();
