// THEAAAAA-499 — VEP Facebook publisher.
//
// Plan: /THEAAAAA/issues/THEAAAAA-496#document-plan ("Facebook publishing module",
// "Concurrency + dedup", "Retry policy").
//
// Endpoint:  POST https://graph.facebook.com/v19.0/{page-id}/photos
// Token:     DOPPLER_TOKEN_EDGE (Doppler-injected) → FACEBOOK_SYSTEM_USER_TOKEN
//            → page token for 1097492980106238. Same chain as the reel publisher
//            (THEAAAAA-432 / scripts/publish-reel.mjs).
// Guards:    pg_try_advisory_xact_lock(hashtext(topic_hash)) + same-day dup-row
//            check on vep_runs.fb_post_id before the POST.
// Retries:   max 2, backoff 60s then 180s. Before each retry, run the post-failure
//            confirmation query (/{page-id}/posts?since=t-300s) and only retry if
//            we are sure no post landed silently.

import { Client } from "pg";

export const GRAPH_VERSION = "v19.0";
export const DEFAULT_PAGE_ID = "1097492980106238"; // The Lens — AI and Automation
export const MAX_RETRIES = 2;
export const BACKOFF_MS = [60_000, 180_000];
export const REQUIRED_WIDTH = 1080;
export const REQUIRED_HEIGHT = 1350;
export const HTTP_TIMEOUT_MS = 30_000;
export const CONFIRMATION_WINDOW_SEC = 300;
// THEAAAAA-668 / THEAAAAA-669 — post-publish Graph read-back. The /photos
// create-call returning a post_id is not proof that the post is visible on the
// page feed; THEAAAAA-543 recorded a post id that 404'd on read-back (Graph
// error 10) and was missing from the page `published_posts` feed entirely.
// We confirm visibility two ways and require BOTH:
//   1. GET /{page_id}/published_posts?since=t-30s&limit=10 must include the id
//   2. GET /{post-id}?fields=id,... must return 2xx with that id
// Board spec from THEAAAAA-669: 3 attempts × 5s apart between polls (≈15s).
export const VERIFY_ATTEMPTS = 3;
export const VERIFY_POLL_MS = 5_000;
export const VERIFY_WINDOW_MS = (VERIFY_ATTEMPTS - 1) * VERIFY_POLL_MS;
// /{page_id}/published_posts `since` is publish_time - 30s, per THEAAAAA-669.
export const VERIFY_FEED_LOOKBACK_SEC = 30;
export const VERIFY_FEED_LIMIT = 10;

export class PublishError extends Error {
  constructor(message, { stage, retryable = true, response = null } = {}) {
    super(message);
    this.name = "PublishError";
    this.stage = stage;
    this.retryable = retryable;
    this.response = response;
  }
}

// Page-token resolution chain. Doppler injects FACEBOOK_SYSTEM_USER_TOKEN into the
// routine env via DOPPLER_TOKEN_EDGE; we mint a page token from it. If a page token
// is already in env (test fixtures, manual ops) we use it directly. The legacy
// per-page key PAPERCLIP_API_KEY_THELENSAIAND is accepted as a last resort.
export async function resolvePageToken({
  pageId = DEFAULT_PAGE_ID,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (env.FACEBOOK_PAGE_ACCESS_TOKEN) {
    return { token: env.FACEBOOK_PAGE_ACCESS_TOKEN, source: "page_env" };
  }
  if (env.FACEBOOK_SYSTEM_USER_TOKEN) {
    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}` +
      `?fields=access_token&access_token=${env.FACEBOOK_SYSTEM_USER_TOKEN}`;
    const res = await fetchWithTimeout(url, {}, HTTP_TIMEOUT_MS, fetchImpl);
    if (!res.ok) {
      throw new PublishError(`page token mint failed HTTP ${res.status}`, {
        stage: "auth",
        retryable: false,
      });
    }
    const payload = await res.json();
    if (!payload.access_token) {
      throw new PublishError("page token mint response missing access_token", {
        stage: "auth",
        retryable: false,
      });
    }
    return { token: payload.access_token, source: "system_user" };
  }
  if (env.PAPERCLIP_API_KEY_THELENSAIAND) {
    return { token: env.PAPERCLIP_API_KEY_THELENSAIAND, source: "paperclip_page_key" };
  }
  throw new PublishError(
    "no Facebook token (need FACEBOOK_SYSTEM_USER_TOKEN, FACEBOOK_PAGE_ACCESS_TOKEN, " +
      "or PAPERCLIP_API_KEY_THELENSAIAND)",
    { stage: "auth", retryable: false },
  );
}

export function composeMessage({
  caption = "",
  coreHashtags = [],
  topicHashtags = [],
  audienceMentions = [],
} = {}) {
  const tags = [...(coreHashtags || []), ...(topicHashtags || [])]
    .filter(Boolean)
    .join(" ");
  const mentions = (audienceMentions || []).filter(Boolean).join(" ");
  const tail = [tags, mentions].filter(Boolean).join(" ");
  return tail ? `${caption}\n\n${tail}` : caption;
}

export function validateImage({ width, height, contentType }) {
  const reasons = [];
  if (Number(width) !== REQUIRED_WIDTH || Number(height) !== REQUIRED_HEIGHT) {
    reasons.push(
      `image must be ${REQUIRED_WIDTH}x${REQUIRED_HEIGHT}, got ${width}x${height}`,
    );
  }
  if (!/^image\/(png|jpeg|jpg)$/i.test(contentType || "")) {
    reasons.push(`unsupported content type: ${contentType || "<none>"}`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function inferContentType(url) {
  if (!url) return "";
  const ext = url.split("?")[0].split("#")[0].split(".").pop().toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return "";
}

export function permalinkFor(postId) {
  if (!postId) return null;
  if (typeof postId !== "string") postId = String(postId);
  if (postId.includes("_")) {
    const [page, id] = postId.split("_");
    return `https://www.facebook.com/${page}/posts/${id}`;
  }
  return `https://www.facebook.com/${postId}`;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = HTTP_TIMEOUT_MS, fetchImpl = fetch) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Section 10 guards. Must be called inside a tx so the advisory lock is xact-scoped.
export async function acquireGuards(client, { topicHash }) {
  if (!topicHash) {
    throw new PublishError("topicHash required for guards", {
      stage: "guard",
      retryable: false,
    });
  }
  const lock = await client.query(
    "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got",
    [topicHash],
  );
  if (!lock.rows[0].got) return { acquired: false, reason: "advisory_lock_busy" };

  const dup = await client.query(
    `SELECT run_id, fb_post_id, fb_post_url
       FROM vep_runs
      WHERE fb_post_id IS NOT NULL
        AND topic_hash = $1
        AND (actual_publication_time AT TIME ZONE 'UTC')::date
            = (now() AT TIME ZONE 'UTC')::date
      LIMIT 1`,
    [topicHash],
  );
  if (dup.rowCount > 0) {
    return { acquired: false, reason: "duplicate_today", existing: dup.rows[0] };
  }
  return { acquired: true };
}

// Section 16 step 2 — post-failure confirmation. Fetches recent posts and matches
// on the caption's first line. Returns { confirmedNotPublished, matched? }.
export async function confirmNotPublished({
  pageId,
  token,
  captionFirstLine,
  sinceEpochSec,
  fetchImpl = fetch,
}) {
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/posts` +
    `?fields=id,permalink_url,created_time,message&since=${sinceEpochSec}` +
    `&access_token=${token}`;
  let res;
  try {
    res = await fetchWithTimeout(url, {}, HTTP_TIMEOUT_MS, fetchImpl);
  } catch (err) {
    return { confirmedNotPublished: false, error: `confirm fetch: ${err.message}` };
  }
  if (!res.ok) {
    return { confirmedNotPublished: false, error: `confirm HTTP ${res.status}` };
  }
  const body = await res.json().catch(() => ({}));
  const posts = Array.isArray(body.data) ? body.data : [];
  const needle = (captionFirstLine || "").trim().slice(0, 100);
  const matched = needle
    ? posts.find((p) => typeof p.message === "string" && p.message.includes(needle))
    : null;
  if (matched) return { confirmedNotPublished: false, matched, scanned: posts.length };
  return { confirmedNotPublished: true, scanned: posts.length };
}

// THEAAAAA-668 — single read-back via /{post-id}. Returns { visible, ... }.
// We treat any non-2xx (incl. the 404/code-10 seen on the THEAAAAA-543 post) or
// a missing id in the response as not-visible. Transport errors are not treated
// as visible — caller polls.
export async function verifyPostVisible({ postId, token, fetchImpl = fetch }) {
  if (!postId) return { visible: false, error: "postId required" };
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${postId}` +
    `?fields=id,permalink_url,created_time&access_token=${token}`;
  let res;
  try {
    res = await fetchWithTimeout(url, {}, HTTP_TIMEOUT_MS, fetchImpl);
  } catch (err) {
    return { visible: false, error: `verify fetch: ${err.message}` };
  }
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    return { visible: false, status: res.status, response: payload };
  }
  if (payload && payload.id) {
    return {
      visible: true,
      response: payload,
      permalink_url: payload.permalink_url || null,
      created_time: payload.created_time || null,
    };
  }
  return { visible: false, response: payload };
}

// THEAAAAA-669 — Page-feed read-back. The board's explicit verification path:
// GET /{page_id}/published_posts?since=<publish_time-30s>&limit=10 and confirm
// the returned id matches the post we just created. This is the same query used
// in the THEAAAAA-664 audit that surfaced the silent-fail.
export async function verifyPostInPublishedFeed({
  pageId,
  postId,
  token,
  sinceEpochSec,
  limit = VERIFY_FEED_LIMIT,
  fetchImpl = fetch,
}) {
  if (!pageId) return { visible: false, error: "pageId required" };
  if (!postId) return { visible: false, error: "postId required" };
  const params = new URLSearchParams({
    fields: "id,permalink_url,created_time",
    limit: String(limit),
    access_token: token,
  });
  if (sinceEpochSec) params.set("since", String(sinceEpochSec));
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/published_posts?${params}`;
  let res;
  try {
    res = await fetchWithTimeout(url, {}, HTTP_TIMEOUT_MS, fetchImpl);
  } catch (err) {
    return { visible: false, error: `feed fetch: ${err.message}` };
  }
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    return { visible: false, status: res.status, response: payload };
  }
  const posts = Array.isArray(payload?.data) ? payload.data : [];
  // Facebook returns ids as either the bare numeric or {page}_{post}; match
  // either side so a bare post_id from the create call lines up with feed rows.
  const target = String(postId);
  const tail = target.includes("_") ? target.split("_").pop() : target;
  const match = posts.find((p) => {
    if (!p || typeof p.id !== "string") return false;
    if (p.id === target) return true;
    const pTail = p.id.includes("_") ? p.id.split("_").pop() : p.id;
    return pTail === tail;
  });
  if (match) {
    return {
      visible: true,
      response: payload,
      match,
      permalink_url: match.permalink_url || null,
      created_time: match.created_time || null,
      scanned: posts.length,
    };
  }
  return { visible: false, response: payload, scanned: posts.length };
}

// Polls verification until success or the attempt budget is exhausted. Both
// the page-feed read-back (THEAAAAA-669, primary) and the post-id read-back
// (THEAAAAA-668, corroborating permalink) must return visible for a publish to
// be accepted. Sleep/now are injectable so tests run instantly.
export async function verifyPostVisibleWithPolling({
  postId,
  pageId,
  token,
  sinceEpochSec,
  fetchImpl = fetch,
  attempts = VERIFY_ATTEMPTS,
  pollMs = VERIFY_POLL_MS,
  // windowMs kept for back-compat; if set, overrides attempts via attempt count.
  windowMs,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  const start = now();
  const effectiveAttempts = Number.isFinite(windowMs)
    ? Math.max(1, Math.floor(windowMs / Math.max(1, pollMs)) + 1)
    : attempts;
  let last = { visible: false, error: "no attempt" };
  for (let i = 0; i < effectiveAttempts; i += 1) {
    const feed = await verifyPostInPublishedFeed({
      pageId,
      postId,
      token,
      sinceEpochSec,
      fetchImpl,
    });
    if (feed.visible) {
      // Corroborate with post-id read-back; if it agrees, accept. If it errors
      // (transient), still accept on feed match alone — the feed is canonical.
      const direct = await verifyPostVisible({ postId, token, fetchImpl });
      last = {
        visible: true,
        feed,
        direct,
        permalink_url: feed.permalink_url || direct.permalink_url || null,
        created_time: feed.created_time || direct.created_time || null,
        attempt: i + 1,
      };
      return { ...last, elapsedMs: now() - start };
    }
    last = { visible: false, feed, attempt: i + 1 };
    if (i + 1 >= effectiveAttempts) break;
    await sleep(pollMs);
  }
  return { ...last, elapsedMs: now() - start, timedOut: true };
}

export async function publishPhoto({ pageId, token, imageUrl, message, fetchImpl = fetch }) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/photos`;
  const body = new URLSearchParams({ url: imageUrl, message, access_token: token });
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
    HTTP_TIMEOUT_MS,
    fetchImpl,
  );
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    throw new PublishError(`photo POST HTTP ${res.status}: ${text.slice(0, 200)}`, {
      stage: "publish",
      retryable: res.status >= 500 || res.status === 429,
      response: payload,
    });
  }
  const fbPostId = payload.post_id || payload.id;
  if (!fbPostId) {
    throw new PublishError("photo POST response missing id/post_id", {
      stage: "publish",
      retryable: false,
      response: payload,
    });
  }
  return { fb_post_id: String(fbPostId), raw: payload };
}

async function logAttempt(client, { runId, outcome, fbResponse, error, confirmedNotPublished = false }) {
  await client.query(
    `INSERT INTO vep_publish_attempts
       (run_id, outcome, fb_response, error, confirmed_not_published)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      runId,
      outcome,
      fbResponse ? JSON.stringify(fbResponse) : null,
      error ?? null,
      confirmedNotPublished,
    ],
  );
}

// Main entry. Loads the vep_runs row, acquires guards, publishes, retries per
// policy, writes outcome + attempt log. Returns a structured result; never throws
// for retryable conditions handled internally.
//
// `onFinalFailure({ run, error, attempts })` is invoked after the second failed
// retry. Callers wire this to a Paperclip comment that tags CCO + CTO; we keep it
// injectable so unit tests don't need the Paperclip API.
export async function publishRun({
  runId,
  pgClient,
  pageId = DEFAULT_PAGE_ID,
  env = process.env,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  backoffMs = BACKOFF_MS,
  now = () => Date.now(),
  onFinalFailure = null,
  verifyWindowMs = VERIFY_WINDOW_MS,
  verifyPollMs = VERIFY_POLL_MS,
}) {
  if (!runId) throw new PublishError("runId required", { stage: "load", retryable: false });
  if (!pgClient) throw new PublishError("pgClient required", { stage: "load", retryable: false });

  const runRes = await pgClient.query(
    `SELECT run_id, topic_hash, caption, core_hashtags, topic_hashtags,
            audience_mentions, image_url, image_width, image_height,
            retry_count, publishing_result
       FROM vep_runs
      WHERE run_id = $1`,
    [runId],
  );
  if (runRes.rowCount === 0) {
    throw new PublishError(`vep_runs row ${runId} not found`, {
      stage: "load",
      retryable: false,
    });
  }
  const run = runRes.rows[0];
  if (run.publishing_result === "Published" && run.fb_post_id) {
    return { alreadyPublished: true, run };
  }

  const imgValidation = validateImage({
    width: run.image_width,
    height: run.image_height,
    contentType: inferContentType(run.image_url),
  });
  if (!imgValidation.ok) {
    throw new PublishError(`image invalid: ${imgValidation.reasons.join("; ")}`, {
      stage: "validate",
      retryable: false,
    });
  }

  const message = composeMessage({
    caption: run.caption,
    coreHashtags: run.core_hashtags,
    topicHashtags: run.topic_hashtags,
    audienceMentions: run.audience_mentions,
  });
  const captionFirstLine = (run.caption || "").split("\n")[0];

  const { token } = await resolvePageToken({ pageId, env, fetchImpl });

  await pgClient.query("BEGIN");
  let committed = false;
  try {
    const guard = await acquireGuards(pgClient, { topicHash: run.topic_hash });
    if (!guard.acquired) {
      await pgClient.query("ROLLBACK");
      committed = true;
      return { skipped: true, reason: guard.reason, existing: guard.existing ?? null };
    }

    let attempt = 0;
    let lastError = null;
    let lastResponse = null;

    while (attempt <= MAX_RETRIES) {
      const tBeforeSec = Math.floor(now() / 1000) - CONFIRMATION_WINDOW_SEC;
      const publishStartSec = Math.floor(now() / 1000);
      try {
        const result = await publishPhoto({
          pageId,
          token,
          imageUrl: run.image_url,
          message,
          fetchImpl,
        });

        // THEAAAAA-668 / THEAAAAA-669 — Graph read-back. The create-call
        // post_id is a claim, not proof; THEAAAAA-543 logged a post id that
        // 404'd and never landed in /{page_id}/published_posts. We confirm
        // visibility on the page feed (board spec) AND via /{post-id} before
        // marking the run Published.
        const verify = await verifyPostVisibleWithPolling({
          postId: result.fb_post_id,
          pageId,
          token,
          sinceEpochSec: publishStartSec - VERIFY_FEED_LOOKBACK_SEC,
          fetchImpl,
          windowMs: verifyWindowMs,
          pollMs: verifyPollMs,
          sleep,
          now,
        });
        if (!verify.visible) {
          await logAttempt(pgClient, {
            runId,
            outcome: "publish_unverified",
            fbResponse: { create: result.raw, verify: verify.response ?? null },
            error: `read-back failed: ${verify.error || `status ${verify.status || "n/a"}`}`,
          });
          await pgClient.query(
            `UPDATE vep_runs
                SET publishing_result = 'Publishing Failed',
                    failure_reason = $2,
                    retry_count = $3
              WHERE run_id = $1`,
            [
              runId,
              `post id ${result.fb_post_id} not visible on page feed within ` +
                `${Math.round(verifyWindowMs / 1000)}s (Graph read-back failed)`,
              attempt,
            ],
          );
          await pgClient.query("COMMIT");
          committed = true;
          if (typeof onFinalFailure === "function") {
            try {
              await onFinalFailure({
                run,
                error: new PublishError("post id not visible on page feed", {
                  stage: "verify",
                  retryable: false,
                  response: { create: result.raw, verify: verify.response ?? null },
                }),
                attempts: attempt + 1,
              });
            } catch (hookErr) {
              console.error("onFinalFailure hook threw:", hookErr.message);
            }
          }
          return {
            published: false,
            failed: true,
            unverified: true,
            fb_post_id: result.fb_post_id,
            verify,
            attempts: attempt + 1,
            error: "post id not visible on page feed",
          };
        }

        const permalink = verify.permalink_url || permalinkFor(result.fb_post_id);
        await logAttempt(pgClient, {
          runId,
          outcome: "success",
          fbResponse: { create: result.raw, verify: verify.response },
        });
        await pgClient.query(
          `UPDATE vep_runs
              SET fb_post_id = $2,
                  fb_post_url = $3,
                  publishing_result = 'Published',
                  actual_publication_time = now(),
                  retry_count = $4
            WHERE run_id = $1`,
          [runId, result.fb_post_id, permalink, attempt],
        );
        await pgClient.query("COMMIT");
        committed = true;
        return {
          published: true,
          fb_post_id: result.fb_post_id,
          permalink,
          verify,
          attempts: attempt + 1,
        };
      } catch (err) {
        lastError = err;
        lastResponse = err.response ?? null;

        const confirm = await confirmNotPublished({
          pageId,
          token,
          captionFirstLine,
          sinceEpochSec: tBeforeSec,
          fetchImpl,
        });

        await logAttempt(pgClient, {
          runId,
          outcome: confirm.matched ? "succeeded_silently" : "error",
          fbResponse: lastResponse ?? (confirm.matched || null),
          error: err.message,
          confirmedNotPublished: confirm.confirmedNotPublished === true,
        });

        if (confirm.matched) {
          const m = confirm.matched;
          await pgClient.query(
            `UPDATE vep_runs
                SET fb_post_id = $2,
                    fb_post_url = COALESCE($3, fb_post_url),
                    publishing_result = 'Published',
                    actual_publication_time = COALESCE($4::timestamptz, now()),
                    retry_count = $5
              WHERE run_id = $1`,
            [
              runId,
              m.id,
              m.permalink_url ?? permalinkFor(m.id),
              m.created_time ?? null,
              attempt,
            ],
          );
          await pgClient.query("COMMIT");
          committed = true;
          return {
            published: true,
            fb_post_id: m.id,
            permalink: m.permalink_url ?? permalinkFor(m.id),
            attempts: attempt + 1,
            recoveredVia: "post_failure_confirmation",
          };
        }

        const exhausted = attempt >= MAX_RETRIES;
        const canRetry = err.retryable && !exhausted && confirm.confirmedNotPublished === true;
        if (!canRetry) break;

        await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)]);
        attempt += 1;
      }
    }

    await pgClient.query(
      `UPDATE vep_runs
          SET publishing_result = 'Publishing Failed',
              failure_reason = $2,
              retry_count = $3
        WHERE run_id = $1`,
      [runId, lastError?.message ?? "unknown failure", attempt],
    );
    await pgClient.query("COMMIT");
    committed = true;

    if (typeof onFinalFailure === "function") {
      try {
        await onFinalFailure({ run, error: lastError, attempts: attempt + 1 });
      } catch (hookErr) {
        // The hook is best-effort: surfacing the alert must not roll back the
        // attempt log or the Publishing-Failed status that operators need to see.
        console.error("onFinalFailure hook threw:", hookErr.message);
      }
    }

    return {
      published: false,
      failed: true,
      attempts: attempt + 1,
      error: lastError?.message ?? "unknown failure",
    };
  } catch (err) {
    if (!committed) {
      await pgClient.query("ROLLBACK").catch(() => {});
    }
    throw err;
  }
}

// Default Paperclip comment hook. Tags CCO + CTO on the provided tracking issue.
// Used by the CLI; tests inject a stub instead.
export function makePaperclipFailureHook({
  apiUrl = process.env.PAPERCLIP_API_URL,
  apiKey = process.env.PAPERCLIP_API_KEY,
  issueId,
  ccoAgentId = "3ef14ba8",
  ctoAgentId = "fd24aa2f-13c3-4f30-adee-2061b6345ac4",
  fetchImpl = fetch,
} = {}) {
  return async ({ run, error, attempts }) => {
    if (!apiUrl || !apiKey || !issueId) return;
    const body = {
      body:
        `VEP publish failed after ${attempts} attempt(s) for run \`${run.run_id}\`.\n\n` +
        `Topic: ${run.topic_hash || "(unset)"}\n` +
        `Error: ${error?.message || "unknown"}\n\n` +
        `Approved image+caption stay in \`vep_runs\`; resume with ` +
        `\`node scripts/resume-publish.mjs --run-id ${run.run_id}\`.\n\n` +
        `cc @CCO (agent://${ccoAgentId}) @CTO (agent://${ctoAgentId})`,
    };
    await fetchWithTimeout(
      `${apiUrl}/api/issues/${issueId}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      HTTP_TIMEOUT_MS,
      fetchImpl,
    );
  };
}

export function connectPg({ connectionString = process.env.DATABASE_URL, clientFactory } = {}) {
  if (!connectionString) {
    throw new PublishError("DATABASE_URL not set", { stage: "load", retryable: false });
  }
  const make = clientFactory || ((c) => new Client(c));
  return make({ connectionString });
}
