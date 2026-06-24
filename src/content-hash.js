// THEAAAAA-586: pre-publish idempotency guard for the FB publisher.
//
// computeContentHash(caption, mediaBytes, pageId) → sha256 over
//   sha256(normalize(caption)) || sha256(mediaBytes) || page_id
// matches what the issue spec calls for. normalize() = trim + lower + collapse all
// whitespace runs to single space so trivial caption reflows do not slip past the
// guard, while genuine editorial rewrites (different words/order) still hash distinctly.
//
// checkRecentHash / recordContentHash hit `public.facebook_publish_guards` (migration
// 0002). The publisher fail-closes when checkRecentHash returns a hit within the window.

import { createHash } from "node:crypto";

export const GUARD_WINDOW_MINUTES = 15;

export function normalizeCaption(caption) {
  if (typeof caption !== "string") return "";
  return caption.trim().toLowerCase().replace(/\s+/g, " ");
}

export function computeContentHash({ caption, mediaBytes, pageId }) {
  if (typeof pageId !== "string" || pageId === "") {
    throw new Error("computeContentHash: pageId required");
  }
  if (!(mediaBytes instanceof Uint8Array) && !Buffer.isBuffer(mediaBytes)) {
    throw new Error("computeContentHash: mediaBytes must be Buffer/Uint8Array");
  }
  const captionHash = createHash("sha256").update(normalizeCaption(caption), "utf8").digest("hex");
  const mediaHash = createHash("sha256").update(mediaBytes).digest("hex");
  return createHash("sha256")
    .update(`${captionHash}|${mediaHash}|${pageId}`, "utf8")
    .digest("hex");
}

// Returns the most recent matching guard row within the window, or null. is_dry_run is
// part of the lookup key so dry-run smokes do not block live publishes (and vice versa).
export async function checkRecentHash(client, { contentHash, pageId, isDryRun = false, windowMinutes = GUARD_WINDOW_MINUTES }) {
  const r = await client.query(
    `SELECT guard_id, content_hash, page_id, published_at, post_id, is_dry_run
       FROM public.facebook_publish_guards
      WHERE content_hash = $1
        AND page_id = $2
        AND is_dry_run = $3
        AND published_at > now() - ($4::int * interval '1 minute')
      ORDER BY published_at DESC
      LIMIT 1`,
    [contentHash, pageId, isDryRun, windowMinutes],
  );
  return r.rows[0] || null;
}

export async function recordContentHash(client, { contentHash, pageId, postId = null, isDryRun = false, note = null }) {
  const r = await client.query(
    `INSERT INTO public.facebook_publish_guards (content_hash, page_id, post_id, is_dry_run, note)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING guard_id, published_at`,
    [contentHash, pageId, postId, isDryRun, note],
  );
  return r.rows[0];
}
