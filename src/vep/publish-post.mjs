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
      try {
        const result = await publishPhoto({
          pageId,
          token,
          imageUrl: run.image_url,
          message,
          fetchImpl,
        });
        await logAttempt(pgClient, {
          runId,
          outcome: "success",
          fbResponse: result.raw,
        });
        await pgClient.query(
          `UPDATE vep_runs
              SET fb_post_id = $2,
                  fb_post_url = $3,
                  publishing_result = 'Published',
                  actual_publication_time = now(),
                  retry_count = $4
            WHERE run_id = $1`,
          [runId, result.fb_post_id, permalinkFor(result.fb_post_id), attempt],
        );
        await pgClient.query("COMMIT");
        committed = true;
        return {
          published: true,
          fb_post_id: result.fb_post_id,
          permalink: permalinkFor(result.fb_post_id),
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
