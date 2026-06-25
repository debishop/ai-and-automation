// FB single-image (photo) publish — THEAAAAA-589 experiment-week format override.
// Posts to /{page-id}/photos. Supports FB-native scheduling via scheduled_publish_time
// (post created with published=false; FB fires it at the requested unix timestamp).
//
// Secrets loaded from Doppler config ai-and-automation/prd (same pattern as run-daily.mjs):
//   FACEBOOK_SYSTEM_USER_TOKEN, FACEBOOK_PAGE_ID
//
// Usage:
//   node scripts/publish-photo.mjs \
//     --image-url https://example.com/hero.png \
//     --caption-file /path/to/caption.txt \
//     [--scheduled-publish-time 1782918000]   # unix seconds, 10min..6mo future
//     [--dry-run]
import { readFileSync } from "node:fs";

const GRAPH_VERSION = "v22.0";

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

async function loadDopplerSecrets() {
  const token = process.env.DOPPLER_TOKEN_EDGE;
  if (!token) throw new Error("DOPPLER_TOKEN_EDGE not present in environment");
  const auth = "Basic " + Buffer.from(`${token}:`).toString("base64");
  const res = await fetch(
    "https://api.doppler.com/v3/configs/config/secrets?project=ai-and-automation&config=prd",
    { headers: { Authorization: auth } },
  );
  if (!res.ok) throw new Error(`Doppler fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  return (name) => {
    const entry = body.secrets?.[name];
    if (!entry || entry.computed == null) throw new Error(`Missing Doppler secret: ${name}`);
    return entry.computed;
  };
}

async function mintPageToken(pageId, systemUserToken) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}?fields=access_token&access_token=${systemUserToken}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`page token lookup failed HTTP ${res.status}: ${await res.text()}`);
  const payload = await res.json();
  if (!payload.access_token) throw new Error("page token lookup response missing access_token");
  return payload.access_token;
}

async function postPhoto({ pageId, token, imageUrl, message, scheduledPublishTime }) {
  const form = new URLSearchParams();
  form.set("url", imageUrl);
  form.set("message", message);
  if (scheduledPublishTime) {
    form.set("published", "false");
    form.set("scheduled_publish_time", String(scheduledPublishTime));
  }
  form.set("access_token", token);
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/photos`,
    { method: "POST", body: form },
  );
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    throw new Error(`/photos publish failed HTTP ${res.status}: ${text}`);
  }
  return body;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const imageUrl = args["image-url"];
  const captionFile = args["caption-file"];
  const scheduledPublishTime = args["scheduled-publish-time"]
    ? Number(args["scheduled-publish-time"])
    : null;
  const dryRun = Boolean(args["dry-run"]);

  if (!imageUrl || !captionFile) {
    console.error("usage: node scripts/publish-photo.mjs --image-url <url> --caption-file <path> [--scheduled-publish-time <unix-sec>] [--dry-run]");
    process.exit(2);
  }

  const message = readFileSync(captionFile, "utf8").replace(/\s+$/, "");
  if (!message) throw new Error("caption file is empty");

  if (scheduledPublishTime) {
    const now = Math.floor(Date.now() / 1000);
    const delta = scheduledPublishTime - now;
    if (delta < 600) throw new Error(`scheduled_publish_time must be >=10min in future (delta=${delta}s)`);
    if (delta > 6 * 30 * 24 * 3600) throw new Error(`scheduled_publish_time must be <=6mo in future (delta=${delta}s)`);
  }

  const secret = await loadDopplerSecrets();
  const pageId = secret("FACEBOOK_PAGE_ID");
  const systemUserToken = secret("FACEBOOK_SYSTEM_USER_TOKEN");

  if (dryRun) {
    console.log(JSON.stringify({
      ok: true, dryRun: true, pageId, imageUrl,
      captionChars: message.length, captionFirstLine: message.split("\n")[0],
      scheduledPublishTime,
    }, null, 2));
    return;
  }

  const token = await mintPageToken(pageId, systemUserToken);
  const result = await postPhoto({ pageId, token, imageUrl, message, scheduledPublishTime });
  console.log(JSON.stringify({ ok: true, pageId, imageUrl, scheduledPublishTime, response: result }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
