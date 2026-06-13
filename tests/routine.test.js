import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FacebookPublisher,
  FacebookRoutine,
  PostgresPublicationStore,
  evaluateCandidate,
  normalizeUrl,
  writeRunResult,
} from "../src/index.js";

function buildCandidate(overrides = {}) {
  return {
    headline_candidate: "OpenAI ships new enterprise automation controls",
    thesis: "A major platform vendor changed workflow economics for operators.",
    why_it_matters: "It affects AI builders and operations teams.",
    primary_sources: ["https://example.com/source"],
    secondary_sources: ["https://example.com/report"],
    material_claims: ["The vendor launched controls.", "The launch is live today."],
    score_breakdown: {
      relevance: 18,
      real_world_impact: 17,
      novelty_timeliness: 13,
      evidence_quality: 18,
      facebook_fit: 8,
      conversation_potential: 8,
      asset_readiness: 4,
    },
    risk_flags: {
      rumor_risk: "low",
      legal_risk: "low",
      policy_risk: "medium",
      market_sensitivity: "medium",
    },
    real_image_options: ["https://example.com/image.jpg"],
    relevant_video_links: ["https://example.com/demo"],
    recommendation: "publish",
    article_url: "https://example.com/story/?utm_source=x&b=2",
    draft: `${"Paragraph one. ".repeat(610)}\nWhat changes would you make to your stack after this launch?`,
    fact_check_verdict: "verified",
    fact_check_sources: { "The vendor launched controls.": "https://example.com/source" },
    fallback_summary_verified: true,
    metadata: { requires_video_links: true, contains_rumor: false },
    ...overrides,
  };
}

class FakePublisher {
  constructor() {
    this.messages = [];
  }

  async publishPost(message) {
    this.messages.push(message);
    return "fb_123";
  }
}

class FakePublicationStore {
  constructor(existingUrls = []) {
    this.urls = new Set(existingUrls);
    this.claims = [];
    this.published = [];
    this.runLogs = [];
  }

  async loadPublishedUrls() {
    return new Set(this.urls);
  }

  async claimPublication(record) {
    this.claims.push(record);
    if (this.urls.has(record.normalizedUrl)) {
      return false;
    }
    this.urls.add(record.normalizedUrl);
    return true;
  }

  async markPublished(record) {
    this.published.push(record);
  }

  async logRun(payload) {
    this.runLogs.push(payload);
  }
}

test("normalizeUrl removes tracking params and normalizes casing", () => {
  assert.equal(normalizeUrl("https://EXAMPLE.com/story/?utm_source=x&b=2"), "https://example.com/story?b=2");
});

test("evaluateCandidate rejects banned dash punctuation", () => {
  const evaluation = evaluateCandidate(buildCandidate({ draft: `${"word ".repeat(610)}—\nWhat do you think?` }));
  assert.ok(evaluation.gateFailures.includes("draft uses banned dash punctuation"));
});

test("evaluateCandidate requires verified fallback summary when fetch fails", () => {
  const evaluation = evaluateCandidate(buildCandidate({ fallback_summary_verified: false }), { usedFallback: true });
  assert.ok(evaluation.gateFailures.includes("fallback summary not verified against primary sources"));
});

test("routine skips duplicate URL and publishes the best remaining story", async () => {
  const store = new FakePublicationStore(["https://example.com/already-published"]);
  const routine = new FacebookRoutine({
    publisher: new FakePublisher(),
    publicationStore: store,
    fetchArticle: async () => "ok",
  });

  const result = await routine.run([
    buildCandidate({ article_url: "https://example.com/already-published" }),
    buildCandidate({ article_url: "https://example.com/new-story", headline_candidate: "Fresh story" }),
  ]);

  assert.equal(result.status, "published");
  assert.deepEqual(result.duplicate_urls, ["https://example.com/already-published"]);
  assert.equal(result.selected_story.headline, "Fresh story");
  assert.deepEqual([...store.urls].sort(), ["https://example.com/already-published", "https://example.com/new-story"]);
  assert.equal(store.runLogs[0].status, "published");
});

test("routine returns no publishable story when fallback is not verified", async () => {
  const routine = new FacebookRoutine({
    publisher: new FakePublisher(),
    publicationStore: new FakePublicationStore(),
    fetchArticle: async () => {
      throw new Error("fetch timed out");
    },
  });

  const result = await routine.run([buildCandidate({ fallback_summary_verified: false })]);
  assert.equal(result.status, "no_publishable_story");
  assert.equal(result.rejected[0].used_fallback, true);
  assert.equal(result.evaluations[0].fetch_error, "fetch timed out");
});

test("routine falls through to the next story when a publishable candidate was claimed elsewhere", async () => {
  const store = new FakePublicationStore();
  store.urls.add("https://example.com/claimed-story");
  const routine = new FacebookRoutine({
    publisher: new FakePublisher(),
    publicationStore: store,
    fetchArticle: async () => "ok",
  });

  const result = await routine.run([
    buildCandidate({ article_url: "https://example.com/claimed-story", headline_candidate: "Claimed story" }),
    buildCandidate({ article_url: "https://example.com/fresh-story", headline_candidate: "Fresh story" }),
  ]);

  assert.equal(result.status, "published");
  assert.deepEqual(result.duplicate_urls, ["https://example.com/claimed-story"]);
  assert.equal(result.selected_story.headline, "Fresh story");
});

test("facebook publisher derives a page access token from a system user token", async () => {
  const requests = [];
  const publisher = new FacebookPublisher({
    pageId: "1097492980106238",
    systemUserToken: "system-user-token",
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, method: init.method || "GET" });
      if (String(url).includes("?fields=access_token")) {
        return {
          ok: true,
          async json() {
            return { access_token: "derived-page-token" };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { id: "fb_derived" };
        },
      };
    },
  });

  const postId = await publisher.publishPost("hello world");
  assert.equal(postId, "fb_derived");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[1].method, "POST");
});

test("writeRunResult persists structured JSON output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lens-fb-"));
  const outputPath = join(dir, "run.json");
  await writeRunResult(outputPath, { status: "published" });
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).status, "published");
});

test("postgres publication store validates table names and records SQL operations", async () => {
  const queries = [];
  const client = {
    async connect() {},
    async query(text, params) {
      queries.push({ text, params });
      if (text.includes("SELECT normalized_url")) {
        return { rows: [{ normalized_url: "https://example.com/already-published" }] };
      }
      return { rowCount: 1, rows: [] };
    },
    async end() {},
  };

  const store = new PostgresPublicationStore({
    connectionString: "postgres://example",
    publicationsTable: "public.facebook_publications",
    runsTable: "public.facebook_runs",
    clientFactory: () => client,
  });

  const urls = await store.loadPublishedUrls();
  assert.deepEqual([...urls], ["https://example.com/already-published"]);
  assert.equal(
    await store.claimPublication({
      normalizedUrl: "https://example.com/new-story",
      articleUrl: "https://example.com/new-story",
      headline: "Fresh story",
      score: 88,
      usedFallback: false,
      runId: "run-1",
      payload: { hello: "world" },
    }),
    true,
  );
  await store.markPublished({
    normalizedUrl: "https://example.com/new-story",
    facebookPostId: "fb_123",
    runId: "run-1",
    payload: { status: "published" },
  });
  await store.logRun({ run_id: "run-1", status: "published", selected_story: { normalized_url: "https://example.com/new-story" } });
  await store.close();

  assert.equal(queries.some(({ text }) => text.includes('CREATE TABLE IF NOT EXISTS "public"."facebook_publications"')), true);
  assert.equal(queries.some(({ text }) => text.includes('CREATE TABLE IF NOT EXISTS "public"."facebook_runs"')), true);
});

test("postgres publication store rejects unsafe table names", () => {
  assert.throws(
    () =>
      new PostgresPublicationStore({
        connectionString: "postgres://example",
        publicationsTable: "public.facebook_publications;DROP TABLE x",
        runsTable: "public.facebook_runs",
        clientFactory: () => ({
          async connect() {},
          async query() {
            return { rows: [], rowCount: 1 };
          },
          async end() {},
        }),
      }),
    /Invalid PostgreSQL table name/,
  );
});
