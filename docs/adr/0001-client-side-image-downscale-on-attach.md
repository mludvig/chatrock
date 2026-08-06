# 1. Client-side downscale of image attachments before upload

## Status

Accepted

## Context

Users reported being unable to attach photos taken on an iPhone (via Camera or the Photo gallery picker) — the app rejects them with "File too large." `frontend/src/components/ChatView.tsx` caps images at 5 MB per file (`MAX_SIZES`), enforced in `addFiles()`, the single entry point used by the file picker, drag-and-drop, and paste. Modern iPhones routinely produce JPEGs above 5 MB at full sensor resolution (more so without "Most Compatible" HEIC settings), so this cap is hit often for phone photos specifically, rarely for other sources.

There is no image resizing anywhere in the stack today: the frontend uploads the raw `File` to S3 via a presigned PUT, and the backend hydrates the object back to bytes verbatim before handing it to Bedrock's `ConverseStream` — see "Attachments are stored in S3..." in this file.

Options considered:

1. **Raise the 5 MB cap.** Simple, but doesn't address the root problem: Bedrock's vision models get no quality benefit from images above roughly 1568px on the long edge, so uploading a full 12–48 MP photo just spends bandwidth and image tokens for nothing. Also just moves the failure threshold rather than removing it — a sufficiently large/detailed photo still fails.
2. **Ask the camera/gallery for a smaller version.** Not controllable from a web `<input type="file">` — iOS exposes no such capability to the browser.
3. **Downscale and re-encode client-side before upload.** Fixes the failure at the source, for every entry point that funnels through `addFiles()` (camera, gallery, paste, drag-drop), with no backend or limit changes, and incidentally reduces upload time and Bedrock image-token cost for all users, not just the iPhone case.

## Decision

Downscale images client-side in `addFiles()` before the size check: decode via `createImageBitmap`, draw to a canvas scaled to fit within a max long-edge dimension, re-encode as JPEG via `canvas.toBlob`, and continue through the existing upload path with the resulting (smaller) `File`. Only replace the original file when doing so actually helps (skip already-small images); fall back to the current "File too large" error in the rare case a photo still exceeds the cap after downscaling.

## Consequences

- Fixes the reported failure without touching the backend, S3 presign flow, or the size limit itself.
- Slightly increases client-side CPU/memory use per image attach (canvas decode + re-encode), bounded to the moment of attaching.
- Re-encoding always targets JPEG, so attaching a PNG that relies on transparency will lose its alpha channel once it goes through this path. Not addressed here — no current use case surfaced for transparent-image attachments.
- HEIC decoding via `<img>`/canvas only works in browsers with native HEIC support (Safari/WebKit) — sufficient for the iPhone case this ADR targets, but a non-Safari browser handed a raw HEIC file would still fail as it does today.
