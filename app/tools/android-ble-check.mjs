import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {_android} from 'playwright';

const {values} = parseArgs({options: {
  serial:{type:'string'}, device:{type:'string'}, 'ble-id':{type:'string'},
  output:{type:'string',default:'/tmp/android-ble.json'},
}});
if (!values.device || !values['ble-id']) throw new Error('Supply --device http://WIFI_IP:8000 and --ble-id XX:XX:XX:XX:XX:XX. Pipe JSON {ssid,password} on stdin; never put credentials in arguments.');
let credentials = JSON.parse(readFileSync(0, 'utf8'));
if (typeof credentials.ssid !== 'string' || typeof credentials.password !== 'string') throw new Error('Expected ssid and password strings on stdin.');
const deviceId = values['ble-id'].toUpperCase();
if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(deviceId)) throw new Error('Invalid Bluetooth device ID.');
const cli = fileURLToPath(new URL('../../inky-cli', import.meta.url));
const devices = await _android.devices({omitDriverInstall:true});
const phone = values.serial ? devices.find(item => item.serial() === values.serial) : devices.length === 1 ? devices[0] : null;
if (!phone) throw new Error('Choose one authorized phone using --serial.');
const adb = (...args) => execFileSync('adb', ['-s',phone.serial(),...args],{maxBuffer:8*1024*1024});
const shell = (...args) => adb('shell',...args).toString().trim();
const awake = shell('settings','get','global','stay_on_while_plugged_in');
const output = resolve(values.output); mkdirSync(dirname(output), {recursive:true});
const record = {model:phone.model(), android:shell('getprop','ro.build.version.release'), bleId:deviceId, checks:[]};
const errors = [];
let failed = false, page;
try {
  shell('settings','put','global','stay_on_while_plugged_in','3');
  shell('input','keyevent','KEYCODE_WAKEUP'); shell('wm','dismiss-keyguard');
  shell('am','start','-W','-n','pizza.allan.frame/.MainActivity');
  const pid = shell('pidof','pizza.allan.frame');
  page = await (await phone.webView({socketName:`webview_devtools_remote_${pid}`})).page();
  page.on('pageerror', error => errors.push(error.message));
  if (await page.locator('#setup-dialog').evaluate(el => el.open)) {
    await page.locator(await page.locator('#setup-done').isVisible() ? '#setup-done' : '#setup-cancel').click();
  }
  await page.waitForFunction(() => !document.querySelector('#connect').disabled);
  await page.locator('#connection').evaluate(el => {el.open = true;});
  await page.locator('#add-frame').click();
  const startWindow = () => {
    const result = JSON.parse(execFileSync(cli, ['--device',values.device,'--json','wifi-setup','start']).toString());
    assert.equal(result.ok,true);
  };
  const select = async () => {
    await page.locator('#setup-scan').click();
    // If Android asks for Nearby devices, approve the visible prompt on the phone.
    // The script deliberately does not change app permissions through ADB.
    const button = page.locator(`#setup-devices button[data-device="${deviceId}"]`);
    await button.waitFor({timeout:45000});
    record.discovered = await page.locator('#setup-devices button').allTextContents();
    writeFileSync(output.replace(/\.json$/, '-scan.png'), adb('exec-out','screencap','-p'));
    await button.click();
    await page.waitForFunction(() => !document.querySelector('#setup-wifi').hidden || document.querySelector('#setup-status').textContent.includes('Scan again'), null, {timeout:30000});
    assert.equal(await page.locator('#setup-wifi').isVisible(),true,await page.locator('#setup-status').textContent());
  };
  const submit = async (ssid, password) => {
    // Avoid including password values in locator-fill error messages or traces.
    await page.locator('#setup-ssid').evaluate((el,value) => {el.value = value;}, ssid);
    await page.locator('#setup-password').evaluate((el,value) => {el.value = value;}, password);
    await page.locator('#setup-submit').click();
  };
  startWindow(); await select();
  await page.locator('#setup-cancel').click();
  await page.locator('#add-frame').click(); await select();
  record.checks.push('Explicit peripheral selection, cancel, and reconnect succeed on native GATT.');
  execFileSync(cli, ['--device',values.device,'--json','wifi-setup','stop']);
  await page.waitForFunction(() => document.querySelector('#setup-status').textContent.includes('Setup has closed')
    || document.querySelector('#setup-status').textContent.includes('Bluetooth disconnected'), null, {timeout:15000});
  record.checks.push('Closing the firmware setup window produces recoverable feedback and closes GATT.');
  startWindow(); await select();
  await submit('家'.repeat(10) + 'ab', 'é'.repeat(32));
  await page.waitForFunction(() => document.querySelector('#setup-status').textContent.includes('Could not join WiFi'), null, {timeout:65000});
  record.failure = await page.locator('#setup-status').textContent();
  assert.equal(await page.locator('#setup-password').inputValue(),'');
  writeFileSync(output.replace(/\.json$/, '-failure.png'), adb('exec-out','screencap','-p'));
  record.checks.push('101-byte UTF-8 credential packet reaches firmware; nonexistent network reports WiFi failure and clears credentials.');
  startWindow(); await select(); await submit(credentials.ssid,credentials.password);
  await page.waitForFunction(() => !document.querySelector('#setup-done').hidden || !document.querySelector('#setup-retry').hidden || document.querySelector('#setup-status').textContent.includes('Could not join'), null, {timeout:90000});
  record.result = await page.locator('#setup-status').textContent();
  assert.equal(await page.locator('#setup-done').isVisible(),true,record.result);
  assert.equal(await page.locator('#setup-password').inputValue(),'');
  assert.equal(await page.locator('#setup-ssid').inputValue(),'');
  record.address = await page.locator('#address').inputValue();
  record.profile = await page.locator('#frame-detail').textContent();
  assert.equal(record.profile,'Connected · 600 × 448');
  record.checks.push('WiFi retry and direct native API configuration/gallery handoff succeed for the selected small Pi.');
  writeFileSync(output.replace(/\.json$/, '-success.png'), adb('exec-out','screencap','-p'));
  await page.locator('#setup-done').click();
  assert.equal(await page.locator('#setup-dialog').isVisible(),false);
  assert.deepEqual(errors,[]); record.pageErrors = errors;
  record.webView = await page.evaluate(() => navigator.userAgent);
  record.passed = true;
} catch (error) {
  failed = true; record.passed = false;
  let message = error.message;
  for (const value of [credentials.ssid,credentials.password]) if (value) message = message.split(value).join('[redacted]');
  record.error = message;
  if (page) record.setupStatus = await page.locator('#setup-status').textContent().catch(() => 'WebView unavailable');
} finally {
  credentials = null;
  if (awake === 'null') shell('settings','delete','global','stay_on_while_plugged_in');
  else shell('settings','put','global','stay_on_while_plugged_in',awake);
  writeFileSync(output, JSON.stringify(record,null,2)+'\n');
  for (const device of devices) await device.close();
}
console.log(JSON.stringify(record,null,2));
if (failed) process.exitCode = 1;
