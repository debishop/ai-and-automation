// Credential-backed smoke for the comment-response routine.
// The live page currently has zero organic comments, so this seeds ONE realistic
// QA comment, drives the real production runner to reply, proves idempotency and the
// 24h filter, prints the Postgres audit rows, then deletes the seeded artifacts so
// the live page stays clean. Never prints secret values.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { FacebookCommentClient, filterEligibleComments } from "../src/comment-responder.js";

const run = promisify(execFile);

async function loadSecrets() {
  const tok = process.env.DOPPLER_TOKEN_EDGE;
  const auth = "Basic " + Buffer.from(`${tok}:`).toString("base64");
  const res = await fetch(
    "https://api.doppler.com/v3/configs/config/secrets?project=ai-and-automation&config=prd",
    { headers: { Authorization: auth } },
  );
  const body = await res.json();
  const s = (n) => body.secrets[n].computed;
  return {
    pageId: s("FACEBOOK_PAGE_ID"),
    systemUserToken: s("FACEBOOK_SYSTEM_USER_TOKEN"),
    databaseUrl: s("DATABASE_URL"),
    table: "public.facebook_comment_replies",
  };
}

const sec = await loadSecrets();
const client = new FacebookCommentClient({ pageId: sec.pageId, systemUserToken: sec.systemUserToken });
const log = (label, obj) => console.log(`\n### ${label}\n` + (typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)));

// 1. Seed a realistic QA comment on the most recent post.
const posts = await client.listRecentPosts({ limit: 1 });
const post = posts[0];
const seedText = "[QA smoke] Does this mean smaller devs can finally ship AI features without huge cloud bills?";
const seedId = await client.createComment(post.id, seedText);
log("1. Seeded QA comment", { post_id: post.id, seed_comment_id: seedId });

const replyText =
  "Good question. On-device inference removes the per-call cloud bill, so indie devs can ship AI features cheaply. What would you build first?";
await writeFile("/tmp/replies.json", JSON.stringify({ [seedId]: replyText }));

// 2. Run the REAL production runner (reply phase) with the seed id whitelisted.
const r1 = await run(
  "node",
  ["scripts/run-comment-replies.mjs", "--replies", "/tmp/replies.json", "--include-comment-ids", seedId, "--log", "logs/comment-smoke.json"],
  { env: process.env },
);
log("2. First run (should reply)", r1.stdout.trim());

// 3. Read back the live reply from Graph to prove it is real.
const summary = JSON.parse(await readFile("logs/comment-smoke.json", "utf8"));
const replied = summary.results.find((x) => x.outcome === "replied");
let replyId = null;
if (replied) {
  replyId = replied.reply_id;
  const back = await client.readComment(replyId);
  log("3. Graph read-back of posted reply", {
    reply_id: replyId,
    live_text: back.message,
    created_time: back.created_time,
    permalink: `https://www.facebook.com/${replyId.replace("_", "/posts/")}`,
  });
}

// 4. Idempotency: run again, must NOT post a second reply.
const r2 = await run(
  "node",
  ["scripts/run-comment-replies.mjs", "--replies", "/tmp/replies.json", "--include-comment-ids", seedId],
  { env: process.env },
);
log("4. Second run (idempotent — expect already_replied)", r2.stdout.trim());

// 5. 24h filter unit check: a comment older than 24h is excluded.
const old = {
  id: "old_test",
  created_time: new Date(Date.now() - 36 * 3600 * 1000).toISOString(),
  from: { id: "someone" },
  message: "old",
};
const fresh = {
  id: "fresh_test",
  created_time: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
  from: { id: "someone" },
  message: "fresh",
};
const filtered = filterEligibleComments({
  comments: [old, fresh, { id: "self", created_time: new Date().toISOString(), from: { id: sec.pageId }, message: "self" }],
  pageId: sec.pageId,
  repliedIds: new Set(),
  now: Date.now(),
});
log("5. 24h + self-author filter check", {
  input: ["old(36h)", "fresh(1h)", "page-self(now)"],
  eligible_ids: filtered.map((c) => c.id),
  expect: ["fresh_test"],
});

// 6. Postgres audit rows.
const pg = new Client({ connectionString: sec.databaseUrl });
await pg.connect();
const rows = await pg.query(
  `SELECT comment_id, post_id, left(comment_text,60) AS comment_in, left(reply_text,80) AS reply_out, reply_id, outcome, replied_at
   FROM ${sec.table} WHERE comment_id=$1`,
  [seedId],
);
log("6. Postgres audit row (facebook_comment_replies)", rows.rows);
await pg.end();

// 7. Cleanup seeded artifacts so the live page stays clean (audit row is retained as evidence).
if (replyId) await client.deleteObject(replyId);
await client.deleteObject(seedId);
log("7. Cleanup", { deleted_reply: replyId, deleted_seed: seedId, note: "DB audit row retained as evidence" });
