import { ImprovClient } from './improv-client.js';

const status = document.querySelector('#status');
const connect = document.querySelector('#connect');
const cancel = document.querySelector('#cancel');
const form = document.querySelector('#wifi-form');
const password = document.querySelector('#password');
const submit = document.querySelector('#submit');
const link = document.querySelector('#device-link');
const deviceInterface = document.querySelector('#device-interface-link');
const deviceName = document.querySelector('#device-name');
const supported = window.isSecureContext && 'bluetooth' in navigator;
const client = new ImprovClient({ onStatus: showStatus });

function showStatus(event) {
  status.textContent = event.message || ({
    idle: 'Ready to connect.', connecting: 'Choose your frame, then wait for Bluetooth to connect.',
    ready: 'Enter the WiFi network name and password.', provisioning: 'Connecting the frame to WiFi…',
    success: 'WiFi is connected. Keep your phone on the same network to open the frame.',
  }[event.state] || '');
  const busy = ['connecting', 'provisioning'].includes(event.state);
  const editable = ['ready', 'retry'].includes(event.state);
  connect.disabled = busy || !supported;
  connect.hidden = editable || event.state === 'provisioning' || event.state === 'success';
  cancel.hidden = !busy && !editable;
  form.hidden = !editable && event.state !== 'provisioning';
  submit.disabled = busy;
  if (event.name) deviceName.textContent = event.name;
  link.hidden = event.state !== 'success' || !event.url;
  if (!link.hidden) {
    link.href = `/frame/#device=${encodeURIComponent(event.url)}`;
    link.textContent = `Open ${event.name}`;
    deviceInterface.href = event.url;
  }
  deviceInterface.hidden = link.hidden;
  if (event.state === 'success') password.value = '';
  if (event.state === 'ready') document.querySelector('#ssid').focus();
}

if (!supported) {
  connect.disabled = true;
  status.textContent = 'Use Chrome or Edge on Android, Windows, or macOS. iPhone and iPad browsers cannot use this Bluetooth setup. On Linux, Web Bluetooth may need experimental platform features enabled.';
}
connect.addEventListener('click', () => client.connect());
cancel.addEventListener('click', () => {
  client.disconnect();
  password.value = '';
  showStatus({ state: 'idle', message: 'Setup cancelled. You can reconnect when ready.' });
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await client.provision(document.querySelector('#ssid').value, password.value); }
  catch (error) {
    if (!client.device) password.value = '';
    else status.textContent = error.message;
  }
});
document.querySelector('#show-password').addEventListener('change', (event) => {
  password.type = event.target.checked ? 'text' : 'password';
});
window.addEventListener('pagehide', () => { client.disconnect(); password.value = ''; });
