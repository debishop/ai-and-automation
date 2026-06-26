// THEAAAAA-500 — VEP performance polling module.
//
// Plan: /THEAAAAA/issues/THEAAAAA-496#document-plan ("Performance polling").
//
// Behavior:
//  - Find vep_runs rows whose actual_publication_time falls within ±30 min of
//    (now - 24h | 72h | 7d) AND that lack a vep_performance_snapshots row for
//    that interval.
//  - For each (run, interval), call FB Graph insights + post-level edges
//    (reactions, comments, shares) and page follower delta around the interval.
//  - INSERT into vep_performance_snapshots with ON CONFLICT (run_id, interval)
//    DO NOTHING for idempotency under retries / overlapping runs.
//
// Endpoint chain mirrors src/vep/publish-post.mjs (Doppler-injected token,
// v19.0). Every external call is timeout-bounded; failures degrade per-run so
// one bad post never stalls the cron tick.

import { Client } from "pg";
import {
  GRAPH_VERSION,
  DEFAULT_PAGE_ID,
  HTTP_TIMEOUT_MS,
  resolvePageToken,
} from "./publish-post.mjs";

export const INTERVALS = [
  { key: "24h", seconds: 24 * 3600 },
  { key: "72h", seconds: 72 * 3600 },
  { key: "7d", seconds: 7 * 24 * 3600 },
];
export const WINDOW_SEC = 30 * 60; // ±30 min match window per spec.

// `post_impressions_unique` (and `post_impressions`) return Graph #100
// "not a valid insights metric" on The Lens Page in v19.0 — reach is sourced
// implicitly via reactions/clicks instead and left null when unavailable.
export const POST_INSIGHT_METRICS = [
  "post_reactions_by_type_total",
  "post_clicks",
];
export const PAGE_FOLLOWER_METRIC = "page_follows";

export class PollError extends Error {
  constructor(message, { stage, response = null } = {}) {
    super(message);
    this.name = "PollError";
    this.stage = stage;
    this.response = response;
  }
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

// Build a candidate list: { run_id, fb_post_id, actual_publication_time, interval }.
// One row per (run, interval) currently due AND not yet snapshotted.
export async function findDueSnapshots(client, { now = new Date(), windowSec = WINDOW_SEC } = {}) {
  const nowIso = now.toISOString();
  const rows = [];
  for (const { key, seconds } of INTERVALS) {
    const res = await client.query(
      `SELECT r.run_id, r.fb_post_id, r.actual_publication_time
         FROM vep_runs r
         LEFT JOIN vep_performance_snapshots s
           ON s.run_id = r.run_id AND s.interval = $1
        WHERE r.status = 'published'
          AND r.fb_post_id IS NOT NULL
          AND r.actual_publication_time IS NOT NULL
          AND s.snapshot_id IS NULL
          AND ABS(EXTRACT(EPOCH FROM (($2::timestamptz - r.actual_publication_time) - ($3 || ' seconds')::interval))) <= $4`,
      [key, nowIso, String(seconds), windowSec],
    );
    for (const row of res.rows) {
      rows.push({
        run_id: row.run_id,
        fb_post_id: row.fb_post_id,
        actual_publication_time: row.actual_publication_time,
        interval: key,
      });
    }
  }
  return rows;
}

// FB Graph insights for a single post. Returns { metrics: { name: value }, raw }.
export async function fetchPostInsights({ fbPostId, token, fetchImpl = fetch }) {
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${fbPostId}/insights` +
    `?metric=${POST_INSIGHT_METRICS.join(",")}&access_token=${encodeURIComponent(token)}`;
  const res = await fetchWithTimeout(url, {}, HTTP_TIMEOUT_MS, fetchImpl);
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    throw new PollError(`insights HTTP ${res.status}: ${text.slice(0, 200)}`, {
      stage: "insights",
      response: payload,
    });
  }
  return payload;
}

// Top-level edges (comments/shares summary counts) on the post node itself.
export async function fetchPostSummary({ fbPostId, token, fetchImpl = fetch }) {
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${fbPostId}` +
    `?fields=shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)` +
    `&access_token=${encodeURIComponent(token)}`;
  const res = await fetchWithTimeout(url, {}, HTTP_TIMEOUT_MS, fetchImpl);
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    throw new PollError(`post summary HTTP ${res.status}: ${text.slice(0, 200)}`, {
      stage: "summary",
      response: payload,
    });
  }
  return payload;
}

// Page follower delta. FB exposes `page_follows` as a daily metric on the page;
// we sum the window from publication-time → now and treat that as new_followers
// attributed to the post's interval. Best-effort: returns null if unavailable.
export async function fetchFollowerDelta({
  pageId,
  token,
  sincePublication,
  now = new Date(),
  fetchImpl = fetch,
}) {
  const since = Math.floor(new Date(sincePublication).getTime() / 1000);
  const until = Math.floor(new Date(now).getTime() / 1000);
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/insights/${PAGE_FOLLOWER_METRIC}` +
    `?period=day&since=${since}&until=${until}&access_token=${encodeURIComponent(token)}`;
  const res = await fetchWithTimeout(url, {}, HTTP_TIMEOUT_MS, fetchImpl);
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    return { value: null, raw: payload, error: `follower HTTP ${res.status}` };
  }
  const series = payload?.data?.[0]?.values ?? [];
  let total = 0;
  let saw = false;
  for (const point of series) {
    if (typeof point.value === "number") {
      total += point.value;
      saw = true;
    }
  }
  return { value: saw ? total : null, raw: payload };
}

// Reduce an insights payload to flat numbers. Robust to FB edge changes.
export function mapInsights({ insights, summary }) {
  const byName = {};
  for (const entry of insights?.data ?? []) {
    byName[entry.name] = entry.values?.[entry.values.length - 1]?.value;
  }

  const reach = numOrNull(byName.post_impressions_unique);
  const clicks = numOrNull(byName.post_clicks);

  const reactionsByType = byName.post_reactions_by_type_total;
  let reactions = 0;
  if (reactionsByType && typeof reactionsByType === "object") {
    for (const v of Object.values(reactionsByType)) {
      if (typeof v === "number") reactions += v;
    }
  } else if (typeof summary?.reactions?.summary?.total_count === "number") {
    reactions = summary.reactions.summary.total_count;
  }

  const comments = numOrZero(summary?.comments?.summary?.total_count);
  const shares = numOrZero(summary?.shares?.count);

  return { reach, reactions, comments, shares, clicks };
}

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function numOrZero(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Persist one snapshot. ON CONFLICT (run_id, interval) DO NOTHING enforces the
// unique-guard from migration 0001; returns true if a row was inserted.
export async function insertSnapshot(client, { runId, interval, mapped, newFollowers, raw }) {
  const res = await client.query(
    `INSERT INTO vep_performance_snapshots
       (run_id, interval, reach, reactions, comments, shares, clicks, new_followers, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (run_id, interval) DO NOTHING
     RETURNING snapshot_id`,
    [
      runId,
      interval,
      mapped.reach,
      mapped.reactions,
      mapped.comments,
      mapped.shares,
      mapped.clicks,
      newFollowers,
      raw ? JSON.stringify(raw) : null,
    ],
  );
  return res.rowCount > 0;
}

// Cron entry. Returns a per-run summary array; never throws for per-row
// failures (we keep going so the tick stays bounded). Top-level auth or DB
// errors do throw so the routine surfaces them to the CTO.
export async function pollPerformance({
  pgClient,
  pageId = DEFAULT_PAGE_ID,
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
  log = console.log,
} = {}) {
  if (!pgClient) throw new PollError("pgClient required", { stage: "load" });

  const due = await findDueSnapshots(pgClient, { now });
  if (due.length === 0) {
    log(JSON.stringify({ event: "vep_poll_tick", due: 0 }));
    return { polled: 0, inserted: 0, errors: 0, results: [] };
  }

  const { token } = await resolvePageToken({ pageId, env, fetchImpl });

  const results = [];
  let inserted = 0;
  let errors = 0;

  for (const item of due) {
    try {
      const [insights, summary, follower] = await Promise.all([
        fetchPostInsights({ fbPostId: item.fb_post_id, token, fetchImpl }),
        fetchPostSummary({ fbPostId: item.fb_post_id, token, fetchImpl }),
        fetchFollowerDelta({
          pageId,
          token,
          sincePublication: item.actual_publication_time,
          now,
          fetchImpl,
        }),
      ]);
      const mapped = mapInsights({ insights, summary });
      const raw = {
        interval: item.interval,
        insights,
        summary,
        follower: follower.raw,
        taken_at: now.toISOString(),
      };
      const wrote = await insertSnapshot(pgClient, {
        runId: item.run_id,
        interval: item.interval,
        mapped,
        newFollowers: follower.value,
        raw,
      });
      if (wrote) inserted += 1;
      results.push({
        run_id: item.run_id,
        interval: item.interval,
        inserted: wrote,
        mapped,
        new_followers: follower.value,
      });
      log(
        JSON.stringify({
          event: "vep_poll_snapshot",
          run_id: item.run_id,
          interval: item.interval,
          inserted: wrote,
          ...mapped,
          new_followers: follower.value,
        }),
      );
    } catch (err) {
      errors += 1;
      results.push({
        run_id: item.run_id,
        interval: item.interval,
        error: err.message,
        stage: err.stage ?? "unknown",
      });
      log(
        JSON.stringify({
          event: "vep_poll_error",
          run_id: item.run_id,
          interval: item.interval,
          error: err.message,
          stage: err.stage ?? "unknown",
        }),
      );
    }
  }

  return { polled: due.length, inserted, errors, results };
}

export function connectPg({ connectionString = process.env.DATABASE_URL, clientFactory } = {}) {
  if (!connectionString) {
    throw new PollError("DATABASE_URL not set", { stage: "load" });
  }
  const make = clientFactory || ((c) => new Client(c));
  return make({ connectionString });
}

// CLI: `node src/vep/poll-performance.mjs` — used by the cron routine.
// Optional `--run-id <uuid>` forces a backfill against a single run for all
// three intervals regardless of the time window (proof-of-life path called
// out in the issue's Definition of Done).
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const runIdx = args.indexOf("--run-id");
  const forcedRunId = runIdx >= 0 ? args[runIdx + 1] : null;
  const client = connectPg();
  await client.connect();
  try {
    if (forcedRunId) {
      const r = await client.query(
        `SELECT run_id, fb_post_id, actual_publication_time
           FROM vep_runs WHERE run_id = $1`,
        [forcedRunId],
      );
      if (r.rowCount === 0) throw new Error(`run ${forcedRunId} not found`);
      const row = r.rows[0];
      if (!row.fb_post_id) throw new Error(`run ${forcedRunId} has no fb_post_id`);
      const { token } = await resolvePageToken({});
      for (const { key } of INTERVALS) {
        try {
          const [insights, summary, follower] = await Promise.all([
            fetchPostInsights({ fbPostId: row.fb_post_id, token }),
            fetchPostSummary({ fbPostId: row.fb_post_id, token }),
            fetchFollowerDelta({
              pageId: DEFAULT_PAGE_ID,
              token,
              sincePublication: row.actual_publication_time ?? new Date(),
            }),
          ]);
          const mapped = mapInsights({ insights, summary });
          const wrote = await insertSnapshot(client, {
            runId: row.run_id,
            interval: key,
            mapped,
            newFollowers: follower.value,
            raw: { backfill: true, interval: key, insights, summary, follower: follower.raw },
          });
          console.log(JSON.stringify({ event: "vep_poll_backfill", interval: key, inserted: wrote, ...mapped }));
        } catch (err) {
          console.error(JSON.stringify({ event: "vep_poll_backfill_error", interval: key, error: err.message }));
        }
      }
    } else {
      const out = await pollPerformance({ pgClient: client });
      console.log(JSON.stringify({ event: "vep_poll_done", ...out, results: undefined, count: out.results.length }));
    }
  } finally {
    await client.end();
  }
}
