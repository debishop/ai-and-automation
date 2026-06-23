import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePageToken,
  composeMessage,
  validateImage,
  inferContentType,
  permalinkFor,
  acquireGuards,
  confirmNotPublished,
  publishPhoto,
  publishRun,
  PublishError,
  MAX_RETRIES,
  REQUIRED_WIDTH,
  REQUIRED_HEIGHT,
} from "../src/vep/publish-post.mjs";

// ------- token chain -------

test("resolvePageToken: page env wins", async () => {
  const r = await resolvePageToken({
    env: {
      FACEBOOK_PAGE_ACCESS_TOKEN: "PT",
      FACEBOOK_SYSTEM_USER_TOKEN: "SU",
      PAPERCLIP_API_KEY_THELENSAIAND: "PK",
    },
  });
  assert.deepEqual(r, { token: "PT", source: "page_env" });
});

test("resolvePageToken: mints from system user token", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      async json() {
        return { access_token: "MINTED" };
      },
    };
  };
  const r = await resolvePageToken({
    env: { FACEBOOK_SYSTEM_USER_TOKEN: "SU" },
    fetchImpl,
  });
  assert.equal(r.token, "MINTED");
  assert.equal(r.source, "system_user");
  assert.ok(calls[0].includes("access_token=SU"));
  assert.ok(calls[0].includes("/1097492980106238?"));
});

test("resolvePageToken: falls back to paperclip page key", async () => {
  const r = await resolvePageToken({
    env: { PAPERCLIP_API_KEY_THELENSAIAND: "PK" },
  });
  assert.equal(r.source, "paperclip_page_key");
});

test("resolvePageToken: throws when nothing available", async () => {
  await assert.rejects(() => resolvePageToken({ env: {} }), /no Facebook token/);
});

test("resolvePageToken: mint HTTP error is non-retryable", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, async json() { return {}; } });
  await assert.rejects(
    () => resolvePageToken({ env: { FACEBOOK_SYSTEM_USER_TOKEN: "x" }, fetchImpl }),
    (err) => err instanceof PublishError && err.retryable === false && err.stage === "auth",
  );
});

// ------- composition / validation -------

test("composeMessage joins caption + hashtags + mentions", () => {
  const msg = composeMessage({
    caption: "Hello world.",
    coreHashtags: ["#AI", "#TheLens"],
    topicHashtags: ["#LLM"],
    audienceMentions: ["@founders"],
  });
  assert.equal(msg, "Hello world.\n\n#AI #TheLens #LLM @founders");
});

test("composeMessage: caption-only when no tags", () => {
  assert.equal(composeMessage({ caption: "x" }), "x");
});

test("validateImage: exactly 1080x1350 png/jpg required", () => {
  assert.equal(validateImage({ width: REQUIRED_WIDTH, height: REQUIRED_HEIGHT, contentType: "image/png" }).ok, true);
  assert.equal(validateImage({ width: REQUIRED_WIDTH, height: REQUIRED_HEIGHT, contentType: "image/jpeg" }).ok, true);
  assert.equal(validateImage({ width: 1080, height: 1080, contentType: "image/png" }).ok, false);
  assert.equal(validateImage({ width: 1080, height: 1350, contentType: "image/gif" }).ok, false);
});

test("inferContentType from extension", () => {
  assert.equal(inferContentType("https://s3/foo.png"), "image/png");
  assert.equal(inferContentType("https://s3/foo.JPG?x=1"), "image/jpeg");
  assert.equal(inferContentType("https://s3/foo.webp"), "");
});

test("permalinkFor handles {page}_{post}", () => {
  assert.equal(
    permalinkFor("1097492980106238_999"),
    "https://www.facebook.com/1097492980106238/posts/999",
  );
});

// ------- pg guard helpers -------

function fakeClient(queryLog) {
  return {
    queries: queryLog,
    handlers: [],
    on(matcher, handler) {
      this.handlers.push({ matcher, handler });
      return this;
    },
    async query(text, params) {
      queryLog.push({ text, params });
      for (const h of this.handlers) {
        if (typeof h.matcher === "function" ? h.matcher(text, params) : text.includes(h.matcher)) {
          return h.handler(text, params);
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test("acquireGuards: lock busy → not acquired", async () => {
  const log = [];
  const client = fakeClient(log).on("pg_try_advisory_xact_lock", () => ({
    rows: [{ got: false }],
    rowCount: 1,
  }));
  const r = await acquireGuards(client, { topicHash: "t" });
  assert.deepEqual(r, { acquired: false, reason: "advisory_lock_busy" });
});

test("acquireGuards: lock acquired, duplicate today → not acquired", async () => {
  const log = [];
  const client = fakeClient(log)
    .on("pg_try_advisory_xact_lock", () => ({ rows: [{ got: true }], rowCount: 1 }))
    .on("FROM vep_runs", () => ({
      rows: [{ run_id: "old", fb_post_id: "PID", fb_post_url: "URL" }],
      rowCount: 1,
    }));
  const r = await acquireGuards(client, { topicHash: "t" });
  assert.equal(r.acquired, false);
  assert.equal(r.reason, "duplicate_today");
  assert.equal(r.existing.fb_post_id, "PID");
});

test("acquireGuards: clean path acquires", async () => {
  const client = fakeClient([])
    .on("pg_try_advisory_xact_lock", () => ({ rows: [{ got: true }], rowCount: 1 }))
    .on("FROM vep_runs", () => ({ rows: [], rowCount: 0 }));
  const r = await acquireGuards(client, { topicHash: "t" });
  assert.deepEqual(r, { acquired: true });
});

test("acquireGuards: missing topicHash throws", async () => {
  await assert.rejects(() => acquireGuards(fakeClient([]), {}), /topicHash required/);
});

// ------- confirmation query -------

test("confirmNotPublished: no match → confirmed", async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() { return { data: [{ id: "1", message: "unrelated post" }] }; },
  });
  const r = await confirmNotPublished({
    pageId: "P", token: "T", captionFirstLine: "Hello world", sinceEpochSec: 0, fetchImpl,
  });
  assert.equal(r.confirmedNotPublished, true);
  assert.equal(r.scanned, 1);
});

test("confirmNotPublished: matches caption first line → recovered", async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return { data: [{ id: "P_42", permalink_url: "//perm", created_time: "2026-06-23T00:00Z", message: "Hello world here is more" }] };
    },
  });
  const r = await confirmNotPublished({
    pageId: "P", token: "T", captionFirstLine: "Hello world", sinceEpochSec: 0, fetchImpl,
  });
  assert.equal(r.confirmedNotPublished, false);
  assert.equal(r.matched.id, "P_42");
});

test("confirmNotPublished: HTTP error → not confirmed (do not retry)", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, async json() { return {}; } });
  const r = await confirmNotPublished({
    pageId: "P", token: "T", captionFirstLine: "x", sinceEpochSec: 0, fetchImpl,
  });
  assert.equal(r.confirmedNotPublished, false);
  assert.match(r.error, /HTTP 500/);
});

// ------- publishPhoto -------

test("publishPhoto: success returns fb_post_id", async () => {
  const fetchImpl = async (url, opts) => {
    assert.ok(url.endsWith("/v19.0/P/photos"));
    assert.equal(opts.method, "POST");
    return { ok: true, status: 200, async text() { return JSON.stringify({ id: "P_1", post_id: "P_1" }); } };
  };
  const r = await publishPhoto({ pageId: "P", token: "T", imageUrl: "U", message: "m", fetchImpl });
  assert.equal(r.fb_post_id, "P_1");
});

test("publishPhoto: 5xx is retryable", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, async text() { return "down"; } });
  await assert.rejects(
    () => publishPhoto({ pageId: "P", token: "T", imageUrl: "U", message: "m", fetchImpl }),
    (e) => e instanceof PublishError && e.retryable === true,
  );
});

test("publishPhoto: 400 is non-retryable", async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, async text() { return "bad"; } });
  await assert.rejects(
    () => publishPhoto({ pageId: "P", token: "T", imageUrl: "U", message: "m", fetchImpl }),
    (e) => e instanceof PublishError && e.retryable === false,
  );
});

// ------- publishRun end-to-end (mocked pg + fetch) -------

function runRow(overrides = {}) {
  return {
    run_id: "R1",
    topic_hash: "topic-x",
    caption: "Hello world.\nSecond line.",
    core_hashtags: ["#AI"],
    topic_hashtags: [],
    audience_mentions: [],
    image_url: "https://s3/foo.png",
    image_width: 1080,
    image_height: 1350,
    retry_count: 0,
    publishing_result: null,
    ...overrides,
  };
}

function mockPgFor(row, opts = {}) {
  const queries = [];
  const updates = [];
  const inserts = [];
  let aborted = false;
  return {
    queries, updates, inserts,
    isAborted() { return aborted; },
    async query(text, params) {
      queries.push({ text, params });
      if (text.startsWith("SELECT run_id, topic_hash")) {
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text === "BEGIN" || text === "COMMIT") return { rows: [], rowCount: 0 };
      if (text === "ROLLBACK") { aborted = true; return { rows: [], rowCount: 0 }; }
      if (text.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ got: opts.lockBusy ? false : true }], rowCount: 1 };
      }
      if (text.includes("FROM vep_runs\n      WHERE fb_post_id IS NOT NULL")) {
        return opts.duplicate
          ? { rows: [{ run_id: "old", fb_post_id: "OLD", fb_post_url: "u" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (text.startsWith("INSERT INTO vep_publish_attempts")) {
        inserts.push(params);
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("UPDATE vep_runs")) {
        updates.push({ text, params });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test("publishRun: happy path publishes, logs success, sets Published", async () => {
  const pg = mockPgFor(runRow());
  const fetchImpl = async (url) => {
    if (url.includes("/photos")) {
      return { ok: true, status: 200, async text() { return JSON.stringify({ post_id: "P_99" }); } };
    }
    throw new Error("unexpected fetch: " + url);
  };
  const r = await publishRun({
    runId: "R1",
    pgClient: pg,
    env: { FACEBOOK_PAGE_ACCESS_TOKEN: "T" },
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(r.published, true);
  assert.equal(r.fb_post_id, "P_99");
  assert.equal(pg.inserts.length, 1);
  assert.equal(pg.inserts[0][1], "success");
  const setPublished = pg.updates.find((u) => u.text.includes("'Published'"));
  assert.ok(setPublished, "should set Published");
});

test("publishRun: duplicate today → skipped, no FB call", async () => {
  const pg = mockPgFor(runRow(), { duplicate: true });
  let fbCalled = false;
  const fetchImpl = async () => { fbCalled = true; return { ok: true, async text() { return "{}"; } }; };
  const r = await publishRun({
    runId: "R1", pgClient: pg, env: { FACEBOOK_PAGE_ACCESS_TOKEN: "T" }, fetchImpl, sleep: async () => {},
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "duplicate_today");
  assert.equal(fbCalled, false);
  assert.equal(pg.isAborted(), true);
});

test("publishRun: advisory lock busy → skipped", async () => {
  const pg = mockPgFor(runRow(), { lockBusy: true });
  const r = await publishRun({
    runId: "R1", pgClient: pg, env: { FACEBOOK_PAGE_ACCESS_TOKEN: "T" },
    fetchImpl: async () => { throw new Error("no fetch expected"); },
    sleep: async () => {},
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "advisory_lock_busy");
});

test("publishRun: retries on 5xx, then succeeds; uses 60s/180s backoff", async () => {
  const pg = mockPgFor(runRow());
  let n = 0;
  const fetchImpl = async (url) => {
    if (url.includes("/photos")) {
      n += 1;
      if (n < 3) return { ok: false, status: 503, async text() { return "down"; } };
      return { ok: true, status: 200, async text() { return JSON.stringify({ id: "P_OK" }); } };
    }
    if (url.includes("/posts?")) {
      return { ok: true, async json() { return { data: [] }; } };
    }
    throw new Error("unexpected: " + url);
  };
  const sleeps = [];
  const r = await publishRun({
    runId: "R1", pgClient: pg, env: { FACEBOOK_PAGE_ACCESS_TOKEN: "T" }, fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(r.published, true);
  assert.equal(r.attempts, 3);
  assert.deepEqual(sleeps, [60_000, 180_000]);
});

test("publishRun: exhausts retries → Publishing Failed + onFinalFailure called", async () => {
  const pg = mockPgFor(runRow());
  const fetchImpl = async (url) => {
    if (url.includes("/photos")) return { ok: false, status: 503, async text() { return "down"; } };
    if (url.includes("/posts?")) return { ok: true, async json() { return { data: [] }; } };
    throw new Error("unexpected: " + url);
  };
  let hookCalls = 0;
  let hookPayload = null;
  const r = await publishRun({
    runId: "R1", pgClient: pg, env: { FACEBOOK_PAGE_ACCESS_TOKEN: "T" }, fetchImpl,
    sleep: async () => {},
    onFinalFailure: async (p) => { hookCalls += 1; hookPayload = p; },
  });
  assert.equal(r.failed, true);
  assert.equal(r.attempts, MAX_RETRIES + 1);
  assert.equal(hookCalls, 1);
  assert.equal(hookPayload.attempts, MAX_RETRIES + 1);
  const failed = pg.updates.find((u) => u.text.includes("'Publishing Failed'"));
  assert.ok(failed, "should set Publishing Failed");
  // 1 attempt insert per try
  assert.equal(pg.inserts.length, MAX_RETRIES + 1);
});

test("publishRun: post-failure confirmation finds silent success → marks Published", async () => {
  const pg = mockPgFor(runRow());
  const fetchImpl = async (url) => {
    if (url.includes("/photos")) {
      return { ok: false, status: 504, async text() { return "timeout"; } };
    }
    if (url.includes("/posts?")) {
      return {
        ok: true,
        async json() {
          return { data: [{ id: "P_SILENT", message: "Hello world. tail" }] };
        },
      };
    }
    throw new Error("unexpected: " + url);
  };
  const r = await publishRun({
    runId: "R1", pgClient: pg, env: { FACEBOOK_PAGE_ACCESS_TOKEN: "T" }, fetchImpl,
    sleep: async () => {},
  });
  assert.equal(r.published, true);
  assert.equal(r.fb_post_id, "P_SILENT");
  assert.equal(r.recoveredVia, "post_failure_confirmation");
});

test("publishRun: confirmation HTTP error blocks retry (Publishing Failed)", async () => {
  const pg = mockPgFor(runRow());
  const fetchImpl = async (url) => {
    if (url.includes("/photos")) return { ok: false, status: 503, async text() { return "x"; } };
    if (url.includes("/posts?")) return { ok: false, status: 500, async json() { return {}; } };
    throw new Error("unexpected: " + url);
  };
  const r = await publishRun({
    runId: "R1", pgClient: pg, env: { FACEBOOK_PAGE_ACCESS_TOKEN: "T" }, fetchImpl, sleep: async () => {},
  });
  assert.equal(r.failed, true);
  // first attempt only — we bail when we cannot confirm not-published
  assert.equal(pg.inserts.length, 1);
});

test("publishRun: bad image dimensions rejected before any FB call", async () => {
  const pg = mockPgFor(runRow({ image_width: 1080, image_height: 1080 }));
  let fbCalled = false;
  const fetchImpl = async () => { fbCalled = true; return { ok: true, async text() { return "{}"; } }; };
  await assert.rejects(
    () => publishRun({ runId: "R1", pgClient: pg, env: { FACEBOOK_PAGE_ACCESS_TOKEN: "T" }, fetchImpl, sleep: async () => {} }),
    (e) => e instanceof PublishError && e.stage === "validate" && e.retryable === false,
  );
  assert.equal(fbCalled, false);
});

test("publishRun: already-published row is a no-op", async () => {
  const pg = mockPgFor(runRow({ publishing_result: "Published", fb_post_id: "P_OLD" }));
  const r = await publishRun({
    runId: "R1", pgClient: pg, env: { FACEBOOK_PAGE_ACCESS_TOKEN: "T" },
    fetchImpl: async () => { throw new Error("no fetch"); },
    sleep: async () => {},
  });
  assert.equal(r.alreadyPublished, true);
});

test("publishRun: missing run row → non-retryable load error", async () => {
  const pg = mockPgFor(null);
  await assert.rejects(
    () => publishRun({ runId: "missing", pgClient: pg, env: { FACEBOOK_PAGE_ACCESS_TOKEN: "T" }, fetchImpl: async () => ({}), sleep: async () => {} }),
    (e) => e instanceof PublishError && e.stage === "load" && e.retryable === false,
  );
});
