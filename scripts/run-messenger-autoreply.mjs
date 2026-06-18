// Messenger welcome auto-reply runner for The Lens (Facebook only). THEAAAAA-238.
//
// API-first, poll-on-cron implementation of the "first inbound message" newsletter
// funnel. A pages_messaging WEBHOOK would need an always-on public HTTPS endpoint
// (net-new standing infra, board-gated). This reuses the existing FB engagement
// cron host instead: poll conversations -> filter first-contact users in the 24h
// window -> send the verbatim welcome via the Send API -> log idempotently in PG.
// No public ingress, no standing infra.
//
// Pulls production secrets from Doppler (ai-and-automation/prd) at runtime via the
// injected DOPPLER_TOKEN_EDGE service token. Never prints secret values.
//
// Phases:
//   node scripts/run-messenger-autoreply.mjs --list <out.json>
//       -> writes eligible users (first inbound, <24h, not yet welcomed); sends nothing.
//
//   node scripts/run-messenger-autoreply.mjs --send [--log <out.json>]
//       -> claims each eligible PSID (idempotent), sends the verbatim WELCOME_REPLY
//          via the Send API, logs to facebook_messenger_autoreplies.
//
//   node scripts/run-messenger-autoreply.mjs --dry-run [--log <out.json>]
//       -> same selection as --send but performs NO Graph writes (safe rehearsal).
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  FacebookMessengerClient,
  PostgresMessengerReplyStore,
  filterEligibleConversations,
  WELCOME_REPLY,
} from "../src/messenger-responder.js";

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
    repliesTable: process.env.FACEBOOK_MESSENGER_AUTOREPLIES_TABLE || "public.facebook_messenger_autoreplies",
  };
}

async function writeJson(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function gatherEligible({ client, store, pageId }) {
  const welcomedPsids = await store.loadWelcomedPsids();
  const now = Date.now();
  const conversations = await client.listConversations({ limit: 25, messageLimit: 10 });
  return filterEligibleConversations({ conversations, pageId, welcomedPsids, now });
}

const mode = process.argv.includes("--list")
  ? "list"
  : process.argv.includes("--send")
    ? "send"
    : process.argv.includes("--dry-run")
      ? "dry-run"
      : null;
if (!mode) throw new Error("usage: --list <out.json> | --send [--log <out.json>] | --dry-run [--log <out.json>]");

const secrets = await loadSecrets();
const client = new FacebookMessengerClient({ pageId: secrets.pageId, systemUserToken: secrets.systemUserToken });
const store = new PostgresMessengerReplyStore({ connectionString: secrets.databaseUrl, table: secrets.repliesTable });

try {
  if (mode === "list") {
    const out = arg("--list");
    const eligible = await gatherEligible({ client, store, pageId: secrets.pageId });
    await writeJson(out, { generated_run_id: randomUUID(), count: eligible.length, eligible });
    console.log(JSON.stringify({ phase: "list", eligible_count: eligible.length, out }, null, 2));
  } else {
    const dryRun = mode === "dry-run";
    const runId = randomUUID();
    const logPath = arg("--log");
    const eligible = await gatherEligible({ client, store, pageId: secrets.pageId });
    const results = [];
    for (const u of eligible) {
      if (dryRun) {
        results.push({ psid: u.psid, conversation_id: u.conversationId, outcome: "would_send" });
        continue;
      }
      const claimed = await store.claim({
        psid: u.psid,
        conversationId: u.conversationId,
        participantName: u.name,
        firstInboundTime: u.firstInboundTime,
        replyText: WELCOME_REPLY,
        runId,
      });
      if (!claimed) {
        results.push({ psid: u.psid, outcome: "already_welcomed" });
        continue;
      }
      try {
        const sent = await client.sendMessage(u.psid, WELCOME_REPLY);
        await store.markReplied({ psid: u.psid, messageId: sent.message_id, runId, payload: { send: sent } });
        results.push({ psid: u.psid, outcome: "welcomed", message_id: sent.message_id });
      } catch (err) {
        await store.markFailed({ psid: u.psid, runId, reason: err.message });
        results.push({ psid: u.psid, outcome: "failed", error: err.message });
      }
    }
    const summary = { run_id: runId, phase: mode, eligible_count: eligible.length, results };
    if (logPath) await writeJson(logPath, summary);
    console.log(JSON.stringify(summary, null, 2));
  }
} finally {
  await store.close();
}
