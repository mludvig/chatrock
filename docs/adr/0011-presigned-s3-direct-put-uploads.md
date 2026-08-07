# 11. Presigned S3 direct-PUT for attachment uploads

## Status

Accepted

## Context

Chat/project file attachments (images up to 5MB, PDFs up to 25MB, text files) need to get from the browser to S3, and the backend needs to authorize and know about the resulting object.

Alternatives considered:

1. **Proxy the upload through a Lambda** — browser → API Gateway HTTP API → Lambda → S3 `PutObject`. Simplest mental model (backend fully controls one request end-to-end), but subject to API Gateway HTTP API's request payload limit (10MB) and Lambda's own payload/memory constraints — both below what a 25MB PDF or a full-resolution photo needs. Also bills Lambda duration for the entire upload transfer time, not just the authorization decision.
2. **Presigned S3 PUT.** `POST /api/attachments` (backed by `lib/attachments.ts`'s `presignPut`) validates `contentType`/`sizeBytes` against `validateAttachment()` and returns a short-lived (15-minute) presigned PUT URL; the browser (`frontend/src/api/http.ts`'s `uploadToS3`) then PUTs the file bytes directly to S3 — API Gateway and Lambda are involved only in issuing the URL, never in the transfer itself.

## Decision

Option 2. The backend's job is authorization and validation — is this `contentType`/`sizeBytes` acceptable, is this key scoped to the caller's own `sub` — not moving bytes.

## Consequences

- Upload size is bounded only by `validateAttachment`'s own `MAX_SIZES`-style limits, not by any API Gateway/Lambda payload ceiling. This is *why* raising those application-level limits, if ever needed, would be cheap and backend-risk-free — a fact that informed [ADR 0001](0001-client-side-image-downscale-on-attach.md)'s choice of client-side downscaling over simply raising the cap (raising it was always available as a fallback, just not the best fix for that problem).
- The presigned URL's AWS SigV4 query-string credentials are the sole auth for the PUT — `uploadToS3` deliberately sends no `Authorization` header, since one isn't valid there and would be ignored by S3.
- The 15-minute presign expiry means a stalled/slow upload fails with an expired-URL error rather than hanging indefinitely — acceptable since `requestUpload` and `uploadToS3` happen back-to-back in one client-side flow, with no legitimate reason for a long gap between them.
- The backend never inspects the actual bytes at upload time — `contentType`/`sizeBytes` sent to `POST /api/attachments` are trusted as reported by the browser, not verified against the real uploaded object. A client could presign for one declared size/type and then PUT something else. Not currently treated as a threat given the single-tenant-per-`sub`, non-adversarial-upload use case, but worth revisiting if that assumption changes.
