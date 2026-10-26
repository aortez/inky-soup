import {elements as el} from '../core/dom.js';
import {state} from '../core/state.js';
import {NativeSetup} from '../services/native-setup.js';
import {normalizeAddress} from '../services/frame-client.js';

export async function setupDialog({bridge, connect, connected = async () => {}}) {
  const messages = {
    idle: 'Open the frame’s five-minute setup window, then scan for nearby frames.',
    scanning: 'Looking for nearby frames in setup mode… Choose the frame you want to add.',
    select: 'Choose your frame. If it is missing, open its setup window and scan again.',
    connecting: 'Connecting to the selected frame over Bluetooth…',
    ready: 'Enter the WiFi network your phone uses. Pi Zero frames need a 2.4 GHz network.',
    provisioning: 'Sending WiFi settings to your frame. This can take a minute…',
    checking: 'WiFi settings accepted. Connecting directly to the frame…',
    success: 'Your frame is connected and ready for photos.',
  };
  const client = new NativeSetup({bridge, normalize: normalizeAddress, connect, onStatus: render});
  state.setup = {client, phase: 'idle'};
  try { await client.listen(); }
  catch { /* Android-target browser previews do not expose native BLE. Scan shows the error. */ }

  function render(event) {
    state.setup.phase = event.phase;
    el['setup-status'].textContent = event.message || messages[event.phase];
    el['setup-name'].textContent = event.name || 'Add a frame';
    const busy = ['scanning', 'connecting', 'provisioning', 'checking'].includes(event.phase);
    el['setup-scan'].hidden = !['idle', 'select', 'error'].includes(event.phase);
    el['setup-devices'].hidden = !['scanning', 'select'].includes(event.phase);
    el['setup-wifi'].hidden = event.phase !== 'ready' && event.phase !== 'provisioning';
    el['setup-submit'].disabled = event.phase !== 'ready';
    for (const id of ['setup-ssid', 'setup-password', 'setup-show-password']) el[id].disabled = busy;
    el['setup-retry'].hidden = event.phase !== 'unreachable';
    el['setup-done'].hidden = event.phase !== 'success';
    el['setup-cancel'].hidden = event.phase === 'success';
    el['setup-help'].hidden = !['idle', 'error'].includes(event.phase);
    if (!['ready', 'provisioning'].includes(event.phase)) {
      el['setup-password'].value = ''; el['setup-ssid'].value = '';
      el['setup-show-password'].checked = false; el['setup-password'].type = 'password';
    }
    if (event.devices) {
      // Reconcile by peripheral ID so repeated advertisements do not steal keyboard focus.
      for (const device of event.devices) {
        let button = [...el['setup-devices'].children].find(item => item.dataset.device === device.id);
        if (!button) {
          button = document.createElement('button'); button.type = 'button'; button.dataset.device = device.id;
          button.addEventListener('click', () => client.select(device.id)); el['setup-devices'].append(button);
        }
        button.textContent = `${device.name} · ${device.id.slice(-8)} · ${device.rssi >= -65 ? 'Strong signal' : 'Weak signal'}`;
      }
    } else if (event.phase === 'scanning' || event.phase === 'idle') el['setup-devices'].replaceChildren();
    if (event.phase === 'select' && !event.devices?.length) el['setup-status'].textContent = 'No frames found. Move closer, open the frame’s setup window, then scan again.';
    if (event.phase === 'ready') el['setup-ssid'].focus();
  }

  async function close() {
    const succeeded = state.setup.phase === 'success';
    el['setup-dialog'].close();
    await client.cancel();
    if (succeeded) await connected();
  }
  el['add-frame'].addEventListener('click', () => {
    if (state.busy || state.job || state.connecting) return;
    render({phase: 'idle'}); el['setup-dialog'].showModal();
  });
  el['setup-scan'].addEventListener('click', () => client.scan());
  el['setup-cancel'].addEventListener('click', close);
  el['setup-done'].addEventListener('click', close);
  el['setup-dialog'].addEventListener('cancel', event => {event.preventDefault(); void close();});
  el['setup-wifi'].addEventListener('submit', event => {
    event.preventDefault();
    const ssid = el['setup-ssid'].value, password = el['setup-password'].value;
    el['setup-password'].value = '';
    void client.provision(ssid, password);
  });
  el['setup-show-password'].addEventListener('change', () => {
    el['setup-password'].type = el['setup-show-password'].checked ? 'text' : 'password';
  });
  el['setup-retry'].addEventListener('click', () => client.confirm());
  for (const [id, kind] of [['setup-radio', 'bluetooth'], ['setup-permissions', 'permissions'], ['setup-location', 'location']]) {
    el[id].addEventListener('click', () => bridge.settings({kind}).catch(error => {el['setup-status'].textContent = error.message;}));
  }
  window.addEventListener('pagehide', () => {void client.cancel();});
  return {close};
}
