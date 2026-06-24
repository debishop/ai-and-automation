// Step 9 (publish) — Facebook Reel publish via the video_reels 3-phase API (THEAAAAA-434).
//
// Replaces the legacy Graph *photo* publish with the `video_reels` start → upload → finish flow
// (recipe THEAAAAA-322) for the stitched 9:16 reel mp4 produced by Step 8.7 (scripts/build_reel.sh,
// THEAAAAA-433). Mints a Page access token at runtime from FACEBOOK_SYSTEM_USER_TOKEN.
//
// Usage:
//   node scripts/publish-reel.mjs \
//     --reel /path/to/final_reel.mp4 \
//     --caption "approved post text (Step 8.5)" \
//     [--page-id 1097492980106238] [--dry-run]
//
// Env: FACEBOOK_SYSTEM_USER_TOKEN (required for a live publish), FACEBOOK_PAGE_ID (optional).
//
// --dry-run performs the full OFFLINE validation (mp4 is a real 9:16 vertical video + the 205-word
// caption cap) and prints the artifact SHAPE the live publish would emit, WITHOUT any Graph call.
// The board has gated the live run (THEAAAAA-431): this is the only mode this work is allowed to
// exercise until a test run is explicitly authorized.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { withinWordCap, wordCount, CAPTION_WORD_CAP } from "../src/pipeline-guard.js";
import {
  GUARD_WINDOW_MINUTES,
  checkRecentHash,
  computeContentHash,
  recordContentHash,
} from "../src/content-hash.js";

const GRAPH_VERSION = "v22.0";
const DEFAULT_PAGE_ID = "1097492980106238"; // The Lens — AI and Automation

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      out[key] = next && !next.startsWith("--") ? argv[(i += 1)] : true;
    }
  }
  return out;
}

// ffprobe the mp4 and assert it is a real 9:16 (portrait) H.264 video. Returns probe facts.
export function probeReel(path) {
  statSync(path); // throws if missing
  const r = spawnSync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,codec_name:format=duration",
      "-of", "json",
      path,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr || r.status}`);
  const probe = JSON.parse(r.stdout);
  const stream = (probe.streams && probe.streams[0]) || {};
  const width = Number(stream.width);
  const height = Number(stream.height);
  const duration = Number(probe.format && probe.format.duration);
  const reasons = [];
  if (!(width > 0 && height > 0)) reasons.push("could not read video dimensions");
  if (width >= height) reasons.push(`not portrait: ${width}x${height} (need height > width)`);
  // 9:16 == 0.5625. Allow a small tolerance for letterboxed canvases.
  const ratio = width / height;
  if (Math.abs(ratio - 9 / 16) > 0.02) reasons.push(`aspect ratio ${ratio.toFixed(4)} != 9:16`);
  if (!(duration > 0)) reasons.push("non-positive duration");
  return { ok: reasons.length === 0, reasons, width, height, duration, codec: stream.codec_name };
}

// Validate the inputs every publish (live or dry) must satisfy before a single byte is uploaded.
export function validatePublishInputs({ reelPath, caption }) {
  const reasons = [];
  let probe = null;
  try {
    probe = probeReel(reelPath);
    if (!probe.ok) reasons.push(...probe.reasons);
  } catch (err) {
    reasons.push(`reel mp4 unreadable: ${err.message}`);
  }
  if (!withinWordCap(caption)) {
    reasons.push(`caption fails ${CAPTION_WORD_CAP}-word cap (count=${wordCount(caption)})`);
  }
  return { ok: reasons.length === 0, reasons, probe };
}

async function mintPageToken(pageId, systemUserToken, fetchImpl = fetch) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}?fields=access_token&access_token=${systemUserToken}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`page token lookup failed HTTP ${res.status}`);
  const payload = await res.json();
  if (!payload.access_token) throw new Error("page token lookup response missing access_token");
  return payload.access_token;
}

// Live 3-phase video_reels publish. Intentionally not exercised under the board gate; kept here so
// the chain is ready-to-run the moment a test run is authorized.
async function publishReelLive({ reelPath, caption, pageId, token, fetchImpl = fetch }) {
  // Phase 1 — start: reserve a video container + upload endpoint.
  const startRes = await fetchImpl(
    `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/video_reels`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upload_phase: "start", access_token: token }),
    },
  );
  if (!startRes.ok) throw new Error(`reel start failed HTTP ${startRes.status}`);
  const start = await startRes.json();
  const videoId = start.video_id;
  const uploadUrl = start.upload_url;
  if (!videoId || !uploadUrl) throw new Error("reel start response missing video_id/upload_url");

  // Phase 2 — upload bytes via rupload endpoint.
  const bytes = readFileSync(reelPath);
  const upRes = await fetchImpl(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${token}`,
      offset: "0",
      file_size: String(bytes.length),
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
  });
  if (!upRes.ok) throw new Error(`reel upload failed HTTP ${upRes.status}`);

  // Phase 3 — finish: publish with the approved caption.
  const finishUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/video_reels` +
    `?upload_phase=finish&video_id=${encodeURIComponent(videoId)}` +
    `&video_state=PUBLISHED&description=${encodeURIComponent(caption)}&access_token=${token}`;
  const finRes = await fetchImpl(finishUrl, { method: "POST" });
  if (!finRes.ok) throw new Error(`reel finish failed HTTP ${finRes.status}`);
  const fin = await finRes.json();

  // Resolve permalink + post_id for the published reel.
  const infoRes = await fetchImpl(
    `https://graph.facebook.com/${GRAPH_VERSION}/${videoId}?fields=permalink_url,post_id,published&access_token=${token}`,
  );
  const info = infoRes.ok ? await infoRes.json() : {};
  const permalink = info.permalink_url
    ? info.permalink_url.startsWith("http")
      ? info.permalink_url
      : `https://www.facebook.com${info.permalink_url}`
    : null;
  return {
    media_type: "reel",
    video_id: String(videoId),
    facebook_post_id: info.post_id ? String(info.post_id) : null,
    permalink,
    is_published: info.published === true,
    finish: fin,
  };
}

// Opens a pg Client against DATABASE_URL with the same timeout posture as the
// Step 10 dedup-log script. Returns null when DATABASE_URL is unset AND the caller
// allowed skipping (dry-run smokes can opt out via --skip-guard). A live publish
// without DATABASE_URL must fail closed.
async function openGuardClient({ required }) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (required) throw new Error("DATABASE_URL required for content-hash guard");
    return null;
  }
  const { Client } = await import("pg");
  const c = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
    query_timeout: 10_000,
  });
  await c.connect();
  return c;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reelPath = args.reel;
  const caption = typeof args.caption === "string" ? args.caption : "";
  const pageId = args["page-id"] || process.env.FACEBOOK_PAGE_ID || DEFAULT_PAGE_ID;
  const dryRun = Boolean(args["dry-run"]);
  const skipGuard = Boolean(args["skip-guard"]);

  if (!reelPath) {
    console.error("usage: node scripts/publish-reel.mjs --reel <mp4> --caption <text> [--dry-run] [--skip-guard]");
    process.exit(2);
  }

  const validation = validatePublishInputs({ reelPath, caption });
  if (!validation.ok) {
    console.error(JSON.stringify({ ok: false, stage: "validate", reasons: validation.reasons }, null, 2));
    process.exit(1);
  }

  // Content-hash idempotency guard (THEAAAAA-586). Computed BEFORE the start phase so a
  // duplicate publish never reserves a video container in Graph. Hash inputs:
  // normalized caption + raw mp4 bytes + page id. Fail-closed exit code 9.
  const mediaBytes = readFileSync(reelPath);
  const contentHash = computeContentHash({ caption, mediaBytes, pageId });
  let guardClient = null;
  let priorGuardHit = null;
  if (!skipGuard) {
    guardClient = await openGuardClient({ required: !dryRun });
    if (guardClient) {
      priorGuardHit = await checkRecentHash(guardClient, {
        contentHash,
        pageId,
        isDryRun: dryRun,
        windowMinutes: GUARD_WINDOW_MINUTES,
      });
      if (priorGuardHit) {
        console.error(
          JSON.stringify(
            {
              ok: false,
              stage: "content-hash-guard",
              reason: "duplicate publish attempt within window",
              windowMinutes: GUARD_WINDOW_MINUTES,
              pageId,
              contentHash,
              priorGuardHit,
              note:
                "fail-closed: a publish with this exact (caption, media, page) shipped less than " +
                `${GUARD_WINDOW_MINUTES} minutes ago. Investigate before retrying.`,
            },
            null,
            2,
          ),
        );
        await guardClient.end();
        process.exit(9);
      }
    }
  }

  if (dryRun) {
    // Offline proof: inputs are publish-ready; emit the artifact shape, fire nothing.
    // Record the guard hit so a repeated dry-run within the window is rejected above.
    let dryGuardRecord = null;
    if (guardClient) {
      dryGuardRecord = await recordContentHash(guardClient, {
        contentHash,
        pageId,
        postId: null,
        isDryRun: true,
        note: "publish-reel.mjs --dry-run",
      });
      await guardClient.end();
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          stage: "validated-offline",
          pageId,
          probe: validation.probe,
          captionWords: wordCount(caption),
          contentHash,
          guard: guardClient
            ? { recorded: true, windowMinutes: GUARD_WINDOW_MINUTES, record: dryGuardRecord }
            : { recorded: false, reason: "DATABASE_URL not set (--skip-guard or unset)" },
          plannedArtifact: {
            media_type: "reel",
            video_id: "<bare-numeric reel id from finish phase>",
            facebook_post_id: "<{pageId}_{postId} from reel info>",
            permalink: "<https facebook.com reel permalink>",
          },
          note: "Live publish gated by board (THEAAAAA-431) — no Graph call fired.",
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const systemUserToken = process.env.FACEBOOK_SYSTEM_USER_TOKEN;
  if (!systemUserToken) {
    if (guardClient) await guardClient.end();
    console.error("FACEBOOK_SYSTEM_USER_TOKEN required for a live publish");
    process.exit(2);
  }
  try {
    const token = await mintPageToken(pageId, systemUserToken);
    const artifact = await publishReelLive({ reelPath, caption, pageId, token });
    if (guardClient) {
      await recordContentHash(guardClient, {
        contentHash,
        pageId,
        postId: artifact.facebook_post_id,
        isDryRun: false,
        note: `video_id=${artifact.video_id}`,
      });
    }
    console.log(JSON.stringify({ ok: true, dryRun: false, contentHash, artifact }, null, 2));
  } finally {
    if (guardClient) await guardClient.end();
  }
}

// Only run main when invoked as a script (allows importing the pure validators in tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
