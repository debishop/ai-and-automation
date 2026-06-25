// FB carousel publish — THEAAAAA-602 experiment-week format override.
// Uploads N photos with published=false, then creates /{page-id}/feed post with
// attached_media[]={media_fbid}. Supports FB-native scheduling.
//
// Secrets via Doppler ai-and-automation/prd: FACEBOOK_SYSTEM_USER_TOKEN, FACEBOOK_PAGE_ID
//
// Usage:
//   node scripts/publish-carousel.mjs \
//     --image /path/frame1.png --image /path/frame2.png ... \
//     --caption-file /path/caption.txt \
//     [--scheduled-publish-time 1782655200] \
//     [--dry-run]
import { readFileSync, statSync, openAsBlob } from "node:fs";
import { basename } from "node:path";

const GRAPH_VERSION = "v22.0";

function parseArgs(argv) {
  const out = { image: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const val = next && !next.startsWith("--") ? argv[(i += 1)] : true;
    if (key === "image") out.image.push(val);
    else out[key] = val;
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

async function uploadUnpublishedPhoto({ pageId, token, filePath }) {
  const form = new FormData();
  form.set("published", "false");
  form.set("temporary", "true");
  form.set("access_token", token);
  const blob = await openAsBlob(filePath);
  form.set("source", blob, basename(filePath));
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/photos`,
    { method: "POST", body: form },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`photo upload failed (${filePath}) HTTP ${res.status}: ${text}`);
  const body = JSON.parse(text);
  if (!body.id) throw new Error(`photo upload missing id: ${text}`);
  return body.id;
}

async function createCarouselPost({ pageId, token, message, mediaIds, scheduledPublishTime }) {
  const form = new URLSearchParams();
  form.set("message", message);
  mediaIds.forEach((id, i) => {
    form.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: id }));
  });
  if (scheduledPublishTime) {
    form.set("published", "false");
    form.set("scheduled_publish_time", String(scheduledPublishTime));
  }
  form.set("access_token", token);
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/feed`,
    { method: "POST", body: form },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`/feed publish failed HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const images = args.image;
  const captionFile = args["caption-file"];
  const scheduledPublishTime = args["scheduled-publish-time"]
    ? Number(args["scheduled-publish-time"]) : null;
  const dryRun = Boolean(args["dry-run"]);

  if (!images.length || !captionFile) {
    console.error("usage: publish-carousel.mjs --image <p> [--image <p> ...] --caption-file <p> [--scheduled-publish-time <unix>] [--dry-run]");
    process.exit(2);
  }
  if (images.length < 2 || images.length > 10) {
    throw new Error(`carousel needs 2..10 images, got ${images.length}`);
  }
  for (const p of images) {
    const s = statSync(p);
    if (!s.isFile()) throw new Error(`not a file: ${p}`);
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
      ok: true, dryRun: true, pageId, images, captionChars: message.length,
      captionFirstLine: message.split("\n")[0], scheduledPublishTime,
    }, null, 2));
    return;
  }

  const token = await mintPageToken(pageId, systemUserToken);
  const mediaIds = [];
  for (const p of images) {
    const id = await uploadUnpublishedPhoto({ pageId, token, filePath: p });
    mediaIds.push(id);
    console.error(`uploaded ${basename(p)} -> ${id}`);
  }
  const result = await createCarouselPost({
    pageId, token, message, mediaIds, scheduledPublishTime,
  });
  console.log(JSON.stringify({
    ok: true, pageId, mediaIds, scheduledPublishTime,
    postId: result.id, response: result,
  }, null, 2));
}

main().catch((err) => { console.error(err.message); process.exit(1); });
