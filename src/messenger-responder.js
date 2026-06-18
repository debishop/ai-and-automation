import { Client } from "pg";

const VALID_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const GRAPH_VERSION = "v22.0";
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // Messenger standard RESPONSE window.

/**
 * Verbatim newsletter-conversion welcome reply for "The Lens" page.
 * Authored by the CTO on THEAAAAA-238 — DO NOT edit the wording. Any change to
 * the funnel copy must come back through the issue, not a code tweak.
 */
export const WELCOME_REPLY =
  "Thanks for reaching out to The Lens. Reply YES and we will add you to the weekly AI in Africa brief, delivered every week, straight here.";

function quoteTableName(name) {
  if (!VALID_TABLE_NAME.test(name)) {
    throw new Error(`Invalid PostgreSQL table name: ${name}`);
  }
  return name
    .split(".")
    .map((segment) => `"${segment}"`)
    .join(".");
}

/**
 * Reads Messenger conversations and sends the welcome reply via the Graph Send API.
 *
 * This is the API-first, poll-on-cron alternative to a `pages_messaging` webhook:
 * a webhook needs an always-on public HTTPS endpoint (net-new standing infra,
 * board-gated). Polling reuses the existing FB engagement cron — same host, same
 * token-resolution contract as FacebookCommentClient, no public ingress.
 */
export class FacebookMessengerClient {
  constructor({ pageId, accessToken = null, systemUserToken = null, timeoutMs = 15_000, fetchImpl = fetch }) {
    if (!pageId) throw new Error("FacebookMessengerClient requires a pageId");
    this.pageId = pageId;
    this.accessToken = accessToken;
    this.systemUserToken = systemUserToken;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.pageAccessToken = null;
  }

  async resolvePageAccessToken() {
    if (this.accessToken) return this.accessToken;
    if (this.pageAccessToken) return this.pageAccessToken;
    if (!this.systemUserToken) {
      throw new Error("FacebookMessengerClient requires either a page access token or system user token");
    }
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${this.pageId}?fields=access_token&access_token=${this.systemUserToken}`;
    const payload = await this.#get(url);
    if (!payload.access_token) throw new Error("Facebook page token lookup response missing access token");
    this.pageAccessToken = payload.access_token;
    return this.pageAccessToken;
  }

  async #get(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { method: "GET", signal: controller.signal });
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(`Graph GET failed HTTP ${res.status}: ${JSON.stringify(json.error || json)}`);
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Lists recent Messenger conversations with their most-recent messages inlined.
   * `messages` are returned newest-first by the Graph API.
   */
  async listConversations({ limit = 25, messageLimit = 10 } = {}) {
    const token = await this.resolvePageAccessToken();
    const fields = `participants,updated_time,messages.limit(${messageLimit}){id,created_time,from,message}`;
    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/${this.pageId}/conversations` +
      `?platform=messenger&fields=${encodeURIComponent(fields)}&limit=${limit}&access_token=${token}`;
    const json = await this.#get(url);
    return json.data || [];
  }

  /**
   * Sends a standard RESPONSE message to a user PSID via the page Send API.
   * Only valid inside the 24h messaging window; eligibility is enforced upstream.
   */
  async sendMessage(recipientPsid, text) {
    const token = await this.resolvePageAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = JSON.stringify({
        messaging_type: "RESPONSE",
        recipient: { id: recipientPsid },
        message: { text },
      });
      const res = await this.fetchImpl(
        `https://graph.facebook.com/${GRAPH_VERSION}/${this.pageId}/messages?access_token=${token}`,
        { method: "POST", headers: { "content-type": "application/json" }, body, signal: controller.signal },
      );
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(`Facebook Send API failed HTTP ${res.status}: ${JSON.stringify(json.error || json)}`);
      }
      if (!json.message_id) throw new Error("Facebook Send API response missing message_id");
      return json; // { recipient_id, message_id }
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Idempotent audit log for the Messenger welcome auto-reply.
 * One row per user PSID — a user is welcomed exactly once, ever. This is what
 * makes the reply fire only on the user's FIRST inbound contact, and what keeps
 * retries / overlapping cron firings from double-sending.
 */
export class PostgresMessengerReplyStore {
  constructor({ connectionString, table, timeoutMs = 10_000, clientFactory = (c) => new Client(c) }) {
    if (!connectionString) throw new Error("Messenger reply store requires a connection string");
    if (!table) throw new Error("Messenger reply store requires a table name");
    this.table = quoteTableName(table);
    this.client = clientFactory({
      connectionString,
      connectionTimeoutMillis: timeoutMs,
      statement_timeout: timeoutMs,
      query_timeout: timeoutMs,
    });
    this.connected = false;
    this.schemaReady = false;
  }

  async connect() {
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;
  }

  async ensureSchema() {
    if (this.schemaReady) return;
    await this.connect();
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        psid TEXT PRIMARY KEY,
        conversation_id TEXT,
        participant_name TEXT,
        first_inbound_time TIMESTAMPTZ,
        reply_text TEXT NOT NULL,
        message_id TEXT,
        outcome TEXT NOT NULL,
        run_id TEXT NOT NULL,
        replied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        payload JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    this.schemaReady = true;
  }

  async loadWelcomedPsids() {
    await this.ensureSchema();
    const result = await this.client.query(
      `SELECT psid FROM ${this.table} WHERE outcome IN ('claimed','replied')`,
    );
    return new Set(result.rows.map((r) => r.psid));
  }

  // Atomically claim a PSID so concurrent/duplicate runs cannot double-welcome.
  async claim({ psid, conversationId, participantName, firstInboundTime, replyText, runId }) {
    await this.ensureSchema();
    const result = await this.client.query(
      `
        INSERT INTO ${this.table}
          (psid, conversation_id, participant_name, first_inbound_time, reply_text, outcome, run_id)
        VALUES ($1,$2,$3,$4,$5,'claimed',$6)
        ON CONFLICT (psid) DO NOTHING
      `,
      [psid, conversationId, participantName, firstInboundTime, replyText, runId],
    );
    return result.rowCount === 1;
  }

  async markReplied({ psid, messageId, runId, payload }) {
    await this.ensureSchema();
    const result = await this.client.query(
      `
        UPDATE ${this.table}
        SET outcome='replied', message_id=$2, payload=$4::jsonb, replied_at=NOW()
        WHERE psid=$1 AND run_id=$3
      `,
      [psid, messageId, runId, JSON.stringify(payload || {})],
    );
    if (result.rowCount !== 1) throw new Error(`Welcome record missing for ${psid}`);
  }

  async markFailed({ psid, runId, reason }) {
    await this.ensureSchema();
    await this.client.query(
      `UPDATE ${this.table} SET outcome='failed', payload=jsonb_build_object('error',$3::text) WHERE psid=$1 AND run_id=$2`,
      [psid, runId, String(reason)],
    );
  }

  async close() {
    if (!this.connected) return;
    await this.client.end();
    this.connected = false;
  }
}

/**
 * Reduces raw conversations to the users we should welcome.
 *
 * A conversation is eligible when:
 *   - it has an inbound message (from someone other than the page) within the window, AND
 *   - the page has NOT already sent any message in that thread (welcome = first contact,
 *     so we never barge into a conversation a human/page already started), AND
 *   - that user PSID has not already been welcomed (idempotent).
 *
 * Returns one entry per eligible user: { conversationId, psid, name, firstInboundTime, message }.
 */
export function filterEligibleConversations({ conversations, pageId, welcomedPsids, now, windowMs = DEFAULT_WINDOW_MS }) {
  const eligible = [];
  for (const convo of conversations || []) {
    const messages = convo.messages?.data || [];
    if (messages.length === 0) continue;

    // Did the page ever speak in this thread? If so it's not a first-contact welcome.
    const pageHasReplied = messages.some((m) => m.from?.id && String(m.from.id) === String(pageId));
    if (pageHasReplied) continue;

    // Inbound messages only (not authored by the page).
    const inbound = messages.filter((m) => {
      const fromId = m.from?.id;
      return fromId && String(fromId) !== String(pageId);
    });
    if (inbound.length === 0) continue;

    // The user's most recent inbound message must be inside the messaging window.
    const newest = inbound.reduce((a, b) =>
      new Date(b.created_time).getTime() > new Date(a.created_time).getTime() ? b : a,
    );
    const newestTime = new Date(newest.created_time).getTime();
    if (!Number.isFinite(newestTime)) continue;
    if (now - newestTime > windowMs) continue; // outside 24h RESPONSE window — cannot send standard reply.

    const psid = String(newest.from.id);
    if (welcomedPsids.has(psid)) continue; // already welcomed this user.

    // The first inbound message in chronological order, for the audit record.
    const firstInbound = inbound.reduce((a, b) =>
      new Date(b.created_time).getTime() < new Date(a.created_time).getTime() ? b : a,
    );

    eligible.push({
      conversationId: convo.id,
      psid,
      name: newest.from?.name || null,
      firstInboundTime: firstInbound.created_time,
      message: newest.message || "",
    });
  }
  return eligible;
}
