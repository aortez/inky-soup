# Signed Android interruption checks — November 11, 2026

Signed Frame 0.2.3 passed four controlled network interruptions on each real
frame. Partial uploads recovered without duplicate originals. Lost submission
and status responses caused no automatic second refresh, including after a
force-stop and cold relaunch. Both original libraries, displayed PNGs and the
phone's original draft/settings were preserved exactly.

This completes the focused interruption follow-up to the
[signed-release check](android-release-0.2.3.md). The complete
[#25 acceptance checklist](android-acceptance-audit.md) remains open.

## Build and topology

- Pixel 9 Pro XL, Android 17 / SDK 37, build `CP2A.260605.016`, WebView
  `155.0.8059.39`. Installed package `pizza.allan.frame`, 0.2.3/build 2003,
  source `6867d5b`. Its APK remained unchanged at SHA-256
  `ba05a98663ce71d9071da344d6c79466fce7eb1c7b684f789691194da8a89535`.
- Small: Pi Zero 2 W, 5.7-inch seven-color, `192.168.1.100:8000`, 600 × 448.
  Large: Pi Zero W, 13.3-inch 2025 six-color, `192.168.1.109:8000`, 1600 × 1200.
  Both retained server `a422fcf` and their existing mounts/identities.
- A temporary proxy on LAN host `192.168.1.132` used ports 18080 and 18081 to
  forward to the real frame APIs. Android connected over native Wi-Fi HTTP;
  Playwright operated the UI and disposable photo input without replacing the
  native bridge or application implementation. Pi management used Wi-Fi SSH and
  HTTP only. No network profile, server deployment or phone APK was changed.
- Each fault ID fired once. For upload cuts, the proxy forwarded 4096 bytes of
  the actual request body before closing both connections. For response loss,
  it read the real upstream response and discarded it before returning headers
  or body to the phone. Neither proxy nor native transport retried a request.

## Cases on both models

| Case | Observed result |
| --- | --- |
| Cut `/upload` midway through the original | App reported “Could not finish saving”. No photo or display job was created. The exact draft survived cold relaunch; explicit Save retry created one original. Two on-wire original attempts total: one cut, one accepted. |
| Cut `/api/upload-thumb` after original/cache saves | App reported a save error; the same filename persisted and the API marked it `needs_processing`. Cold relaunch kept that original. After the old edit lease expired, retry/reconnect rebuilt the assets without another original upload or display job. |
| Discard the accepted `/flash` response | Server queued job 3. App showed the save error and instruction to check the frame before retrying. Cold relaunch sent no second submission. Independent CLI observation reached Completed for job 3. |
| Discard the first `/api/flash/status/4` response | The next deliberate Send created job 4. App showed “Refresh status unavailable” and retained its receipt. Cold relaunch restored that same ID, frame instance and creation timestamp, then reached Completed and cleared the receipt. No second submission occurred. |

A cold start creates a fresh editor session. Until the previous 30-second lease
expired, the app correctly showed the disposable photo as read-only and the
automatic rebuild could fail with an editing conflict. On the small frame,
**Retry failed photos** succeeded after expiry. On the large frame, a later
reconnect regenerated the incomplete assets after expiry. The tests did not
force-release another session's lock.

Each frame had exactly two accepted submissions, jobs 3 and 4: one deliberate
Send for each response-loss case. Proxy counts and independent server journal
entries agreed. CLI observers independently reported all four jobs Completed;
the small frame's final job-4 JSON body in the saved record comes from the
audited completed status response. Request counts, fault byte counts, receipts,
timestamps and journal lines are in the
[machine-readable record](android-interruption-2026-11-11.json).

## Matching-picture refreshes

The disposable source for each model was a private copy of its current prepared
display PNG. Nearest-neighbor resizing and color matching 0 preserve its encoded
ink identities. Before each response-loss test, the newly generated dithered PNG
was checked against the original display snapshot: both pixels and encoded PNG
bytes matched exactly. No display submission was allowed before that check.

An initial small-frame preparation used the wrong color-matching setting. The
preflight comparison rejected it before any flash. Correcting the fixture's
setting produced the exact match. These preparation saves touched only the
disposable photo.

All four jobs therefore refreshed the existing pictures. This is real signed
app/native HTTP/physical-driver coverage, but it is not a new owner confirmation
of color-card labels or orientation. That separate acceptance row remains open.

## Limits of submission recovery

When the `/flash` response is lost, the app has no job ID to persist. It reports
the uncertain save and requires checking the frame before a deliberate retry;
it does not automatically find or track that unknown job. An explicit second
Send is a new submission, not an idempotent retry. This run verifies the
documented no-automatic-resubmission behavior; it does not claim durable receipt
recovery or deduplication for a manually repeated Send.

Lost **status** responses are different: the receipt already exists, and both
models demonstrated automatic reconciliation of the same job after relaunch.

## Cleanup and reusable tooling

Exactly one disposable gallery photo per frame was removed, after checking its
original bytes and waiting for idle queues. All 36 original-photo and metadata
hashes matched the baseline: three photos plus three metadata files on the
small frame, 15 of each on the large. Display PNG hashes, gallery metadata,
mounts, persistent IDs and server instances also matched. Both server and
provisioner services were active, rescue cards inactive, and queues idle.

The original phone draft was checkpointed inside IndexedDB, restored, and
compared by its exact blob hash, metadata and nine controls. Both remembered
frames, original addresses, selected large frame and preview preference matched
the baseline. Job receipts were cleared. The temporary checkpoint was removed
and keep-awake restored to 0. Both proxy listeners were stopped. No private photo
pixels are included in the checked-in evidence.

The reusable [fault proxy](../../app/tools/frame-fault-proxy.py) is exposed as
[`inky-cli fault-proxy`](../../cli/README.md#controlled-network-interruptions).
It embeds the Python script so the installed CLI works outside the checkout.
Four proxy regressions and all 27 CLI tests passed; a standalone CLI smoke check
forwarded exactly one request and confirmed shutdown removed its listener.
The CLI launcher and startup/shutdown messages were added after the hardware
run; forwarding logic was unchanged.
