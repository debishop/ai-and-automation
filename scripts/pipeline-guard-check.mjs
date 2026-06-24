// Operational fail-closed check for the publish pipeline step chain (THEAAAAA-380).
//
// A step agent runs this BEFORE marking its step `done`. It prints the only disposition
// the step is allowed to take and exits non-zero when fail-closed blocks a `done`, so a
// step can never be advanced to `done` without proof-of-work.
//
// Usage:
//   # Step 9 (publish): pass the upstream gate status + the captured publish artifact.
//   # Photo (legacy):
//   node scripts/pipeline-guard-check.mjs publish \
//     --gate-status done \
//     --artifact '{"facebook_post_id":"1097492980106238_123","permalink":"https://www.facebook.com/.../posts/123"}'
//   # Reel (video_reels, THEAAAAA-434): also carries media_type + video_id (the reel id).
//   node scripts/pipeline-guard-check.mjs publish \
//     --gate-status done \
//     --artifact '{"media_type":"reel","video_id":"123","facebook_post_id":"1097492980106238_123","permalink":"https://www.facebook.com/reel/123"}'
//
//   # Step 10 (dedup-log): pass the Step 9 artifact (or omit to assert absence).
//   node scripts/pipeline-guard-check.mjs dedup-log \
//     --artifact '{"facebook_post_id":"1097492980106238_123","permalink":"https://www.facebook.com/.../posts/123"}'
//
// Exit code 0 => allowed disposition is `done`. Exit code 1 => `blocked` (fail closed).
import {
  resolvePublishStepDisposition,
  resolveDedupLogStepDisposition,
  STEP_DONE,
} from "../src/pipeline-guard.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[(i += 1)] : "true";
      out[key] = value;
    }
  }
  return out;
}

const [, , step, ...rest] = process.argv;
const args = parseArgs(rest);

function readArtifact() {
  if (!args.artifact || args.artifact === "true") return null;
  try {
    return JSON.parse(args.artifact);
  } catch (error) {
    throw new Error(`--artifact is not valid JSON: ${error.message}`);
  }
}

let disposition;
if (step === "publish") {
  disposition = resolvePublishStepDisposition({
    upstreamGate: { status: args["gate-status"] ?? "" },
    artifact: readArtifact(),
  });
} else if (step === "dedup-log") {
  const artifact = readArtifact();
  const publishStep = resolvePublishStepDisposition({
    upstreamGate: { status: "done" },
    artifact,
  });
  disposition = resolveDedupLogStepDisposition({ publishStep });
} else {
  console.error("usage: node scripts/pipeline-guard-check.mjs <publish|dedup-log> [--gate-status S] [--artifact JSON]");
  process.exit(2);
}

console.log(JSON.stringify({ step, ...disposition }, null, 2));
process.exit(disposition.status === STEP_DONE ? 0 : 1);
