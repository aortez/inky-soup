import {App} from '@capacitor/app';

export async function watchNativeApp({back, save, failed}) {
  await App.addListener('backButton', async () => {
    try {
      if (back()) return;
      await save();
      await App.minimizeApp();
    } catch (error) { failed(error); }
  });
  await App.addListener('appStateChange', async ({isActive}) => {
    if (isActive) return;
    try { await save(); } catch (error) { failed(error); }
  });
}
