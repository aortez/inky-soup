# Shared app rotation synchronization

Validated on 2026-10-25 after importing the published website's rotation changes
through `a44aedb2317d26de24e71be8623ded4ea0ff0e1f` into the shared app from #28.
The native picker, Back/lifecycle handling, offline profiles, draft store, and
web-only PWA update boundary are retained.

## Automated checks

- 9 Node unit tests passed.
- 50 web editor/setup tests passed, including 13 imported photo-rotation tests:
  lost responses before/after acceptance, persisted retry with a new session,
  changed angles before retry, conflicting edits, copied drafts, delete/resave,
  test-card progress, and exact source-rotation/palette checks.
- 8 built-web PWA tests passed.
- 5 Android-bundle browser tests passed. Both panel profiles and layouts retain
  rotation after reload. All four angles produce the expected clockwise source
  corners in both layouts and sizes. No external requests or service worker were
  observed, and frame-only test-card controls stay hidden and disabled.
- The debug APK builds with JDK 21 and Android SDK 36. Its bundled worker matches
  the source, rotation-recovery code is present, and no PWA service worker is
  packaged. APK SHA-256:
  `5b4404cec224d5d0df7a22b6f01799db0296bba28a2bb5c7d4b5afcc8744a5d9`.

Commands are the standard checks in `app/README.md`. The web suite used port
18085 via a temporary Playwright configuration because 8080 was initially in
use; no application/test behavior was changed for that run.

## Physical Android check

Updated the existing debug app with `adb install -r` on the Pixel 9 Pro XL
(Android 17/API 37, WebView 155). The existing disposable
`inky-android-shell-colors.png` draft survived the update.

The extended `app/tools/android-shell-check.mjs` passed native picker cancellation,
Back navigation, all four photo angles at all four panel/layout dimensions, and
offline force-stop/relaunch. The 270° angle, photo, composition, brightness, and
profile survived the cold restart. No external HTTP requests, page errors, or
service workers were observed. Phone network and stay-awake settings were restored.

- [Device results](android-rotation-sync-pixel9.json)
- [Native preview](android-rotation-sync-pixel9.png)

The Android shell still previews locally; native Pi networking and Bluetooth
remain #21/#22. Web API behavior is covered by the imported mock-server regressions;
no physical Pi display was refreshed during this synchronization. Hosted website
artifact consumption remains a separate migration.
