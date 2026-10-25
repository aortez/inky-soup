# Frame app

The shared modern Frame UI and Android shell live here. The editor is imported
from the published `aortez.github.io` master revision recorded in `source.json`;
unmerged work in the website checkout was not imported. Source and worker license
notices are retained in `LICENSE` and `public/frame/vendor/`.

## Prototype scope (#20)

The Android APK bundles the editor, photo picker, image-processing workers, and
IndexedDB draft storage. It can preview both panels in landscape or portrait
without internet or a connected frame. Settings selects the preview display.
Android Back returns from Settings to Create, then saves the draft and minimizes
the app. Cancelling the system photo picker preserves the existing draft.

This shell does not yet connect to a Pi or perform Bluetooth setup. Those are
issues #21 and #22; discovery/reconnection and signed public updates follow in
#23 and #24. The existing web build keeps its working device and setup flows.
The Pi-hosted legacy UI remains until #26.

## Build and install

Prerequisites:

- Node.js 22.12+ (Node 24 recommended) and npm.
- A full **JDK 21**, including `javac`; a Java runtime alone cannot build the APK.
- Android SDK platform 36, build-tools 36.0.0, platform-tools, and accepted SDK
  licenses. Android Studio can install them, or use `sdkmanager`.
- Set `JAVA_HOME` and `ANDROID_HOME`, or configure the SDK using Android Studio's
  ignored `android/local.properties`.

```sh
cd app
npm ci
sdkmanager 'platforms;android-36' 'build-tools;36.0.0' 'platform-tools'
npm run build:android
adb -s YOUR_DEVICE_SERIAL install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s YOUR_DEVICE_SERIAL shell am start -n pizza.allan.frame/.MainActivity
```

`build:android` builds the bundled assets, synchronizes Capacitor, and invokes
the checked-in Gradle wrapper. No Vite server, ADB reverse tunnel, or hosted
website is used by the installed app. The app's `https://localhost` origin is
served internally by Capacitor from APK assets; it is not a LAN HTTPS server.

The package is `pizza.allan.frame`, with minimum SDK 24 (Android 7), compile/target
SDK 36 (Android 16), and Capacitor 8.5.3. The SDK minimum is not a claim that all
old Android/WebView combinations have been physically validated: use a maintained
WebView with workers, OffscreenCanvas, IndexedDB, and Web Locks support. Validation
records identify the actual phone/WebView tested.

This is a debug-signed development APK. The signing key comes from the builder's
Android debug keystore, so APKs from another machine/CI may not update this local
installation. Do not uninstall an app with a draft merely to bypass a signature
mismatch. Stable distribution signing and in-app updates belong to #24.

## Web and Android boundaries

- `frame/core/platform.js` selects the build target.
- `frame/services/native-app.js` handles Android back/lifecycle events.
- `frame/core/preview-profile.js` supplies persisted offline preview profiles.
- Both targets use the same editor, worker, and draft-store modules.
- Web output is `dist/`; Android output is `dist-android/` with a root entry.
- Only the web build generates/registers `/frame/sw.js`. Android UI and worker
  code advance together through APK installation.
- Native networking and BLE will sit behind platform adapters; the current
  shell does not relax server CORS or load remote website code.

## Verification

```sh
npm run test:unit
npx playwright install chromium
npm test                    # Modern web editor and existing browser BLE setup.
npm run test:pwa            # Built web app, cached launch, and update lifecycle.
npm run test:android:web    # Bundled Android assets, both palettes and orientations.
npm run build:android
```

Browser suites use separate output directories and ports 8080, 4173, and 4174.
Android-target browser tests exercise the built assets, not Android native APIs.
Real-device validation must also cover the system photo picker, Back, process
restart, and launch with phone networking disabled. Use a debug APK for WebView
inspection; never enable debugging in a public release just for these checks.

After installing the APK and selecting a disposable photo through Android's
system picker, run the repeatable device check:

```sh
node tools/android-shell-check.mjs --serial YOUR_DEVICE_SERIAL --output /tmp/frame-check.json
```

It changes preview settings, exercises picker cancellation and Back, force-stops
the app, and temporarily disables Wi-Fi/mobile data to test offline recovery.
Network and stay-awake settings are restored in a `finally` block. The script
writes a JSON record and screenshot and does not contact or refresh a Pi.

## Publishing the same frontend on allan.pizza

This repository owns the frontend source. The website should consume a built
artifact or a pinned revision of this directory, rather than copy and edit
`frame/` and its workers. The Frame app CI workflow publishes `frame-web` and
`frame-android-debug` artifacts for review.

For a website release, build the website's unrelated pages first, then overlay
the complete output of `npm ci && npm run build` from this directory into the
website's Pages artifact:

```sh
# From the inky-soup checkout, after both builds have completed.
cp -a app/dist/. /path/to/aortez.github.io/dist/
```

This supplies `/frame/`, `/setup/`, `/wifi/`, and their hashed `/assets/` files.
Preserve unrelated website files, including its CNAME and Go demo assets. Remove
those three old entries from the website Vite build and retire their copied
sources when its CI is switched to consuming this artifact. Pin the inky-soup
revision used for each website deployment, and overlay the entire build so HTML,
workers, and service-worker cache hashes always agree.

The website checkout and live Pages deployment are not modified by building the
Android prototype. Its active photo-rotation work must be reconciled when that
consumer migration lands; see the immutable source revision in `source.json`.
