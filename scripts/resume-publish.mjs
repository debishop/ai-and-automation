#!/usr/bin/env node
// THEAAAAA-499 — manual-retry surface for the VEP publisher.
//
// Resumes publishing for an existing vep_runs row using the same module,
// reusing the advisory-lock + dup-row guards. Approved image+caption stay in
// vep_runs, so an authorized operator can re-trigger after a final failure.
//
// Usage:
//   node scripts/resume-publish.mjs --run-id <uuid> [--page-id 1097492980106238]
//                                   [--tracking-issue THEAAAAA-NNN] [--dry-run]
//
// --dry-run prints the message + image URL + token source the live run would use,
// without calling Graph and without touching the DB beyond a SELECT.
import {
  publishRun,
  resolvePageToken,
  composeMessage,
  validateImage,
  inferContentType,
  makePaperclipFailureHook,
  connectPg,
  DEFAULT_PAGE_ID,
} from "../src/vep/publish-post.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = args["run-id"];
  if (!runId) {
    console.error("usage: node scripts/resume-publish.mjs --run-id <uuid> [--dry-run]");
    process.exit(2);
  }
  const pageId = args["page-id"] || process.env.FACEBOOK_PAGE_ID || DEFAULT_PAGE_ID;
  const dryRun = Boolean(args["dry-run"]);
  const trackingIssue = args["tracking-issue"] || null;

  const pg = connectPg();
  await pg.connect();
  try {
    if (dryRun) {
      const r = await pg.query(
        `SELECT run_id, topic_hash, caption, core_hashtags, topic_hashtags,
                audience_mentions, image_url, image_width, image_height,
                publishing_result, retry_count
           FROM vep_runs WHERE run_id = $1`,
        [runId],
      );
      if (r.rowCount === 0) {
        console.error(JSON.stringify({ ok: false, error: "run_id not found" }));
        process.exit(1);
      }
      const run = r.rows[0];
      const imgValid = validateImage({
        width: run.image_width,
        height: run.image_height,
        contentType: inferContentType(run.image_url),
      });
      const message = composeMessage({
        caption: run.caption,
        coreHashtags: run.core_hashtags,
        topicHashtags: run.topic_hashtags,
        audienceMentions: run.audience_mentions,
      });
      let tokenSource = null;
      try {
        ({ source: tokenSource } = await resolvePageToken({ pageId }));
      } catch (err) {
        tokenSource = `unavailable: ${err.message}`;
      }
      console.log(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            run_id: run.run_id,
            page_id: pageId,
            current_publishing_result: run.publishing_result,
            retry_count: run.retry_count,
            token_source: tokenSource,
            image: {
              url: run.image_url,
              width: run.image_width,
              height: run.image_height,
              validation: imgValid,
            },
            message_preview: message.slice(0, 280),
            note: "No Graph call fired; no DB writes.",
          },
          null,
          2,
        ),
      );
      return;
    }

    const onFinalFailure = trackingIssue
      ? makePaperclipFailureHook({ issueId: trackingIssue })
      : null;
    const result = await publishRun({ runId, pgClient: pg, pageId, onFinalFailure });
    console.log(JSON.stringify({ ok: true, result }, null, 2));
    if (result.failed) process.exit(1);
  } finally {
    await pg.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message, stage: err.stage }));
  process.exit(1);
});
