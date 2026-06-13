// Comment-response runner for The Lens (Facebook only).
// Pulls production secrets from Doppler at runtime via the injected DOPPLER_TOKEN_EDGE
// service token, then drives the comment fetch/filter/reply/log core.
// Never prints secret values.
//
// Two phases (the contextual reply text is authored by the heartbeat agent,
// mirroring the publish routine where the agent writes the post and the code ships it):
//
//   node scripts/run-comment-replies.mjs --list <out.json>
//       -> writes eligible comments (last 24h, not from page, not yet replied)
//
//   node scripts/run-comment-replies.mjs --replies <replies.json> [--log <out.json>]
//       -> replies.json = { "<commentId>": "<reply text 0-30 words>", ... }
//          claims (idempotent), posts via Graph API, logs to facebook_comment_replies
//
// Smoke-only flags:
//   --include-comment-ids id1,id2   allow specific ids even if authored by the page
//                                    (used so a seeded QA comment can be exercised)
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  FacebookCommentClient,
  PostgresCommentReplyStore,
  PostgresCommentSeedStore,
  filterEligibleComments,
  seedMostRecentPost,
} from "../src/comment-responder.js";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadSecrets() {
  const tok = process.env.DOPPLER_TOKEN_EDGE;
  if (!tok) throw new Error("DOPPLER_TOKEN_EDGE not present in environment");
  const auth = "Basic " + Buffer.from(`${tok}:`).toString("base64");
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
  return {
    pageId: secret("FACEBOOK_PAGE_ID"),
    systemUserToken: secret("FACEBOOK_SYSTEM_USER_TOKEN"),
    databaseUrl: secret("DATABASE_URL"),
    repliesTable: process.env.FACEBOOK_COMMENT_REPLIES_TABLE || "public.facebook_comment_replies",
    seedsTable: process.env.FACEBOOK_COMMENT_SEEDS_TABLE || "public.facebook_comment_seeds",
  };
}

// Self-serve seed step. Runs once per window firing; idempotent per post id so
// reruns/overlaps never double-seed. Non-critical: a failure here is logged and
// swallowed so the primary reply path always proceeds.
async function runSeedStep({ client, seedStore }) {
  try {
    const result = await seedMostRecentPost({ client, store: seedStore });
    console.log(JSON.stringify({ phase: "seed", ...result }, null, 2));
    return result;
  } catch (err) {
    console.log(JSON.stringify({ phase: "seed", outcome: "error", error: err.message }, null, 2));
    return { outcome: "error", error: err.message };
  }
}

async function writeJson(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

async function gatherEligible({ client, store, pageId, includeIds }) {
  const repliedIds = await store.loadRepliedCommentIds();
  const now = Date.now();
  const posts = await client.listRecentPosts({ limit: 10 });
  const eligible = [];
  for (const post of posts) {
    const comments = await client.listComments(post.id, { limit: 50 });
    let pool = filterEligibleComments({ comments, pageId, repliedIds, now });
    // Smoke override: allow explicit ids even if authored by the page, still <24h + not replied.
    if (includeIds.size) {
      const extra = comments.filter(
        (c) =>
          includeIds.has(c.id) &&
          !repliedIds.has(c.id) &&
          now - new Date(c.created_time).getTime() <= 24 * 60 * 60 * 1000 &&
          !pool.some((p) => p.id === c.id),
      );
      pool = pool.concat(extra);
    }
    for (const c of pool) {
      eligible.push({
        comment_id: c.id,
        post_id: post.id,
        created_time: c.created_time,
        author: c.from?.name || c.from?.id || null,
        message: c.message || "",
      });
    }
  }
  return eligible;
}

const secrets = await loadSecrets();
const includeIds = new Set((arg("--include-comment-ids") || "").split(",").map((s) => s.trim()).filter(Boolean));

const client = new FacebookCommentClient({ pageId: secrets.pageId, systemUserToken: secrets.systemUserToken });
const store = new PostgresCommentReplyStore({ connectionString: secrets.databaseUrl, table: secrets.repliesTable });
const seedStore = new PostgresCommentSeedStore({ connectionString: secrets.databaseUrl, table: secrets.seedsTable });

try {
  // Self-serve seeding: auto-seed the most-recent post once per window firing,
  // before/alongside replies. Idempotent + graceful-degrade so it can never take
  // down the reply path. `--seed-only` runs just this step (used by the CTO smoke).
  const seedResult = await runSeedStep({ client, seedStore });

  if (process.argv.includes("--seed-only")) {
    console.log(JSON.stringify({ phase: "seed-only", seed: seedResult }, null, 2));
  } else if (process.argv.includes("--list")) {
    const out = arg("--list");
    const eligible = await gatherEligible({ client, store, pageId: secrets.pageId, includeIds });
    await writeJson(out, { generated_run_id: randomUUID(), count: eligible.length, eligible });
    console.log(JSON.stringify({ phase: "list", eligible_count: eligible.length, out }, null, 2));
  } else if (process.argv.includes("--replies")) {
    const runId = randomUUID();
    const repliesPath = arg("--replies");
    const replies = JSON.parse(await readFile(repliesPath, "utf8"));
    const logPath = arg("--log");
    const eligible = await gatherEligible({ client, store, pageId: secrets.pageId, includeIds });
    const byId = new Map(eligible.map((e) => [e.comment_id, e]));
    const results = [];
    for (const [commentId, replyText] of Object.entries(replies)) {
      const ctx = byId.get(commentId);
      if (!ctx) {
        results.push({ comment_id: commentId, outcome: "skipped_not_eligible" });
        continue;
      }
      const wc = wordCount(replyText);
      if (wc < 1 || wc > 30) {
        results.push({ comment_id: commentId, outcome: "skipped_bad_length", words: wc });
        continue;
      }
      const claimed = await store.claim({
        commentId,
        postId: ctx.post_id,
        commentText: ctx.message,
        commentAuthor: ctx.author,
        commentCreatedTime: ctx.created_time,
        replyText,
        runId,
      });
      if (!claimed) {
        results.push({ comment_id: commentId, outcome: "already_replied" });
        continue;
      }
      try {
        const replyId = await client.replyToComment(commentId, replyText);
        const readBack = await client.readComment(replyId);
        await store.markReplied({
          commentId,
          replyId,
          runId,
          payload: { reply_text: replyText, read_back: readBack, words: wc },
        });
        results.push({ comment_id: commentId, outcome: "replied", reply_id: replyId, words: wc, read_back_ok: !!readBack.id });
      } catch (err) {
        await store.markFailed({ commentId, runId, reason: err.message });
        results.push({ comment_id: commentId, outcome: "failed", error: err.message });
      }
    }
    const summary = { run_id: runId, eligible_count: eligible.length, results };
    if (logPath) await writeJson(logPath, summary);
    console.log(JSON.stringify(summary, null, 2));
  } else {
    throw new Error("usage: [--seed-only] | --list <out.json> | --replies <replies.json> [--log <out.json>]");
  }
} finally {
  await store.close();
  await seedStore.close();
}
