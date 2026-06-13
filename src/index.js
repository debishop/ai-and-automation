import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Client } from "pg";

const REQUIRED_RISK_FLAGS = ["rumor_risk", "legal_risk", "policy_risk", "market_sensitivity"];
const SCORE_LIMITS = {
  relevance: 20,
  real_world_impact: 20,
  novelty_timeliness: 15,
  evidence_quality: 20,
  facebook_fit: 10,
  conversation_potential: 10,
  asset_readiness: 5,
};

const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const TRACKING_PARAMS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]);
const VALID_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

export function normalizeUrl(input) {
  const url = new URL(input);
  url.hash = "";
  url.protocol = (url.protocol || "https:").toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  const entries = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()));
  url.search = "";
  entries.sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of entries) {
    url.searchParams.append(key, value);
  }
  if (url.pathname !== "/") {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

export function containsBannedDash(text) {
  return text.includes("—") || text.includes("–");
}

export async function fetchText(url, { timeoutMs = 30_000, maxRetries = 2, fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      const retryable = error.name === "AbortError" || TRANSIENT_STATUS_CODES.has(error.status);
      if (!retryable || attempt === maxRetries) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export function evaluateCandidate(candidate, { usedFallback = false } = {}) {
  const failures = [];
  const normalizedUrl = normalizeUrl(candidate.article_url);
  const lastLine = candidate.draft.trim().split("\n").at(-1) || "";

  if (!candidate.primary_sources?.length) failures.push("missing primary source");
  if (candidate.fact_check_verdict !== "verified") failures.push("fact check not verified");
  if (candidate.draft.trim().split(/\s+/).length < 600) failures.push("draft under 600 words");
  if (containsBannedDash(candidate.draft)) failures.push("draft uses banned dash punctuation");
  if (!lastLine.includes("?")) failures.push("draft missing closing discussion prompt");
  if (candidate.metadata?.requires_video_links && !candidate.relevant_video_links?.length) failures.push("missing required video links");
  if (!candidate.real_image_options?.length) failures.push("missing real image path");
  if (candidate.metadata?.contains_rumor) failures.push("candidate relies on rumor");
  if (usedFallback && candidate.fallback_summary_verified !== true) failures.push("fallback summary not verified against primary sources");
  if (REQUIRED_RISK_FLAGS.some((flag) => !(flag in (candidate.risk_flags || {})))) failures.push("risk flags incomplete");

  const scoreKeys = Object.keys(SCORE_LIMITS);
  if (scoreKeys.some((key) => !(key in (candidate.score_breakdown || {})))) failures.push("score breakdown incomplete");

  let score = 0;
  if (failures.length === 0) {
    for (const [key, limit] of Object.entries(SCORE_LIMITS)) {
      const value = candidate.score_breakdown[key];
      if (!Number.isInteger(value) || value < 0 || value > limit) {
        failures.push(`invalid score for ${key}`);
        break;
      }
      score += value;
    }
    if (failures.length === 0 && score < 70) failures.push("score below publish threshold");
  }

  return {
    candidate,
    normalizedUrl,
    score,
    gateFailures: failures,
    usedFallback,
    publishable: failures.length === 0,
  };
}

function quoteTableName(name) {
  if (!VALID_TABLE_NAME.test(name)) {
    throw new Error(`Invalid PostgreSQL table name: ${name}`);
  }
  return name
    .split(".")
    .map((segment) => `"${segment}"`)
    .join(".");
}

export class PostgresPublicationStore {
  constructor({
    connectionString,
    publicationsTable,
    runsTable,
    timeoutMs = 10_000,
    clientFactory = (config) => new Client(config),
  }) {
    if (!connectionString) {
      throw new Error("Postgres publication store requires a connection string");
    }
    if (!publicationsTable || !runsTable) {
      throw new Error("Postgres publication store requires publicationsTable and runsTable");
    }

    this.timeoutMs = timeoutMs;
    this.publicationsTable = quoteTableName(publicationsTable);
    this.runsTable = quoteTableName(runsTable);
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
      CREATE TABLE IF NOT EXISTS ${this.publicationsTable} (
        normalized_url TEXT PRIMARY KEY,
        article_url TEXT NOT NULL,
        headline TEXT NOT NULL,
        score INTEGER NOT NULL,
        used_fallback BOOLEAN NOT NULL,
        claim_run_id TEXT NOT NULL,
        claim_status TEXT NOT NULL,
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ,
        facebook_post_id TEXT UNIQUE,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS ${this.runsTable} (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        selected_normalized_url TEXT,
        facebook_post_id TEXT,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    this.schemaReady = true;
  }

  async loadPublishedUrls() {
    await this.ensureSchema();
    const result = await this.client.query(
      `SELECT normalized_url FROM ${this.publicationsTable} WHERE claim_status IN ('claimed', 'published')`,
    );
    return new Set(result.rows.map((row) => row.normalized_url));
  }

  async claimPublication({ normalizedUrl, articleUrl, headline, score, usedFallback, runId, payload }) {
    await this.ensureSchema();
    const result = await this.client.query(
      `
        INSERT INTO ${this.publicationsTable} (
          normalized_url,
          article_url,
          headline,
          score,
          used_fallback,
          claim_run_id,
          claim_status,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'claimed', $7::jsonb)
        ON CONFLICT (normalized_url) DO NOTHING
      `,
      [normalizedUrl, articleUrl, headline, score, usedFallback, runId, JSON.stringify(payload)],
    );
    return result.rowCount === 1;
  }

  async markPublished({ normalizedUrl, facebookPostId, runId, payload }) {
    await this.ensureSchema();
    const result = await this.client.query(
      `
        UPDATE ${this.publicationsTable}
        SET claim_status = 'published',
            facebook_post_id = $2,
            payload = $4::jsonb,
            published_at = NOW()
        WHERE normalized_url = $1
          AND claim_run_id = $3
      `,
      [normalizedUrl, facebookPostId, runId, JSON.stringify(payload)],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Postgres publication record missing for ${normalizedUrl}`);
    }
  }

  async logRun(resultPayload) {
    await this.ensureSchema();
    await this.client.query(
      `
        INSERT INTO ${this.runsTable} (
          run_id,
          status,
          selected_normalized_url,
          facebook_post_id,
          payload
        )
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [
        resultPayload.run_id,
        resultPayload.status,
        resultPayload.selected_story?.normalized_url || null,
        resultPayload.selected_story?.facebook_post_id || null,
        JSON.stringify(resultPayload),
      ],
    );
  }

  async close() {
    if (!this.connected) return;
    await this.client.end();
    this.connected = false;
  }
}

export class FacebookPublisher {
  constructor({ pageId, accessToken = null, systemUserToken = null, timeoutMs = 10_000, fetchImpl = fetch }) {
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
      throw new Error("Facebook publisher requires either a page access token or system user token");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `https://graph.facebook.com/v22.0/${this.pageId}?fields=access_token&access_token=${this.systemUserToken}`,
        {
          method: "GET",
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`Facebook page token lookup failed with HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (!payload.access_token) {
        throw new Error("Facebook page token lookup response missing access token");
      }
      this.pageAccessToken = payload.access_token;
      return this.pageAccessToken;
    } finally {
      clearTimeout(timer);
    }
  }

  async publishPost(message) {
    const accessToken = await this.resolvePageAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = new URLSearchParams({ message, access_token: accessToken });
      const response = await this.fetchImpl(`https://graph.facebook.com/v22.0/${this.pageId}/feed`, {
        method: "POST",
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Facebook publish failed with HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (!payload.id) {
        throw new Error("Facebook publish response missing post id");
      }
      return payload.id;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class FacebookRoutine {
  constructor({ publisher, publicationStore, fetchArticle = fetchText }) {
    this.publisher = publisher;
    this.publicationStore = publicationStore;
    this.fetchArticle = fetchArticle;
  }

  async run(candidatePayloads) {
    const runId = randomUUID();
    const existingUrls = await this.publicationStore.loadPublishedUrls();
    const evaluations = [];
    const duplicateUrls = [];

    for (const candidate of candidatePayloads) {
      let usedFallback = false;
      const metadata = { ...(candidate.metadata || {}) };
      try {
        await this.fetchArticle(candidate.article_url);
      } catch (error) {
        metadata.fetch_error = String(error.message || error);
        usedFallback = true;
      }
      const evaluation = evaluateCandidate({ ...candidate, metadata }, { usedFallback });
      if (existingUrls.has(evaluation.normalizedUrl)) {
        duplicateUrls.push(evaluation.normalizedUrl);
        continue;
      }
      evaluations.push(evaluation);
    }

    const publishable = evaluations
      .filter((evaluation) => evaluation.publishable)
      .sort((left, right) =>
        right.score - left.score ||
        right.candidate.score_breakdown.evidence_quality - left.candidate.score_breakdown.evidence_quality ||
        right.candidate.score_breakdown.real_world_impact - left.candidate.score_breakdown.real_world_impact ||
        right.candidate.score_breakdown.conversation_potential - left.candidate.score_breakdown.conversation_potential ||
        right.candidate.score_breakdown.asset_readiness - left.candidate.score_breakdown.asset_readiness,
      );

    const result = {
      run_id: runId,
      duplicate_urls: duplicateUrls,
      evaluations: evaluations.map((evaluation) => ({
        headline: evaluation.candidate.headline_candidate,
        normalized_url: evaluation.normalizedUrl,
        score: evaluation.score,
        score_breakdown: evaluation.candidate.score_breakdown,
        gate_failures: evaluation.gateFailures,
        used_fallback: evaluation.usedFallback,
        fetch_error: evaluation.candidate.metadata?.fetch_error || null,
      })),
      rejected: evaluations
        .filter((evaluation) => !evaluation.publishable)
        .map((evaluation) => ({
          headline: evaluation.candidate.headline_candidate,
          normalized_url: evaluation.normalizedUrl,
          gate_failures: evaluation.gateFailures,
          used_fallback: evaluation.usedFallback,
        })),
    };

    if (publishable.length === 0) {
      const finalResult = { ...result, status: "no_publishable_story" };
      await this.publicationStore.logRun(finalResult);
      return finalResult;
    }

    for (const winner of publishable) {
      const claimed = await this.publicationStore.claimPublication({
        normalizedUrl: winner.normalizedUrl,
        articleUrl: winner.candidate.article_url,
        headline: winner.candidate.headline_candidate,
        score: winner.score,
        usedFallback: winner.usedFallback,
        runId,
        payload: {
          primary_sources: winner.candidate.primary_sources,
          score_breakdown: winner.candidate.score_breakdown,
          why_it_matters: winner.candidate.why_it_matters,
        },
      });

      if (!claimed) {
        duplicateUrls.push(winner.normalizedUrl);
        continue;
      }

      const facebookPostId = await this.publisher.publishPost(winner.candidate.draft);
      const publicationRecord = {
        normalized_url: winner.normalizedUrl,
        article_url: winner.candidate.article_url,
        headline: winner.candidate.headline_candidate,
        facebook_post_id: facebookPostId,
        score: winner.score,
        run_id: runId,
        used_fallback: winner.usedFallback,
      };
      await this.publicationStore.markPublished({
        normalizedUrl: winner.normalizedUrl,
        facebookPostId,
        runId,
        payload: publicationRecord,
      });

      const finalResult = {
        ...result,
        duplicate_urls: duplicateUrls,
        status: "published",
        selected_story: {
          headline: winner.candidate.headline_candidate,
          normalized_url: winner.normalizedUrl,
          score: winner.score,
          used_fallback: winner.usedFallback,
          facebook_post_id: facebookPostId,
        },
        publication_record: publicationRecord,
      };
      await this.publicationStore.logRun(finalResult);
      return finalResult;
    }

    const finalResult = { ...result, duplicate_urls: duplicateUrls, status: "no_publishable_story" };
    await this.publicationStore.logRun(finalResult);
    return finalResult;
  }
}

export async function writeRunResult(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
