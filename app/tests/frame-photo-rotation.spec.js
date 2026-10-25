import {test, expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

const base = 'http://inky-soup.local:8000';
const config = {model:'impression-5.7', width:600, height:448, physical_width:600, physical_height:448,
  thumb_width:150, thumb_height:112, rotation_degrees:0, rotation_revision:3,
  photo_rotation_supported:true, orientation_test_supported:true};
const field = (body, name) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(body)?.[1];

async function fixture(page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ['#f00','#0f0','#00f','#ff0'].forEach((color,i) => {ctx.fillStyle=color;ctx.fillRect(i%2*24,Math.floor(i/2)*16,24,16);});
    return canvas.toDataURL().split(',')[1];
  });
  return {name:'corners.png',mimeType:'image/png',buffer:Buffer.from(data,'base64')};
}

async function frame(page, {pending = false, failThumb = false, failRotation = null} = {}) {
  const photos = pending ? [{filename:'saved.png', photo_rotation_degrees:270, photo_rotation_revision:4, needs_processing:true, thumb_ready:false}] : [];
  let source;
  let jobStatus = 'Flashing';
  let stale = false;
  const requests = [];
  await page.route(`${base}/**`, async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const body = request.postData() || ''; requests.push({path,body});
    let result = {success:true};
    if (path === '/api/display-config') result = config;
    else if (path === '/api/images') result = photos;
    else if (path.startsWith('/images/')) return route.fulfill({contentType:'image/png',body:source});
    else if (path === '/api/lock-image') result = {locked:true};
    else if (path === '/upload') {
      const filename = /filename="([^"]+)"/.exec(body)[1];
      photos.push({filename,photo_rotation_degrees:0,photo_rotation_revision:0,needs_processing:true}); result = {success:true,filename};
    } else if (path === '/api/settings/photo-rotation') {
      const change = JSON.parse(body); const photo = photos.find(p => p.filename === change.filename);
      if (failRotation === 'before') {failRotation=null;return route.abort('failed');}
      const replayed = change.operation_id && photo.operation?.operation_id === change.operation_id;
      if (stale || (replayed ? photo.operation.expected_revision !== change.expected_revision
        || photo.operation.photo_rotation_degrees !== change.photo_rotation_degrees
        : change.expected_revision !== photo.photo_rotation_revision)) {
        return route.fulfill({status:409,json:{message:'This photo was rotated elsewhere. Reopen it from the gallery before saving.'}});
      }
      if (photo.photo_rotation_degrees !== change.photo_rotation_degrees) {
        photo.photo_rotation_degrees = change.photo_rotation_degrees; photo.photo_rotation_revision++;
      }
      photo.operation = change;
      if (failRotation === 'after') {failRotation=null;return route.abort('failed');}
      result = {success:true,photo_rotation_revision:photo.photo_rotation_revision};
    } else if (path === '/api/delete-image') {
      photos.splice(photos.findIndex(p => p.filename === JSON.parse(body).filename),1);
    } else if (path.startsWith('/api/upload-')) {
      const photo = photos.find(p => p.filename === field(body,'filename'));
      if (Number(field(body,'photo_rotation_revision')) !== photo.photo_rotation_revision) return route.fulfill({status:409,json:{message:'Stale photo pixels'}});
      if (path === '/api/upload-thumb' && failThumb) {failThumb=false;return route.fulfill({status:500,json:{message:'Thumbnail interrupted'}});}
      if (path === '/api/upload-dithered') {photo.needs_processing=false;photo.thumb_ready=true;}
    } else if (path === '/api/flash-test-card') result = {success:true,job_id:8};
    else if (path === '/api/flash/status/8') result = {job_id:8,filename:'orientation-test-card.png',created_at:100,status:jobStatus};
    await route.fulfill({json:result});
  });
  await page.goto('/frame/'); const file = await fixture(page); source = file.buffer;
  await page.locator('#connect').click(); await expect(page.locator('#frame-detail')).toContainText('Connected');
  return {photos,requests,file,complete:()=>{jobStatus='Completed';},stale:()=>{stale=true;},
    failRotation:stage=>{failRotation=stage;},
    rotateElsewhere:()=>{photos[0].photo_rotation_degrees=270;photos[0].photo_rotation_revision++;delete photos[0].operation;}};
}

async function choose(page, file) {
  await page.locator('#photo').setInputFiles(file);
  await expect(page.locator('#save')).toBeEnabled();
}

test('photo rotation survives upload, reload and later editing without replacing the original', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const f = await frame(page); await choose(page,f.file);
  await page.locator('#photo_rotation_degrees').selectOption('90');
  await expect(page.locator('#save')).toBeEnabled(); await page.locator('#save').click();
  await expect(page.locator('#activity-title')).toHaveText('Photo saved.');
  expect(f.photos[0].photo_rotation_degrees).toBe(90);
  await page.reload(); await expect(page.locator('#save')).toBeEnabled();
  await expect(page.locator('#photo_rotation_degrees')).toHaveValue('90');
  await page.locator('#gallery-tab').click(); await page.getByRole('button',{name:f.photos[0].filename,exact:true}).click();
  await expect(page.locator('#photo_rotation_degrees')).toHaveValue('90');
  await page.locator('#photo_rotation_degrees').selectOption('270');
  await expect(page.locator('#save')).toBeEnabled(); await page.locator('#save').click();
  await expect(page.locator('#activity-title')).toHaveText('Photo saved.');
  expect(f.photos[0].photo_rotation_degrees).toBe(270);
  expect(f.photos[0].photo_rotation_revision).toBe(2);
  expect(f.requests.filter(r=>r.path==='/upload')).toHaveLength(1);
  expect(f.requests.some(r=>r.path==='/flash')).toBe(false);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await mkdir('docs/screenshots',{recursive:true});
  await page.screenshot({path:'docs/screenshots/frame-photo-rotation.png',fullPage:true});
});

test('accepted photo revision survives a partial upload and retry', async ({page}) => {
  const f = await frame(page,{failThumb:true}); await choose(page,f.file);
  await page.locator('#photo_rotation_degrees').selectOption('180'); await expect(page.locator('#save')).toBeEnabled();
  await page.locator('#save').click(); await expect(page.locator('#activity-detail')).toContainText('Thumbnail interrupted');
  await expect(page.locator('#save')).toBeEnabled(); await page.locator('#save').click();
  await expect(page.locator('#activity-title')).toHaveText('Photo saved.');
  expect(f.requests.filter(r=>r.path==='/upload')).toHaveLength(1);
  expect(f.requests.filter(r=>r.path==='/api/settings/photo-rotation').map(r=>JSON.parse(r.body).expected_revision)).toEqual([0,1]);
});

async function storedDraft(page) {
  return page.evaluate(async () => (await import('/frame/services/drafts.js')).readDraft());
}

for (const failure of ['before', 'after']) {
  for (const reopen of [false, true]) {
    test(`rotation retry recovers a failure ${failure} acceptance${reopen ? ' after reopening the app' : ''}`, async ({page}) => {
      const f = await frame(page,{failRotation:failure}); await choose(page,f.file);
      await page.locator('#photo_rotation_degrees').selectOption('90');
      await page.locator('#brightness').fill('15'); await page.locator('#brightness').dispatchEvent('input');
      await expect(page.locator('#save')).toBeEnabled(); await page.locator('#save').click();
      await expect(page.locator('#activity-detail')).toContainText('Cannot reach the frame');
      const checkpoint = await storedDraft(page);
      expect(checkpoint.photo_rotation_revision).toBe(0);
      expect(checkpoint.pending_photo_rotation).toMatchObject({filename:f.photos[0].filename,expected_revision:0,photo_rotation_degrees:90});
      if (reopen) {
        // A new edit session must recover the persisted receipt, not just memory.
        await page.evaluate(() => sessionStorage.clear());
        await page.reload(); await expect(page.locator('#frame-detail')).toContainText('Connected');
      }
      await expect(page.locator('#save')).toBeEnabled();
      expect(f.requests.filter(r=>r.path==='/api/settings/photo-rotation')).toHaveLength(1);
      await expect(page.locator('#brightness')).toHaveValue('15');
      await expect(page.locator('#photo_rotation_degrees')).toHaveValue('90');
      await page.locator('#save').click(); await expect(page.locator('#activity-title')).toHaveText('Photo saved.');
      const rotations = f.requests.filter(r=>r.path==='/api/settings/photo-rotation').map(r=>JSON.parse(r.body));
      expect(rotations).toHaveLength(2);
      expect(rotations[1]).toMatchObject({operation_id:rotations[0].operation_id,expected_revision:0});
      if (reopen) expect(rotations[1].session_id).not.toBe(rotations[0].session_id);
      expect(f.photos[0].photo_rotation_revision).toBe(1);
      expect(f.requests.filter(r=>r.path==='/upload')).toHaveLength(1);
      expect(f.requests.filter(r=>r.path==='/api/upload-cache').map(r=>field(r.body,'brightness'))).toEqual(['15']);
      expect((await storedDraft(page)).pending_photo_rotation).toBeNull();
    });
  }
}

test('retry resolves a lost rotation before applying a newly chosen angle', async ({page}) => {
  const f = await frame(page,{failRotation:'after'}); await choose(page,f.file);
  await page.locator('#photo_rotation_degrees').selectOption('90');
  await expect(page.locator('#save')).toBeEnabled(); await page.locator('#save').click();
  await expect(page.locator('#activity-detail')).toContainText('Cannot reach the frame');
  await page.locator('#photo_rotation_degrees').selectOption('180');
  await expect(page.locator('#save')).toBeEnabled(); await page.locator('#save').click();
  await expect(page.locator('#activity-title')).toHaveText('Photo saved.');
  const rotations = f.requests.filter(r=>r.path==='/api/settings/photo-rotation').map(r=>JSON.parse(r.body));
  expect(rotations.map(r=>[r.photo_rotation_degrees,r.expected_revision])).toEqual([[90,0],[90,0],[180,1]]);
  expect(rotations[1].operation_id).toBe(rotations[0].operation_id);
  expect(rotations[2].operation_id).not.toBe(rotations[0].operation_id);
  expect(f.photos[0].photo_rotation_revision).toBe(2);
  expect(f.requests.filter(r=>r.path==='/api/upload-cache').map(r=>field(r.body,'photo_rotation_revision'))).toEqual(['2']);
});

test('a lost-response retry still rejects another editor’s subsequent rotation', async ({page}) => {
  const f = await frame(page,{failRotation:'after'}); await choose(page,f.file);
  await page.locator('#photo_rotation_degrees').selectOption('90');
  await expect(page.locator('#save')).toBeEnabled(); await page.locator('#save').click();
  await expect(page.locator('#activity-detail')).toContainText('Cannot reach the frame');
  f.rotateElsewhere();
  await expect(page.locator('#save')).toBeEnabled(); await page.locator('#save').click();
  await expect(page.locator('#activity-detail')).toContainText('rotated elsewhere');
  expect(f.photos[0].photo_rotation_degrees).toBe(270);
  expect(f.requests.filter(r=>r.path.startsWith('/api/upload-'))).toHaveLength(0);
  await expect(page.locator('#photo_rotation_degrees')).toHaveValue('90');
});

for (const identity of ['copied', 'deleted']) {
  test(`a ${identity} photo resets its revision before an interrupted first save`, async ({page}) => {
    const f = await frame(page,{pending:true});
    await expect(page.locator('#import-summary')).toContainText('1 of 1 saved');
    await page.locator('#gallery-tab').click(); await page.getByRole('button',{name:'saved.png',exact:true}).click();
    await expect(page.locator('#save')).toBeEnabled();
    if (identity === 'copied') {
      // A persisted draft copied from another frame carries that photo's revision.
      await page.evaluate(async () => {
        const {readDraft,saveDraft} = await import('/frame/services/drafts.js');
        const draft = await readDraft(); draft.sourceFrame='http://other-frame.local:8000';
        draft.pending_photo_rotation={base:draft.sourceFrame,filename:draft.sourceFilename,
          operation_id:'old-operation',photo_rotation_degrees:270,expected_revision:3};
        await saveDraft(draft);
      });
      await page.reload(); await expect(page.locator('#frame-detail')).toContainText('Connected');
    } else {
      await page.locator('#delete').click(); await page.locator('#confirm-delete').click();
      await expect(page.locator('#activity-title')).toHaveText('Photo deleted from the frame.');
      expect((await storedDraft(page)).photo_rotation_revision).toBe(0);
    }
    f.failRotation('before');
    await expect(page.locator('#save')).toBeEnabled(); await page.locator('#save').click();
    await expect(page.locator('#activity-detail')).toContainText('Cannot reach the frame');
    const checkpoint=await storedDraft(page);
    expect(checkpoint.photo_rotation_revision).toBe(0);
    expect(checkpoint.sourceFilename).not.toBe('saved.png');
    expect(checkpoint.pending_photo_rotation.expected_revision).toBe(0);
    expect(checkpoint.pending_photo_rotation.operation_id).not.toBe('old-operation');
    await expect(page.locator('#save')).toBeEnabled(); await page.locator('#save').click();
    await expect(page.locator('#activity-title')).toHaveText('Photo saved.');
    expect(f.requests.filter(r=>r.path==='/upload')).toHaveLength(1);
    const rotations=f.requests.filter(r=>r.path==='/api/settings/photo-rotation').map(r=>JSON.parse(r.body));
    expect(rotations.slice(-2).map(r=>r.expected_revision)).toEqual([0,0]);
    expect(f.photos.find(p=>p.filename===checkpoint.sourceFilename).photo_rotation_degrees).toBe(270);
  });
}

test('regenerating a saved photo keeps its source rotation and rejects stale edits', async ({page}) => {
  const f = await frame(page,{pending:true});
  await expect(page.locator('#import-summary')).toContainText('1 of 1 saved');
  expect(JSON.parse(f.requests.find(r=>r.path==='/api/settings/photo-rotation').body)).toMatchObject({photo_rotation_degrees:270,expected_revision:4});
  await page.locator('#gallery-tab').click(); await page.getByRole('button',{name:'saved.png',exact:true}).click();
  await expect(page.locator('#save')).toBeEnabled(); f.stale();
  await page.locator('#photo_rotation_degrees').selectOption('90'); await expect(page.locator('#save')).toBeEnabled();
  const uploads = f.requests.filter(r=>r.path.startsWith('/api/upload-')).length;
  await page.locator('#save').click(); await expect(page.locator('#activity-detail')).toContainText('rotated elsewhere');
  expect(f.requests.filter(r=>r.path.startsWith('/api/upload-'))).toHaveLength(uploads);
});

test('orientation card tracks progress in Settings and leaves the photo draft and gallery intact', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const f = await frame(page); await choose(page,f.file);
  await page.locator('#photo_rotation_degrees').selectOption('90'); await expect(page.locator('#save')).toBeEnabled();
  await page.locator('#settings-tab').click();
  await page.locator('#orientation').selectOption('90'); await expect(page.locator('#test-orientation')).toBeDisabled();
  await page.locator('#orientation').selectOption('0'); await expect(page.locator('#test-orientation')).toBeEnabled();
  await page.locator('#test-orientation').click(); await expect(page.locator('#test-activity-title')).toHaveText('Refreshing your frame…');
  await expect(page.locator('#test-orientation')).toBeDisabled(); await expect(page.locator('#test-send-progress')).toBeVisible();
  await mkdir('docs/screenshots',{recursive:true});
  await page.screenshot({path:'docs/screenshots/frame-orientation-test-card.png',fullPage:true});
  f.complete(); await expect(page.locator('#test-activity-title')).toHaveText('Orientation test card displayed.',{timeout:10000});
  expect(f.requests.filter(r=>r.path==='/api/flash-test-card')).toHaveLength(1);
  expect(field(f.requests.find(r=>r.path==='/api/flash-test-card').body,'rotation_revision')).toBe('3');
  expect(f.requests.some(r=>r.path==='/upload'||r.path==='/flash')).toBe(false);
  expect(f.photos).toHaveLength(0);
  await page.locator('#choose-tab').click(); await expect(page.locator('#photo_rotation_degrees')).toHaveValue('90');
  await expect(page.locator('#draft-name')).toHaveText('corners.png');
});

test('quarter-turn source pixels are rotated before fitting, while test cards use exact panel palettes', async ({page}) => {
  await page.goto('/frame/');
  const results = await page.evaluate(async () => {
    const {processPhoto} = await import('/frame/services/processor.js');
    const {orientationTestCard} = await import('/frame/services/test-card.js');
    const src = document.createElement('canvas'); src.width=6;src.height=4;
    const ctx=src.getContext('2d');
    ['#f00','#0f0','#00f','#ff0'].forEach((color,i)=>{ctx.fillStyle=color;ctx.fillRect(i%2*3,Math.floor(i/2)*2,3,2);});
    const blob=await new Promise(resolve=>src.toBlob(resolve));
    const result=[];
    for(const degrees of [0,90,180,270]) {
      const width=degrees%180 ? 4:6, height=degrees%180 ? 6:4;
      const processed=await processPhoto({blob,photo_rotation_degrees:degrees,fit:'contain',filter:'nearest',saturation:0},
        {model:'impression-5.7',width,height,thumb_width:width,thumb_height:height,rotation_revision:3});
      const bitmap=await createImageBitmap(processed.cache);const canvas=new OffscreenCanvas(width,height);
      const c=canvas.getContext('2d');c.drawImage(bitmap,0,0);bitmap.close();
      const points=[[0,0],[width-1,0],[0,height-1],[width-1,height-1]];
      result.push(points.map(([x,y])=>Array.from(c.getImageData(x,y,1,1).data).slice(0,3)));
    }
    const cards=[];
    for(const [model,w,h] of [['impression-5.7',600,448],['impression-13.3-2025',1600,1200]]) {
      for(const degrees of [0,90,180,270]) {
        const width=degrees%180?h:w,height=degrees%180?w:h;
        const card=await orientationTestCard({model,width,height,rotation_degrees:degrees});
        const bitmap=await createImageBitmap(card);const c=new OffscreenCanvas(width,height).getContext('2d');c.drawImage(bitmap,0,0);bitmap.close();
        const data=c.getImageData(0,0,width,height).data;
        let valid=true;for(let i=0;i<data.length;i+=4) if(![0,255].includes(data[i])||data[i]!==data[i+1]||data[i]!==data[i+2]||data[i+3]!==255) {valid=false;break;}
        cards.push(valid);
      }
    }
    return {result,cards};
  });
  const R=[255,0,0],G=[0,255,0],B=[0,0,255],Y=[255,255,0];
  expect(results.result).toEqual([[R,G,B,Y],[B,R,Y,G],[Y,B,G,R],[G,Y,R,B]]);
  expect(results.cards).toEqual(Array(8).fill(true));
});
