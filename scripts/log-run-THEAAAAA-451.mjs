// Step 10/10 of Run THEAAAAA-439: log the published record into the production
// dedup store `public.facebook_publications`.
//
// Fail-closed gate was already satisfied OUTSIDE this script (Step 9 THEAAAAA-450
// status=done + `pipeline-guard-check.mjs dedup-log` exit 0). This script only
// performs the idempotent INSERT and reports INSERTED_ROWS + new total.
//
// Connection: direct `pg` Client on DATABASE_URL (connects AS owner role
// `fb_routine`), ssl rejectUnauthorized:false, explicit statement/connect/query
// timeouts. Idempotent: ON CONFLICT (normalized_url) DO NOTHING.
//
// Secrets pulled from Doppler at runtime via DOPPLER_TOKEN_EDGE. No secret is
// ever printed. This run published a Facebook *Reel*, so the payload records
// media_type:"reel" and reel_video_id:"<Step 9 video_id>".
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";
import { normalizeUrl } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const record = JSON.parse(await readFile(join(here, "..", ".run-439-record.json"), "utf8"));

// --- Resolve production secrets from Doppler ---
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

const VALID_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
function quoteTableName(name) {
  if (!VALID_TABLE_NAME.test(name)) throw new Error(`Invalid table name: ${name}`);
  return name.split(".").map((p) => `"${p}"`).join(".");
}
const PUB = quoteTableName(publicationsTableRaw);

// normalized_url = canonical article URL, trailing-slash stripped (dedup key).
const normalizedUrl = normalizeUrl(record.article_url);
const fbPostId = record.facebook_post_id;

// score column is INT; the decimal average is preserved in payload.score_detail.
const payload = {
  title: record.title,
  source: record.source,
  article_url: record.article_url,
  normalized_url: normalizedUrl,
  summary: record.summary,
  score_detail: record.score_detail,
  media_source: record.media_source,
  media_type: record.media_type, // "reel"
  reel_video_id: record.reel_video_id, // Step 9 video_id
  used_fallback: record.used_fallback,
  fallback_note: record.fallback_note,
  facebook_post_id: fbPostId,
  facebook_post_link: record.permalink,
  hashtags_used: record.hashtags_used,
  provenance: record.provenance,
  logged_by_step: "THEAAAAA-451",
};

const client = new Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10_000,
  statement_timeout: 10_000,
  query_timeout: 10_000,
});

const out = {};
try {
  await client.connect();

  out.pre_count = Number(
    (await client.query(`SELECT COUNT(*)::int AS c FROM ${PUB} WHERE claim_status = 'published'`)).rows[0].c,
  );
  out.pre_existing = (
    await client.query(
      `SELECT normalized_url, facebook_post_id, claim_status FROM ${PUB} WHERE normalized_url = $1 OR facebook_post_id = $2`,
      [normalizedUrl, fbPostId],
    )
  ).rows;

  // Idempotent INSERT — ON CONFLICT (normalized_url) DO NOTHING.
  const ins = await client.query(
    `
      INSERT INTO ${PUB} (
        normalized_url, article_url, headline, score, used_fallback,
        claim_run_id, claim_status, claimed_at, published_at, facebook_post_id, payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'published', NOW(), $7, $8, $9::jsonb)
      ON CONFLICT (normalized_url) DO NOTHING
    `,
    [
      normalizedUrl,
      record.article_url,
      record.headline,
      record.score_int,
      record.used_fallback,
      record.claim_run_id,
      record.published_at,
      fbPostId,
      JSON.stringify(payload),
    ],
  );
  out.inserted_rows = ins.rowCount;

  // Read back the row of record (whether just-inserted or pre-existing).
  const confirm = await client.query(
    `SELECT normalized_url, headline, score, used_fallback, claim_status, claim_run_id,
            facebook_post_id, published_at,
            payload->>'score_detail' AS score_detail,
            payload->>'media_type'  AS media_type,
            payload->>'reel_video_id' AS reel_video_id,
            payload->>'facebook_post_link' AS facebook_post_link
     FROM ${PUB} WHERE normalized_url = $1`,
    [normalizedUrl],
  );
  out.confirmed_row = confirm.rows[0] || null;
  out.post_count_published = Number(
    (await client.query(`SELECT COUNT(*)::int AS c FROM ${PUB} WHERE claim_status = 'published'`)).rows[0].c,
  );
} finally {
  await client.end();
}

console.log(JSON.stringify(out, null, 2));
