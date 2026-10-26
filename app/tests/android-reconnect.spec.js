import {test, expect} from '@playwright/test';

async function bridge(page, scenario = {}) {
  await page.addInitScript(scenario => {
    const small = {id:'a'.repeat(32),instance_id:'c'.repeat(32),name:'Kitchen',api_version:1,capabilities:['device-identity-v1'],base:'http://192.168.1.2:8000'};
    const large = {...small,id:'b'.repeat(32),name:'Kitchen',base:'http://192.168.1.3:8000'};
    const config = model => model === 'small' ? {model:'impression-5.7',width:600,height:448,physical_width:600,physical_height:448,rotation_revision:0} : {model:'impression-13.3-2025',width:1600,height:1200,physical_width:1600,physical_height:1200,rotation_revision:0};
    small.config=config('small'); large.config=config('large');
    if (!localStorage.getItem('initialized')) {
      localStorage.setItem('initialized','1');
      localStorage.setItem('sparkle-frames-v1',JSON.stringify({version:1,selected:small.id,frames:[small,large]}));
      if (scenario.job) localStorage.setItem('sparkle-job',JSON.stringify({id:7,deviceId:small.id,instanceId:small.instance_id,base:small.base,filename:'photo.jpg',createdAt:123}));
    }
    window.services=[{base:'http://192.168.1.9:8000'},{base:large.base}];
    window.apiCalls=[]; window.discoveries=0; window.scenario=scenario;
    let counter=0;const files=new Map(),listeners={};
    window.resumeFrame=()=>listeners.appStateChange?.({isActive:true});
    window.Capacitor={PluginHeaders:['FrameTransport','FrameDiscovery','FrameBle','App'].map(name=>({name,methods:[
      ...['select','request','read','release','create','append','discover','removeListener'].map(name=>({name,rtype:'promise'})),{name:'addListener',rtype:'callback'},
    ]})), nativeCallback(plugin,method,args,callback){listeners[args.eventName]=callback;return `${plugin}-${args.eventName}`;},
    async nativePromise(plugin,method,args){
      if(plugin==='FrameDiscovery'&&method==='discover'){
        window.discoveries++;
        if(window.scenario.denied)throw Error('Allow local-network access in Android Settings, then retry discovery.');
        return {services:window.scenario.missing?[]:window.services};
      }
      if(plugin!=='FrameTransport')return {};
      if(method==='select'||method==='append')return {};
      if(method==='create')return {id:String(++counter)};
      if(method==='release'){files.delete(args.id);return {};}
      if(method==='read')return {data:btoa(files.get(args.id).slice(args.offset))};
      if(method==='request'){
        window.apiCalls.push({base:args.base,path:args.path,method:args.method});
        if(window.scenario.missing)throw Error('Cannot reach frame');
        const moved=window.scenario.moved;
        let identity=args.base.endsWith('1.9:8000')?small:args.base===small.base?(moved?large:small):large;
        identity={...identity,base:args.base};
        if(window.scenario.restarted&&identity.id===small.id)identity.instance_id='d'.repeat(32);
        let data=args.path==='/api/lock-image'?{locked:true}:args.path==='/api/device'?identity:args.path==='/api/display-config'?identity.config:args.path.startsWith('/api/flash/status/')?{filename:'photo.jpg',created_at:123,status:'Completed'}:[];
        const text=JSON.stringify(data),id=String(++counter);files.set(id,text);
        return {id,size:text.length,status:200,contentType:'application/json'};
      }
      return {};
    }};
  },scenario);
}

test('reused IP discovers saved identity, persists new address, and reconnects after restart',async({page})=>{
  await bridge(page,{moved:true});await page.goto('/');
  await expect(page.locator('#frame-detail')).toHaveText('Connected · 600 × 448');
  expect(await page.locator('#address').inputValue()).toBe('http://192.168.1.9:8000');
  const calls=await page.evaluate(()=>window.apiCalls);
  expect(calls.filter(call=>call.base==='http://192.168.1.2:8000').every(call=>call.path==='/api/device')).toBe(true);
  await page.reload();await expect(page.locator('#frame-detail')).toHaveText('Connected · 600 × 448');
  expect(await page.evaluate(()=>window.discoveries)).toBe(0);
});
test('two same-name frames remain distinct, selected model persists, forget never deletes photos',async({page})=>{
  await bridge(page);await page.goto('/');await expect(page.locator('#frame-detail')).toHaveText('Connected · 600 × 448');
  await page.locator('#connection > summary').click();
  await expect(page.locator('#frame-picker option')).toHaveText(['Choose a frame','Kitchen · 13.3″ · bbbbbb','Kitchen · 5.7″ · aaaaaa']);
  await page.locator('#frame-picker').selectOption('b'.repeat(32));
  await expect(page.locator('#frame-detail')).toHaveText('Connected · 1600 × 1200');
  await page.reload();await expect(page.locator('#frame-detail')).toHaveText('Connected · 1600 × 1200');
  await page.locator('#connection > summary').click();await page.locator('#forget').click();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('sparkle-frames-v1')).frames.map(frame=>frame.id))).toEqual(['a'.repeat(32)]);
  expect(await page.evaluate(()=>window.apiCalls.every(call=>call.method==='GET'))).toBe(true);
  await page.reload();await expect(page.locator('#frame-name')).toHaveText('Your frame');
});
test('resume discovers an address change without setup',async({page})=>{
  await bridge(page);await page.goto('/');await expect(page.locator('#frame-detail')).toHaveText('Connected · 600 × 448');
  await page.evaluate(()=>{window.scenario.moved=true;window.resumeFrame();});
  await expect(page.locator('#address')).toHaveValue('http://192.168.1.9:8000');
  await expect(page.locator('#frame-detail')).toHaveText('Connected · 600 × 448');
  await expect(page.locator('#setup-dialog')).not.toBeVisible();
});
for(const restarted of [false,true])test(`remembered job is reconciled without resubmission; restarted=${restarted}`,async({page})=>{
  await bridge(page,{moved:true,job:true,restarted});await page.goto('/');
  await expect(page.locator('#activity-title')).toHaveText(restarted?'Previous refresh status unavailable':'Your new view is ready.');
  expect(await page.evaluate(()=>window.apiCalls.every(call=>call.method==='GET'))).toBe(true);
  expect(await page.evaluate(()=>localStorage.getItem('sparkle-job'))).toBeNull();
  if(restarted) expect(await page.evaluate(()=>window.apiCalls.some(call=>call.path.includes('/flash/status/')))).toBe(false);
});
for(const denied of [false,true])test(`unavailable/discovery denied exposes recovery; denied=${denied}`,async({page})=>{
  await bridge(page,{missing:true,denied});await page.goto('/');
  await expect(page.locator('#connection-status')).toContainText(denied?'Allow local-network access':'saved frame is unavailable');
  await expect(page.locator('#frame-recovery')).toBeVisible();await expect(page.locator('#add-frame')).toBeEnabled();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('sparkle-frames-v1')).selected)).toBe('a'.repeat(32));
});

test('a frame that changes identity during handshake is never remembered or written to',async({page})=>{
  await bridge(page);
  await page.addInitScript(()=>{
    const original=window.Capacitor.nativePromise;
    let reads=0;
    window.Capacitor.nativePromise=async(plugin,method,args)=>{
      if(plugin==='FrameTransport'&&method==='request'&&args.path==='/api/device'&&++reads===2)window.scenario.moved=true;
      return original(plugin,method,args);
    };
  });
  await page.goto('/');await expect(page.locator('#connection-status')).toContainText('frame changed while connecting');
  expect(await page.evaluate(()=>window.apiCalls.every(call=>call.method==='GET'))).toBe(true);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('sparkle-frames-v1')).selected)).toBe('a'.repeat(32));
});


test('resume rebinds a saved draft and reacquires its edit lease at the verified address',async({page})=>{
  await bridge(page);await page.goto('/');await expect(page.locator('#frame-detail')).toHaveText('Connected · 600 × 448');
  await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=10;canvas.height=10;
    const blob=await new Promise(resolve=>canvas.toBlob(resolve));
    const db=await new Promise((resolve,reject)=>{const open=indexedDB.open('sparkle-frame',1);open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put({blob,name:'photo.jpg',sourceFilename:'photo.jpg',sourceDeviceId:'a'.repeat(32),sourceFrame:'http://192.168.1.2:8000'},'current');
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });db.close();
  });
  await page.reload();await expect(page.locator('#lock-status')).toContainText('Editing this photo.');
  await page.evaluate(()=>{window.apiCalls=[];window.scenario.moved=true;window.resumeFrame();});
  await expect(page.locator('#address')).toHaveValue('http://192.168.1.9:8000');
  await expect(page.locator('#lock-status')).toContainText('Editing this photo.');
  await expect(page.locator('#fit')).toBeEnabled();
  const writes=await page.evaluate(()=>window.apiCalls.filter(call=>call.method==='POST'));
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every(call=>call.base==='http://192.168.1.9:8000'&&call.path==='/api/lock-image')).toBe(true);
});
