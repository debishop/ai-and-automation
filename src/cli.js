import { readFile } from "node:fs/promises";

import { FacebookPublisher, FacebookRoutine, PostgresPublicationStore, writeRunResult } from "./index.js";

function getArg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const candidatesPath = getArg("--candidates");
const runLogPath = getArg("--run-log");
const pageId = getArg("--page-id") || process.env.FACEBOOK_PAGE_ID;
const accessToken = getArg("--access-token") || process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
const systemUserToken = getArg("--system-user-token") || process.env.FACEBOOK_SYSTEM_USER_TOKEN;
const databaseUrl = getArg("--database-url") || process.env.DATABASE_URL;
const publicationsTable = getArg("--publications-table") || process.env.FACEBOOK_PUBLICATIONS_TABLE;
const runsTable = getArg("--runs-table") || process.env.FACEBOOK_RUNS_TABLE;

if (!candidatesPath || !runLogPath) {
  throw new Error("Missing required args: --candidates --run-log");
}

if (!pageId || (!accessToken && !systemUserToken)) {
  throw new Error(
    "FACEBOOK_PAGE_ID and either FACEBOOK_PAGE_ACCESS_TOKEN or FACEBOOK_SYSTEM_USER_TOKEN are required",
  );
}

if (!databaseUrl || !publicationsTable || !runsTable) {
  throw new Error(
    "DATABASE_URL, FACEBOOK_PUBLICATIONS_TABLE, and FACEBOOK_RUNS_TABLE are required for PostgreSQL logging",
  );
}

const candidatePayloads = JSON.parse(await readFile(candidatesPath, "utf8"));
const publicationStore = new PostgresPublicationStore({
  connectionString: databaseUrl,
  publicationsTable,
  runsTable,
});
const routine = new FacebookRoutine({
  publisher: new FacebookPublisher({ pageId, accessToken, systemUserToken }),
  publicationStore,
});
try {
  const result = await routine.run(candidatePayloads);
  await writeRunResult(runLogPath, result);
} finally {
  await publicationStore.close();
}
