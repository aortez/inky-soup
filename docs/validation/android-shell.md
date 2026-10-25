# Android Frame shell (#20)

Validated on 2026-10-25 using a Pixel 9 Pro XL, Android 17 / API 37, and Android
WebView 155.0.8059.39. This tests the bundled Android editor; no Pi display was
refreshed, and native Pi networking/Bluetooth remain #21/#22.

## Artifact

- Package: `pizza.allan.frame`, version `0.1.0` / code `1`, debug signed.
- Capacitor 8.5.3; minimum SDK 24, compile/target SDK 36.
- Build: Node 24.11.1, Temurin JDK 21.0.13, SDK platform 36/build-tools 36.0.0.
- Command: `cd app && npm ci && npm run build:android` with Java/SDK environment configured.
- APK: `app/android/app/build/outputs/apk/debug/app-debug.apk`.
- Final APK SHA-256: `caaadbe1a5ee46dc9e8420daa79e74d8da9de1cbe94efb757fa81fa516bec13d`.

The imported frontend is the website's published master revision
`5bbd462ce4f6508eb3bd4179fceacc97035bb610`, not its concurrent photo-rotation
branch or uncommitted work. The website checkout and deployed site were not changed.

## Automated checks

- 8 Node unit tests: settings, capabilities, session/update constraints, pinned
  worker provenance, and offline display geometry.
- 37 web editor and browser BLE setup tests.
- 8 built-PWA cache/update/draft-recovery tests.
- 4 Android-bundle browser tests: both panel profiles in both orientations,
  exact output palettes, draft restoration, no external requests, and no service worker.
- Debug APK Gradle build succeeds. Inspection confirms bundled root HTML and
  worker assets and no `frame/sw.js` in the APK.
- Runtime npm dependency audit: zero reported vulnerabilities. The development
  CLI currently reports three moderate findings in its transitive iOS Xcode/uuid
  tooling; those dependencies are not packaged in the Android app.

The imported website-only Go demo test was removed from this app's suite. Its
unrelated website artifacts stay with the website. Browser suites have separate
output directories. The offline PWA test explicitly emulates both network
transport and navigator state on current Chromium.

## Physical phone checks

1. Installed and opened the actual APK on the connected phone.
2. Used Android's real system picker → Browse → Downloads to select the disposable
   `inky-android-shell-colors.png` fixture. No personal photo was needed.
3. Reopened/cancelled the picker and retained the draft.
4. Processed the real selected file with the bundled worker at 600 × 448,
   448 × 600, 1600 × 1200, and 1200 × 1600.
5. Used Android Back to return from Settings to Create, then minimize the app
   after saving the draft.
6. Disabled Wi-Fi and mobile data, force-stopped the app, and relaunched it.
   The original selected file, composition, brightness, and portrait profile
   survived and regenerated a usable preview.
7. Observed no page errors, service workers, or external HTTP(S) requests during
   the device check. Phone network and stay-awake settings were restored.

The separate fresh-launch check cleared only this newly created prototype's
disposable test data, disabled both networks, then launched the bundled editor
with photo selection enabled. It loaded only `https://localhost` APK assets.
That check preceded the final system-bar color configuration; the final APK
then passed the full cold-start/draft-recovery run.

Evidence:

- [Device check](android-shell-pixel9.json)
- [Fresh offline launch](android-shell-fresh-launch.json)
- [Phone screenshot](android-shell-pixel9.png)

Repeat after selecting a disposable photo with:

```sh
cd app
node tools/android-shell-check.mjs --serial DEVICE_SERIAL --output /tmp/frame-check.json
```

The helper observes native Activity focus when checking minimization and attaches
to the new process's WebView after a cold restart. Background Android WebViews can
pause JavaScript, so DOM visibility polling is not used to prove minimization.

## Limits

Only this physical Android/WebView combination has been validated. Public release
signing, install/update distribution, native networking, and native BLE are later
issues. The modern web build is available from this source, with consumption
instructions in `app/README.md`; the existing website CI has not yet been switched
to the new artifact. No legacy Pi frontend was removed.
