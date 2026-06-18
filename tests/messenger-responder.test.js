import test from "node:test";
import assert from "node:assert/strict";

import {
  FacebookMessengerClient,
  filterEligibleConversations,
  WELCOME_REPLY,
} from "../src/messenger-responder.js";

const PAGE_ID = "1097492980106238";
const HOUR = 60 * 60 * 1000;

function convo(id, messages) {
  return { id, messages: { data: messages } };
}
function msg(fromId, name, createdMsAgo, now, text = "hi") {
  return { id: `m_${fromId}_${createdMsAgo}`, from: { id: fromId, name }, created_time: new Date(now - createdMsAgo).toISOString(), message: text };
}

// --- Verbatim copy is locked ---

test("WELCOME_REPLY is the exact CTO-approved funnel copy", () => {
  assert.equal(
    WELCOME_REPLY,
    "Thanks for reaching out to The Lens. Reply YES and we will add you to the weekly AI in Africa brief, delivered every week, straight here.",
  );
});

// --- Eligibility: first inbound, in-window, not yet welcomed ---

test("eligible: a fresh inbound first-contact message is selected", () => {
  const now = Date.now();
  const conversations = [convo("t1", [msg("9999", "Reader", 1 * HOUR, now, "hello")])];
  const eligible = filterEligibleConversations({ conversations, pageId: PAGE_ID, welcomedPsids: new Set(), now });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].psid, "9999");
  assert.equal(eligible[0].name, "Reader");
});

test("skips conversations the page already replied in (not first contact)", () => {
  const now = Date.now();
  const conversations = [
    convo("t1", [msg(PAGE_ID, "The Lens", 0.5 * HOUR, now, "earlier"), msg("9999", "Reader", 1 * HOUR, now, "hello")]),
  ];
  const eligible = filterEligibleConversations({ conversations, pageId: PAGE_ID, welcomedPsids: new Set(), now });
  assert.equal(eligible.length, 0);
});

test("skips users already welcomed (idempotent across runs)", () => {
  const now = Date.now();
  const conversations = [convo("t1", [msg("9999", "Reader", 1 * HOUR, now)])];
  const eligible = filterEligibleConversations({ conversations, pageId: PAGE_ID, welcomedPsids: new Set(["9999"]), now });
  assert.equal(eligible.length, 0);
});

test("skips messages outside the 24h messaging window", () => {
  const now = Date.now();
  const conversations = [convo("t1", [msg("9999", "Reader", 30 * HOUR, now)])];
  const eligible = filterEligibleConversations({ conversations, pageId: PAGE_ID, welcomedPsids: new Set(), now });
  assert.equal(eligible.length, 0);
});

test("ignores conversations with no inbound message and bad timestamps", () => {
  const now = Date.now();
  const conversations = [
    convo("empty", []),
    convo("page-only", [msg(PAGE_ID, "The Lens", 1 * HOUR, now)]),
  ];
  const eligible = filterEligibleConversations({ conversations, pageId: PAGE_ID, welcomedPsids: new Set(), now });
  assert.equal(eligible.length, 0);
});

test("first_inbound_time is the chronologically earliest inbound message", () => {
  const now = Date.now();
  const first = msg("9999", "Reader", 3 * HOUR, now, "first");
  const later = msg("9999", "Reader", 1 * HOUR, now, "second");
  const conversations = [convo("t1", [later, first])]; // Graph returns newest-first
  const eligible = filterEligibleConversations({ conversations, pageId: PAGE_ID, welcomedPsids: new Set(), now });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].firstInboundTime, first.created_time);
  assert.equal(eligible[0].message, "second"); // context = newest inbound
});

// --- Send API: payload shape + timeout-safety contract ---

test("sendMessage posts a RESPONSE-typed Send API payload and returns ids", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ recipient_id: "9999", message_id: "mid.123" }) };
  };
  const client = new FacebookMessengerClient({ pageId: PAGE_ID, accessToken: "PAGE_TOKEN", fetchImpl });
  const out = await client.sendMessage("9999", WELCOME_REPLY);
  assert.equal(out.message_id, "mid.123");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, new RegExp(`/${PAGE_ID}/messages`));
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.messaging_type, "RESPONSE");
  assert.deepEqual(body.recipient, { id: "9999" });
  assert.equal(body.message.text, WELCOME_REPLY);
  assert.ok(calls[0].opts.signal, "send must pass an abort signal (timeout safety)");
});

test("sendMessage throws on Graph error responses", async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "outside window" } }) });
  const client = new FacebookMessengerClient({ pageId: PAGE_ID, accessToken: "PAGE_TOKEN", fetchImpl });
  await assert.rejects(() => client.sendMessage("9999", WELCOME_REPLY), /Send API failed HTTP 400/);
});

test("listConversations requests inlined messages with from/created_time and an abort signal", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };
  const client = new FacebookMessengerClient({ pageId: PAGE_ID, accessToken: "PAGE_TOKEN", fetchImpl });
  await client.listConversations();
  assert.match(calls[0].url, /\/conversations\?platform=messenger/);
  assert.match(decodeURIComponent(calls[0].url), /messages\.limit\(\d+\)\{id,created_time,from,message\}/);
  assert.ok(calls[0].opts.signal);
});
