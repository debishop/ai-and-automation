import { Client } from "pg";

const VALID_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const GRAPH_VERSION = "v22.0";
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

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
 * Reads recent posts + comments and posts replies via the Graph API.
 * Reuses the same page-token resolution contract as FacebookPublisher
 * (system-user token -> page-scoped token, or an explicit page token override).
 */
export class FacebookCommentClient {
  constructor({ pageId, accessToken = null, systemUserToken = null, timeoutMs = 15_000, fetchImpl = fetch }) {
    if (!pageId) throw new Error("FacebookCommentClient requires a pageId");
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
      throw new Error("FacebookCommentClient requires either a page access token or system user token");
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

  async listRecentPosts({ limit = 10 } = {}) {
    const token = await this.resolvePageAccessToken();
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${this.pageId}/posts?fields=id,created_time,message&limit=${limit}&access_token=${token}`;
    const json = await this.#get(url);
    return json.data || [];
  }

  async listComments(postId, { limit = 50 } = {}) {
    const token = await this.resolvePageAccessToken();
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${postId}/comments?fields=id,created_time,message,from&order=reverse_chronological&limit=${limit}&access_token=${token}`;
    const json = await this.#get(url);
    return json.data || [];
  }

  async readComment(commentId) {
    const token = await this.resolvePageAccessToken();
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${commentId}?fields=id,created_time,message,from&access_token=${token}`;
    return this.#get(url);
  }

  async replyToComment(commentId, message) {
    const token = await this.resolvePageAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = new URLSearchParams({ message, access_token: token });
      const res = await this.fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${commentId}/comments`, {
        method: "POST",
        body,
        signal: controller.signal,
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(`Facebook reply failed HTTP ${res.status}: ${JSON.stringify(json.error || json)}`);
      }
      if (!json.id) throw new Error("Facebook reply response missing id");
      return json.id;
    } finally {
      clearTimeout(timer);
    }
  }

  // Used only for QA cleanup of seeded test artifacts.
  async deleteObject(objectId) {
    const token = await this.resolvePageAccessToken();
    const res = await this.fetchImpl(
      `https://graph.facebook.com/${GRAPH_VERSION}/${objectId}?access_token=${token}`,
      { method: "DELETE" },
    );
    const json = await res.json();
    if (!res.ok || json.error) {
      throw new Error(`Facebook delete failed HTTP ${res.status}: ${JSON.stringify(json.error || json)}`);
    }
    return json.success === true || json.success === undefined;
  }

  // Used only to seed a QA test comment during smoke runs.
  async createComment(postId, message) {
    const token = await this.resolvePageAccessToken();
    const body = new URLSearchParams({ message, access_token: token });
    const res = await this.fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${postId}/comments`, {
      method: "POST",
      body,
    });
    const json = await res.json();
    if (!res.ok || json.error) {
      throw new Error(`Facebook seed comment failed HTTP ${res.status}: ${JSON.stringify(json.error || json)}`);
    }
    return json.id;
  }
}

/**
 * Idempotent audit log for comment replies.
 * One row per source comment id; a comment is never replied to twice.
 */
export class PostgresCommentReplyStore {
  constructor({ connectionString, table, timeoutMs = 10_000, clientFactory = (c) => new Client(c) }) {
    if (!connectionString) throw new Error("Comment reply store requires a connection string");
    if (!table) throw new Error("Comment reply store requires a table name");
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
        comment_id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        comment_text TEXT,
        comment_author TEXT,
        comment_created_time TIMESTAMPTZ,
        reply_text TEXT NOT NULL,
        reply_id TEXT,
        outcome TEXT NOT NULL,
        run_id TEXT NOT NULL,
        replied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        payload JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    this.schemaReady = true;
  }

  async loadRepliedCommentIds() {
    await this.ensureSchema();
    const result = await this.client.query(
      `SELECT comment_id FROM ${this.table} WHERE outcome IN ('claimed','replied')`,
    );
    return new Set(result.rows.map((r) => r.comment_id));
  }

  // Atomically claim a comment id so concurrent/duplicate runs cannot double-reply.
  async claim({ commentId, postId, commentText, commentAuthor, commentCreatedTime, replyText, runId }) {
    await this.ensureSchema();
    const result = await this.client.query(
      `
        INSERT INTO ${this.table}
          (comment_id, post_id, comment_text, comment_author, comment_created_time, reply_text, outcome, run_id)
        VALUES ($1,$2,$3,$4,$5,$6,'claimed',$7)
        ON CONFLICT (comment_id) DO NOTHING
      `,
      [commentId, postId, commentText, commentAuthor, commentCreatedTime, replyText, runId],
    );
    return result.rowCount === 1;
  }

  async markReplied({ commentId, replyId, runId, payload }) {
    await this.ensureSchema();
    const result = await this.client.query(
      `
        UPDATE ${this.table}
        SET outcome='replied', reply_id=$2, payload=$4::jsonb, replied_at=NOW()
        WHERE comment_id=$1 AND run_id=$3
      `,
      [commentId, replyId, runId, JSON.stringify(payload || {})],
    );
    if (result.rowCount !== 1) throw new Error(`Reply record missing for ${commentId}`);
  }

  async markFailed({ commentId, runId, reason }) {
    await this.ensureSchema();
    await this.client.query(
      `UPDATE ${this.table} SET outcome='failed', payload=jsonb_build_object('error',$3::text) WHERE comment_id=$1 AND run_id=$2`,
      [commentId, runId, String(reason)],
    );
  }

  async close() {
    if (!this.connected) return;
    await this.client.end();
    this.connected = false;
  }
}

/**
 * Returns eligible comments: created within the window, authored by someone
 * other than the page itself, and not already replied to.
 */
export function filterEligibleComments({ comments, pageId, repliedIds, now, windowMs = DEFAULT_WINDOW_MS }) {
  return comments.filter((c) => {
    const fromId = c.from?.id;
    if (fromId && String(fromId) === String(pageId)) return false; // never reply to ourselves
    if (repliedIds.has(c.id)) return false; // idempotent
    const created = new Date(c.created_time).getTime();
    if (!Number.isFinite(created)) return false;
    if (now - created > windowMs) return false; // last 24h only
    return true;
  });
}
