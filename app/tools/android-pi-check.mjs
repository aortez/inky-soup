import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, statSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {_android} from 'playwright';

const {values} = parseArgs({options: {
  serial:{type:'string'}, device:{type:'string'}, photo:{type:'string'},
  flash:{type:'boolean',default:false}, output:{type:'string',default:'/tmp/inky-android-pi.json'},
}});
if (!values.device || !values.photo) throw new Error('Supply --device http://WIFI_IP:8000 and --photo DISPOSABLE_PHOTO; add --flash to refresh the physical display.');
const base = new URL(values.device).origin;
const config = await (await fetch(`${base}/api/display-config`)).json();
assert.equal(config.model, 'impression-5.7', 'This smoke test targets the small panel.');
const devices = await _android.devices({omitDriverInstall:true});
const device = values.serial ? devices.find(item=>item.serial()===values.serial) : devices.length===1 ? devices[0] : null;
if (!device) throw new Error('Choose one authorized phone with --serial.');
const adb = (...args) => execFileSync('adb',['-s',device.serial(),...args], {maxBuffer:8 * 1024 * 1024});
const shell = (...args) => adb('shell',...args).toString().trim();
const awake = shell('settings','get','global','stay_on_while_plugged_in');
const output = resolve(values.output); mkdirSync(dirname(output),{recursive:true});
const record = {base, config, photoBytes:statSync(values.photo).size, model:device.model(),
  android:shell('getprop','ro.build.version.release'), checks:[]};
const errors=[], external=[];
try {
  shell('settings','put','global','stay_on_while_plugged_in','3');
  shell('input','keyevent','KEYCODE_WAKEUP'); shell('wm','dismiss-keyguard');
  shell('am','start','-W','-n','pizza.allan.frame/.MainActivity');
  const pid=shell('pidof','pizza.allan.frame');
  const view=await device.webView({socketName:`webview_devtools_remote_${pid}`});
  const page=await view.page();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if (/^https?:/.test(request.url()) && !request.url().startsWith('https://localhost/')) external.push(request.url());});
  await page.waitForFunction(()=>!document.querySelector('#connect').disabled);
  await page.locator('#connection').evaluate(el=>el.open=true);
  await page.locator('#address').fill(base);
  await page.locator('#connect').click();
  await page.waitForFunction(()=>document.querySelector('#frame-detail').textContent.startsWith('Connected'),null,{timeout:60000});
  await page.locator('#gallery-tab').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('#gallery img')].every(img=>img.complete && img.naturalWidth>0),null,{timeout:30000});
  record.galleryBefore=await page.locator('#gallery button').count();
  record.checks.push('Native configuration and gallery thumbnails load over WiFi.');
  await page.locator('#choose-tab').click();
  await page.locator('#photo').setInputFiles(resolve(values.photo));
  await page.waitForFunction(()=>!document.querySelector('#send').disabled,null,{timeout:90000});
  record.dimensions=await page.locator('#preview').evaluate(img=>[img.naturalWidth,img.naturalHeight]);
  assert.deepEqual(record.dimensions,[config.width,config.height]);
  const started=Date.now();
  await page.locator(values.flash?'#send':'#save').click();
  await page.waitForFunction(()=>['Your new view is ready.','Photo saved.','Could not finish saving','The display could not refresh.'].includes(document.querySelector('#activity-title').textContent),null,{timeout:180000});
  record.elapsedMs=Date.now()-started;
  record.activity=await page.locator('#activity-title').textContent();
  record.detail=await page.locator('#activity-detail').textContent();
  assert.equal(record.activity,values.flash?'Your new view is ready.':'Photo saved.',record.detail);
  record.job=await page.locator('#job-info').textContent();
  if (values.flash) {
    const jobId = /^Job (\d+)/.exec(record.job)?.[1];
    assert.ok(jobId);
    // Firmware retains completed jobs for only 30 seconds; check before the
    // large original download, while status is still available.
    const cli = fileURLToPath(new URL('../../inky-cli', import.meta.url));
    record.cliJob = JSON.parse(execFileSync(cli, ['--device', base, '--json', 'job', jobId]).toString());
    assert.equal(record.cliJob.status, 'Completed');
  }
  record.draft=await page.evaluate(()=>new Promise((resolve,reject)=>{
    const request=indexedDB.open('sparkle-frame',1);
    request.onsuccess=()=>{
      const db=request.result; const read=db.transaction('drafts').objectStore('drafts').get('current');
      read.onsuccess=()=>{const {blob,...draft}=read.result;db.close();resolve(draft);}; read.onerror=()=>reject(read.error);
    }; request.onerror=()=>reject(request.error);
  }));
  record.checks.push('Large original and derived PNGs transferred; session and orientation fields accepted.');
  if (values.flash) record.checks.push('Phone reports completed physical display job.');
  // Download the just-uploaded original through the same native binary adapter.
  await page.waitForFunction(()=>!document.querySelector('#save').disabled);
  await page.locator('#gallery-tab').click();
  await page.locator('#refresh-gallery').click();
  await page.locator('#gallery button').filter({hasText:record.draft.sourceFilename}).click();
  await page.waitForFunction(()=>!document.querySelector('#send').disabled,null,{timeout:90000});
  record.checks.push('Uploaded original downloads, reopens, and acquires its editing lock.');
  record.bridgeFiles=shell('run-as','pizza.allan.frame','ls','cache/frame-transfers');
  assert.equal(record.bridgeFiles,'');
  assert.deepEqual(external,[]); assert.deepEqual(errors,[]);
  record.webView=await page.evaluate(()=>navigator.userAgent);
  record.externalWebRequests=external;record.pageErrors=errors;
  await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
  await page.waitForTimeout(500);
  writeFileSync(output.replace(/\.json$/,'.png'),adb('exec-out','screencap','-p'));
  record.passed=true;
} catch(error) {record.passed=false;record.error=error.stack;throw error;}
finally {
  if(awake==='null') shell('settings','delete','global','stay_on_while_plugged_in');
  else shell('settings','put','global','stay_on_while_plugged_in',awake);
  writeFileSync(output,JSON.stringify(record,null,2)+'\n');
  for(const item of devices) await item.close();
}
console.log(JSON.stringify(record,null,2));
