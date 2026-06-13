// Operational daily runner for The Lens Facebook routine.
// Pulls production secrets from Doppler at runtime (via the injected DOPPLER_TOKEN_EDGE
// service token), then drives the publish/dedupe/audit core in src/index.js.
// Never prints secret values. Prints only a non-sensitive run summary.
import { readFile } from "node:fs/promises";
import {
  FacebookPublisher,
  FacebookRoutine,
  PostgresPublicationStore,
  writeRunResult,
} from "../src/index.js";

const candidatesPath = process.argv[2];
const runLogPath = process.argv[3];
if (!candidatesPath || !runLogPath) {
  throw new Error("usage: node scripts/run-daily.mjs <candidates.json> <run-log.json>");
}

const dopplerToken = process.env.DOPPLER_TOKEN_EDGE;
if (!dopplerToken) throw new Error("DOPPLER_TOKEN_EDGE not present in environment");

const auth = "Basic " + Buffer.from(`${dopplerToken}:`).toString("base64");
const res = await fetch(
  "https://api.doppler.com/v3/configs/config/secrets?project=ai-and-automation&config=prd",
  { headers: { Authorization: auth } },
);
if (!res.ok) throw new Error(`Doppler fetch failed: HTTP ${res.status}`);
const body = await res.json();
const secret = (name) => {
  const entry = body.secrets?.[name];
  if (!entry || entry.computed == null) throw new Error(`Missing Doppler secret: ${name}`);
  return entry.computed;
};

const pageId = secret("FACEBOOK_PAGE_ID");
const systemUserToken = secret("FACEBOOK_SYSTEM_USER_TOKEN");
const databaseUrl = secret("DATABASE_URL");
const publicationsTable = secret("FACEBOOK_PUBLICATIONS_TABLE");
const runsTable = secret("FACEBOOK_RUNS_TABLE");

const candidatePayloads = JSON.parse(await readFile(candidatesPath, "utf8"));

const publicationStore = new PostgresPublicationStore({
  connectionString: databaseUrl,
  publicationsTable,
  runsTable,
});
const routine = new FacebookRoutine({
  publisher: new FacebookPublisher({ pageId, systemUserToken }),
  publicationStore,
});

try {
  const result = await routine.run(candidatePayloads);
  await writeRunResult(runLogPath, result);
  console.log(
    JSON.stringify(
      {
        run_id: result.run_id,
        status: result.status,
        selected_headline: result.selected_story?.headline ?? null,
        facebook_post_id: result.selected_story?.facebook_post_id ?? null,
        score: result.selected_story?.score ?? null,
        used_fallback: result.selected_story?.used_fallback ?? null,
        duplicate_urls: result.duplicate_urls,
        rejected_count: result.rejected?.length ?? 0,
        evaluations: result.evaluations?.map((e) => ({
          headline: e.headline,
          score: e.score,
          used_fallback: e.used_fallback,
          gate_failures: e.gate_failures,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await publicationStore.close();
}
