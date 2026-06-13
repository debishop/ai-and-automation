// Step 10/10 of THEAAAAA-58: append the full publication record for this run to
// the production Postgres store (the same table that feeds future dedup).
//
// The Step 9 publish was done out-of-band via the Graph API (not via the routine
// runner), so no publications row exists for this run yet. This script writes it
// idempotently: re-running it will not duplicate or corrupt the row.
//
// Secrets are pulled from Doppler at runtime via the injected DOPPLER_TOKEN_EDGE
// service token. No secret value is ever printed. Every DB call has a timeout
// (inherited from PostgresPublicationStore: 10s connect/statement/query).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";
import { normalizeUrl } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const record = JSON.parse(await readFile(join(here, "..", ".run-58-record.json"), "utf8"));

// --- Resolve production secrets from Doppler (same path as scripts/run-daily.mjs) ---
const dopplerToken = process.env.DOPPLER_TOKEN_EDGE;
if (!dopplerToken) throw new Error("DOPPLER_TOKEN_EDGE not present in environment");
const auth = "Basic " + Buffer.from(`${dopplerToken}:`).toString("base64");
const dopplerRes = await fetch(
  "https://api.doppler.com/v3/configs/config/secrets?project=ai-and-automation&config=prd",
  { headers: { Authorization: auth }, signal: AbortSignal.timeout(15_000) },
);
if (!dopplerRes.ok) throw new Error(`Doppler fetch failed: HTTP ${dopplerRes.status}`);
const dopplerBody = await dopplerRes.json();
const secret = (name) => {
  const entry = dopplerBody.secrets?.[name];
  if (!entry || entry.computed == null) throw new Error(`Missing Doppler secret: ${name}`);
  return entry.computed;
};
const databaseUrl = secret("DATABASE_URL");
const publicationsTableRaw = secret("FACEBOOK_PUBLICATIONS_TABLE");
const runsTableRaw = secret("FACEBOOK_RUNS_TABLE");

const VALID_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
function quoteTableName(name) {
  if (!VALID_TABLE_NAME.test(name)) throw new Error(`Invalid table name: ${name}`);
  return name.split(".").map((p) => `"${p}"`).join(".");
}
const PUB = quoteTableName(publicationsTableRaw);
const RUNS = quoteTableName(runsTableRaw);

const normalizedUrl = normalizeUrl(record.article_url);
const runId = record.provenance.routine_origin_run_id;
const fbPostId = record.facebook_post_id;

// Full record payload — the 9 task fields plus provenance/dedup keys.
const payload = {
  title: record.title,
  source: record.source,
  article_url: record.article_url,
  normalized_url: normalizedUrl,
  summary: record.summary,
  viral_score: record.viral_score,
  post_content: record.post_content,
  media_source: record.media_source,
  post_status: record.post_status,
  facebook_post_id: fbPostId,
  facebook_post_link: record.facebook_post_link,
  hashtags_used: record.hashtags_used,
  provenance: record.provenance,
  logged_by_step: "THEAAAAA-69",
};

const client = new Client({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 10_000,
  query_timeout: 10_000,
});

const out = {};
try {
  await client.connect();

  // Ensure schema exists (idempotent — matches src/index.js definitions).
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${PUB} (
      normalized_url TEXT PRIMARY KEY,
      article_url TEXT NOT NULL,
      headline TEXT NOT NULL,
      score INTEGER NOT NULL,
      used_fallback BOOLEAN NOT NULL,
      claim_run_id TEXT NOT NULL,
      claim_status TEXT NOT NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ,
      facebook_post_id TEXT UNIQUE,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${RUNS} (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      selected_normalized_url TEXT,
      facebook_post_id TEXT,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Pre-state: total rows + whether this story/post is already on record.
  out.pre_count = Number((await client.query(`SELECT COUNT(*)::int AS c FROM ${PUB}`)).rows[0].c);
  out.pre_existing = (
    await client.query(
      `SELECT normalized_url, facebook_post_id, claim_status FROM ${PUB} WHERE normalized_url = $1 OR facebook_post_id = $2`,
      [normalizedUrl, fbPostId],
    )
  ).rows;

  // Idempotent upsert of the publications row (the dedup-feeding full record).
  await client.query(
    `
      INSERT INTO ${PUB} (
        normalized_url, article_url, headline, score, used_fallback,
        claim_run_id, claim_status, claimed_at, published_at, facebook_post_id, payload
      )
      VALUES ($1, $2, $3, $4, false, $5, 'published', NOW(), NOW(), $6, $7::jsonb)
      ON CONFLICT (normalized_url) DO UPDATE SET
        article_url = EXCLUDED.article_url,
        headline = EXCLUDED.headline,
        score = EXCLUDED.score,
        claim_status = 'published',
        published_at = COALESCE(${PUB}.published_at, EXCLUDED.published_at),
        facebook_post_id = EXCLUDED.facebook_post_id,
        payload = EXCLUDED.payload
    `,
    [normalizedUrl, record.article_url, record.title, record.viral_score_int, runId, fbPostId, JSON.stringify(payload)],
  );

  // Idempotent audit row in the runs table.
  await client.query(
    `
      INSERT INTO ${RUNS} (run_id, status, selected_normalized_url, facebook_post_id, payload)
      VALUES ($1, 'published', $2, $3, $4::jsonb)
      ON CONFLICT (run_id) DO UPDATE SET
        status = EXCLUDED.status,
        selected_normalized_url = EXCLUDED.selected_normalized_url,
        facebook_post_id = EXCLUDED.facebook_post_id,
        payload = EXCLUDED.payload
    `,
    [
      runId,
      normalizedUrl,
      fbPostId,
      JSON.stringify({ run_id: runId, status: "published", selected_story: { headline: record.title, normalized_url: normalizedUrl, score: record.viral_score_int, facebook_post_id: fbPostId }, publication_record: payload }),
    ],
  );

  // Confirm the written row by reading it back.
  const confirm = await client.query(
    `SELECT normalized_url, headline, score, claim_status, facebook_post_id, published_at,
            payload->>'source' AS source, payload->>'post_status' AS post_status,
            payload->>'facebook_post_link' AS facebook_post_link,
            payload->'hashtags_used' AS hashtags_used,
            length(payload->>'post_content') AS post_content_chars,
            length(payload->>'summary') AS summary_chars
     FROM ${PUB} WHERE normalized_url = $1`,
    [normalizedUrl],
  );
  out.row_written = confirm.rowCount;
  out.confirmed_row = confirm.rows[0];
  out.post_count = Number((await client.query(`SELECT COUNT(*)::int AS c FROM ${PUB}`)).rows[0].c);
  out.run_row = (await client.query(`SELECT run_id, status, facebook_post_id FROM ${RUNS} WHERE run_id = $1`, [runId])).rows[0];
  out.published_urls_total = Number(
    (await client.query(`SELECT COUNT(*)::int AS c FROM ${PUB} WHERE claim_status IN ('claimed','published')`)).rows[0].c,
  );
} finally {
  await client.end();
}

console.log(JSON.stringify(out, null, 2));
