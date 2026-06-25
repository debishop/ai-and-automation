// Step 10/10 of Run THEAAAAA-619: log the published reel record into the
// production dedup store `public.facebook_publications`.
//
// Fail-closed gate satisfied OUT of this script: Step 9 (THEAAAAA-630) status
// = done AND `pipeline-guard-check.mjs dedup-log --artifact …` exit 0.
//
// Connection: direct `pg` Client on DATABASE_URL (owner role `fb_routine`),
// ssl rejectUnauthorized:false, explicit connect/query/statement timeouts.
// Idempotent: ON CONFLICT (normalized_url) DO NOTHING.
//
// Secrets via Doppler edge token DOPPLER_TOKEN_EDGE. No secret is printed.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";
import { normalizeUrl } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const record = JSON.parse(await readFile(join(here, "..", ".run-619-record.json"), "utf8"));

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

const normalizedUrl = normalizeUrl(record.article_url);
const fbPostId = record.facebook_post_id;

const payload = {
  title: record.title,
  source: record.source,
  article_url: record.article_url,
  normalized_url: normalizedUrl,
  summary: record.summary,
  score_detail: record.score_detail,
  media_source: record.media_source,
  used_fallback: record.used_fallback,
  fallback_note: record.fallback_note,
  facebook_post_id: fbPostId,
  facebook_post_link: record.permalink,
  facebook_photo_id: record.photo_id,
  hashtags_used: record.hashtags_used,
  provenance: record.provenance,
  media_type: record.media_type,
  reel_video_id: record.reel_video_id,
  duplicate_publish_note: record.duplicate_publish_note,
  logged_by_step: "THEAAAAA-631",
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

  const confirm = await client.query(
    `SELECT normalized_url, headline, score, used_fallback, claim_status, claim_run_id,
            facebook_post_id, published_at,
            payload->>'score_detail' AS score_detail,
            payload->>'facebook_post_link' AS facebook_post_link,
            payload->>'media_type' AS media_type,
            payload->>'reel_video_id' AS reel_video_id
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
