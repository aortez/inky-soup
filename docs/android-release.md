# Android releases and in-app updates (#24)

The Frame app is distributed outside Google Play as a signed APK that the
`Frame app release` GitHub Actions workflow builds from a tag. The installed app
finds newer releases itself, downloads and verifies the APK, and hands it to
Android's package installer, which asks the user before replacing the app.

## Signing identity

The application ID is `pizza.allan.frame`. One release key signs every public
build. Android installs an update only when it is signed by the same key as the
installed app, so a lost key forces users to uninstall, which discards drafts and
remembered frames. Protect the keystore accordingly.

Create the key once on a trusted computer and record its certificate digest:

```sh
keytool -genkeypair -v -keystore frame-release.jks -storetype PKCS12 -alias frame \
  -keyalg RSA -keysize 4096 -validity 10950 -dname "CN=Sparkle Duck Frame, O=Inky Soup"
keytool -list -v -keystore frame-release.jks -alias frame | grep SHA256
```

Keep at least two offline copies of the keystore and its password, for example an
encrypted drive and a password-manager attachment, and record where they are.
Never commit the file: `app/.gitignore` already ignores `*.jks` and `*.keystore`.
Recovery means restoring one of those copies and re-creating the CI secrets; there
is no other way to sign a compatible update.

Add these repository secrets (Settings, Secrets and variables, Actions):

| Secret | Value |
| --- | --- |
| `FRAME_RELEASE_KEYSTORE_BASE64` | Output of `base64 -w0 frame-release.jks` |
| `FRAME_RELEASE_KEYSTORE_PASSWORD` | The keystore password |
| `FRAME_RELEASE_KEY_ALIAS` | `frame` |
| `FRAME_RELEASE_KEY_PASSWORD` | The key password; for PKCS12 this is the keystore password |

`app/android/app/build.gradle` reads `FRAME_RELEASE_KEYSTORE`,
`FRAME_RELEASE_KEYSTORE_PASSWORD`, `FRAME_RELEASE_KEY_ALIAS`, and
`FRAME_RELEASE_KEY_PASSWORD` from the environment. Without them a release build
stays unsigned and Android refuses to install it. To sign locally, export the same
variables with a path to the keystore and run `./gradlew :app:assembleRelease` in
`app/android`.

## Versions

`app/package.json` holds the only app version. Gradle derives `versionName` from it
and computes `versionCode` as `major × 1,000,000 + minor × 1,000 + patch`, so each
part must stay at or below 999 and every increase produces a larger code. Bump the
version in an ordinary pull request. The release tag must be `app-v<version>`; the
workflow refuses a tag that does not match the merged `package.json`.

## Publishing a release

1. Merge the version bump to `main`.
2. Tag that commit and push the tag deliberately, for example
   `git tag app-v0.2.0 && git push origin app-v0.2.0`.
3. The workflow checks that the tag matches `package.json` and points at a commit
   on `main`, runs the app unit tests, builds the bundled assets, builds and signs
   the release APK, runs the Java unit tests and Android lint on the release
   variant, verifies the signature with `apksigner`, and writes the release
   metadata with `app/tools/release-manifest.mjs`.
4. It publishes a versioned release named after the tag with generated notes and
   three assets: `frame.apk`, `frame.apk.sha256`, and `frame-release.json`.
5. It replaces the same three assets on the rolling `frame-app` release, which is
   created on the first run and never marked as GitHub's latest release. That
   release only ever carries app assets, so the links below stay valid when server
   or image releases are added later. Re-running a failed job replaces the assets
   on both releases instead of failing on the existing one.

`workflow_dispatch` builds and uploads the signed files as a workflow artifact
without publishing. Every run needs the signing secrets.

Stable links:

- First install, suitable for a QR code:
  `https://github.com/aortez/inky-soup/releases/download/frame-app/frame.apk`
- Update metadata read by the app:
  `https://github.com/aortez/inky-soup/releases/download/frame-app/frame-release.json`
- History and notes: `https://github.com/aortez/inky-soup/releases`

`frame-release.json` records `application_id`, `version_name`, `version_code`,
`min_sdk`, `apk_url` (the versioned asset), `apk_sha256`, `apk_size`,
`signing_sha256` (the signer certificate digest printed by `apksigner`), optional
`notes`, `release_url`, and `published_at`. The app validates every field it uses;
`published_at` is informational. `apk_url` must point at the manifest's own host.

## First installation

Open the install link in the phone's browser, download `frame.apk`, and open it.
Android asks once to allow that browser to install unknown apps; this permission
belongs to the browser, not to the Frame app. Confirm the installation. No developer
computer or ADB is needed. Compare `frame.apk.sha256` when installing from a copied
file.

Development builds from `npm run build:android` are signed with the builder's
debug key. A release cannot update them: the app reports a signing-key mismatch
instead of downloading. Save drafts and note remembered frames before replacing a
debug build, because uninstalling clears both.

## In-app updates

Settings shows the installed version and build code under **This app** with
**Check for updates**. The app also checks automatically when it launches or
returns to the foreground, at most once every six hours, and remembers the last
answer so an offered release stays visible inside that interval. Checks need
internet access to GitHub; using a frame on the local network never does.

- **Check**: the native `FrameUpdate` plugin fetches `frame-release.json` over HTTPS
  with a 64 KiB limit and a 20-second deadline. Redirects that change protocol are
  never followed. A release is offered only when it names the same application ID
  and signing certificate as the installed app, its `min_sdk` is not above the
  phone's Android version, and its `version_code` is higher. Other outcomes are
  explained without a download. When a due check cannot reach GitHub, the last
  remembered release and any verified download stay available.
- **Download**: the APK streams into app-private cache storage with progress and a
  64 MiB limit. The size and SHA-256 must match the metadata, otherwise the file is
  discarded and the release stays available for a retry. The user can cancel.
  One verified package is kept, survives an app restart, and is hashed again
  before installation.
- **Install**: the app's own **Install unknown apps** permission is required. The
  first attempt opens that Android Settings page; return to the app and tap
  **Install update** again. The app saves the draft, hashes the package again, and
  parses it: its package name and signing certificate must match the installed app
  and its version code must be higher, so a manipulated manifest cannot turn the
  updater into a prompt to install some other app. Only then does Android's
  installer open through a `FileProvider` URI. Confirming replaces the app and the
  user reopens it as the new version; cancelling returns to the app with the
  download still ready. A package that is missing, altered, or rejected is
  discarded and the release goes back to **Download update**.
- **Deferral**: installation waits while photos are processing, uploading, or
  importing, while a connection is in progress, and while a display refresh is
  being tracked. The banner and Settings explain what to finish first. Checking and
  downloading never submit a display job, and reopening the app after an update
  reconciles any saved job without resubmitting it.

| Situation | Result |
| --- | --- |
| No internet or GitHub unreachable | Background checks stay silent; a manual check reports the problem |
| Metadata malformed, on another host, or served over HTTP | "The update information could not be read" and no download |
| Redirect to a non-HTTPS address | "The update server redirected to an address the app does not trust" |
| Different signing key or application ID | Explained, no download; keep using the installed build |
| Download interrupted, truncated, or altered | Partial file removed; **Download update** retries |
| Retained package missing, altered, or not this app's newer build | Package discarded; **Download update** returns |
| Installer permission declined | Notice to allow installs in Android Settings; retry later |
| Installer cancelled | App continues; the verified package remains ready |
| Phone without a package installer | Error message; the installed app keeps working |

## Developer verification

Google's [Android developer verification](https://developer.android.com/developer-verification)
program applies to apps installed on certified devices from outside Google Play,
registered through the Android Developer Console. According to Google's timeline,
verification opened to all developers in March 2026, enforcement began on
30 September 2026 for installs from participating stores in Brazil, Indonesia,
Singapore, and Thailand on certified devices running Android 7 and later, and the
requirement expands globally in 2027. Google also announced limited-distribution
accounts for students, teachers, and hobbyists, covering up to 20 devices without
a government ID or registration fee, and an advanced flow for users who choose to
install apps from unverified developers.

For this project, register the application ID `pizza.allan.frame` and the release
signing certificate with the Android Developer Console before the global rollout,
using a limited-distribution account while the app stays a prototype with a
handful of devices. The requirements, fees, and dates are Google's and change;
check the page above before each release. A Play Store listing remains outside
this prototype.

## Validation

Hardware acceptance for #24 has not been recorded yet. The checklist:

1. Publish two signed versions and install the older one from the stable link on
   the test phone, allowing the browser to install unknown apps.
2. Create a draft, change preview settings, and remember both frames.
3. Check for updates, download the newer version, and install it. Confirm the
   draft, settings, remembered frames, and job receipts survive.
4. Cancel the installer once and decline the install permission once; the app must
   stay usable and offer the download again.
5. Interrupt a download by turning off WiFi and mobile data, then retry.
6. Serve metadata with a wrong checksum or a different signing digest from a test
   build and confirm the app refuses without touching the installed version.
7. Start a display refresh and confirm installation is deferred until it finishes,
   with no duplicate display job.

Record the APK versions, signer digest, Android and WebView versions, and results
in `docs/validation/`, as for the other Android checks.
