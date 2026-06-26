import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTERVALS,
  WINDOW_SEC,
  POST_INSIGHT_METRICS,
  findDueSnapshots,
  fetchPostInsights,
  fetchPostSummary,
  fetchFollowerDelta,
  mapInsights,
  insertSnapshot,
  pollPerformance,
  PollError,
} from "../src/vep/poll-performance.mjs";

// ---- fixtures / helpers ----

function makeMockPg(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const h of handlers) {
        if (h.match.test(sql)) return h.respond(sql, params, calls.length);
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function okJson(body) {
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify(body); },
    async json() { return body; },
  };
}

function errJson(status, body) {
  return {
    ok: false,
    status,
    async text() { return JSON.stringify(body); },
    async json() { return body; },
  };
}

// ---- findDueSnapshots ----

test("findDueSnapshots queries one row per interval and flattens", async () => {
  const pg = makeMockPg([
    {
      match: /vep_runs/,
      respond(_sql, params) {
        // params[0] is interval key
        return {
          rows: [
            { run_id: `run-${params[0]}`, fb_post_id: "POST", actual_publication_time: "t" },
          ],
          rowCount: 1,
        };
      },
    },
  ]);
  const rows = await findDueSnapshots(pg, { now: new Date("2026-06-23T00:00:00Z") });
  assert.equal(rows.length, INTERVALS.length);
  assert.deepEqual(
    rows.map((r) => r.interval),
    INTERVALS.map((i) => i.key),
  );
  assert.equal(pg.calls.length, INTERVALS.length);
});

test("findDueSnapshots filters to status='published' so cancelled smokes are excluded", async () => {
  // Simulate DB: one cancelled row + one published row exist with fb_post_id NOT NULL.
  // The WHERE r.status = 'published' filter must exclude the cancelled row.
  const pg = makeMockPg([
    {
      match: /vep_runs/,
      respond(sql) {
        assert.match(sql, /r\.status\s*=\s*'published'/);
        // Mimic Postgres applying the predicate: cancelled row is dropped, only published returned.
        return {
          rows: [
            { run_id: "published-run", fb_post_id: "POST", actual_publication_time: "t" },
          ],
          rowCount: 1,
        };
      },
    },
  ]);
  const rows = await findDueSnapshots(pg);
  for (const r of rows) assert.equal(r.run_id, "published-run");
  assert.equal(pg.calls.length, INTERVALS.length);
  for (const c of pg.calls) assert.match(c.sql, /r\.status\s*=\s*'published'/);
});

test("findDueSnapshots passes WINDOW_SEC", async () => {
  const pg = makeMockPg([{ match: /vep_runs/, respond: () => ({ rows: [], rowCount: 0 }) }]);
  await findDueSnapshots(pg);
  for (const c of pg.calls) {
    assert.equal(c.params[3], WINDOW_SEC);
  }
});

// ---- fetchPostInsights ----

test("fetchPostInsights includes required metrics + raises on non-2xx", async () => {
  let captured;
  const fetchImpl = async (url) => {
    captured = url;
    return okJson({ data: [] });
  };
  await fetchPostInsights({ fbPostId: "P1", token: "T", fetchImpl });
  for (const m of POST_INSIGHT_METRICS) assert.ok(captured.includes(m), `missing ${m}`);
  assert.ok(captured.includes("/P1/insights"));

  await assert.rejects(
    () =>
      fetchPostInsights({
        fbPostId: "P1",
        token: "T",
        fetchImpl: async () => errJson(500, { error: "boom" }),
      }),
    (err) => err instanceof PollError && err.stage === "insights",
  );
});

// ---- fetchPostSummary ----

test("fetchPostSummary requests summary edges", async () => {
  let captured;
  const fetchImpl = async (url) => {
    captured = url;
    return okJson({});
  };
  await fetchPostSummary({ fbPostId: "P1", token: "T", fetchImpl });
  assert.ok(captured.includes("comments.summary(true)"));
  assert.ok(captured.includes("reactions.summary(true)"));
  assert.ok(captured.includes("shares"));
});

// ---- fetchFollowerDelta ----

test("fetchFollowerDelta sums daily values; null when missing", async () => {
  const ok = await fetchFollowerDelta({
    pageId: "PAGE",
    token: "T",
    sincePublication: "2026-06-20T00:00:00Z",
    now: new Date("2026-06-23T00:00:00Z"),
    fetchImpl: async () =>
      okJson({ data: [{ values: [{ value: 2 }, { value: 3 }, { value: 5 }] }] }),
  });
  assert.equal(ok.value, 10);

  const missing = await fetchFollowerDelta({
    pageId: "PAGE",
    token: "T",
    sincePublication: "2026-06-20T00:00:00Z",
    now: new Date("2026-06-23T00:00:00Z"),
    fetchImpl: async () => okJson({ data: [] }),
  });
  assert.equal(missing.value, null);

  const errored = await fetchFollowerDelta({
    pageId: "PAGE",
    token: "T",
    sincePublication: "2026-06-20T00:00:00Z",
    now: new Date("2026-06-23T00:00:00Z"),
    fetchImpl: async () => errJson(400, { error: "x" }),
  });
  assert.equal(errored.value, null);
  assert.ok(errored.error);
});

// ---- mapInsights ----

test("mapInsights flattens reactions_by_type + uses summary for comments/shares", () => {
  const out = mapInsights({
    insights: {
      data: [
        { name: "post_impressions_unique", values: [{ value: 1000 }] },
        {
          name: "post_reactions_by_type_total",
          values: [{ value: { like: 50, love: 5, wow: 2 } }],
        },
        { name: "post_clicks", values: [{ value: 80 }] },
      ],
    },
    summary: {
      comments: { summary: { total_count: 7 } },
      shares: { count: 3 },
    },
  });
  assert.deepEqual(out, { reach: 1000, reactions: 57, comments: 7, shares: 3, clicks: 80 });
});

test("mapInsights falls back to summary reactions when by-type missing", () => {
  const out = mapInsights({
    insights: { data: [] },
    summary: { reactions: { summary: { total_count: 12 } } },
  });
  assert.equal(out.reactions, 12);
  assert.equal(out.reach, null);
  assert.equal(out.clicks, null);
});

// ---- insertSnapshot ----

test("insertSnapshot uses ON CONFLICT DO NOTHING and returns inserted boolean", async () => {
  let captured;
  const pg = {
    async query(sql, params) {
      captured = { sql, params };
      return { rowCount: 1, rows: [{ snapshot_id: "S1" }] };
    },
  };
  const wrote = await insertSnapshot(pg, {
    runId: "R1",
    interval: "24h",
    mapped: { reach: 1, reactions: 2, comments: 3, shares: 4, clicks: 5 },
    newFollowers: 6,
    raw: { hi: true },
  });
  assert.equal(wrote, true);
  assert.match(captured.sql, /ON CONFLICT \(run_id, interval\) DO NOTHING/);
  assert.deepEqual(captured.params.slice(0, 8), ["R1", "24h", 1, 2, 3, 4, 5, 6]);

  const skip = await insertSnapshot(
    { async query() { return { rowCount: 0, rows: [] }; } },
    { runId: "R1", interval: "24h", mapped: { reach: 0, reactions: 0, comments: 0, shares: 0, clicks: 0 }, newFollowers: null, raw: null },
  );
  assert.equal(skip, false);
});

// ---- pollPerformance (end-to-end-ish) ----

test("pollPerformance: no due rows → early return, no token resolved", async () => {
  const pg = makeMockPg([{ match: /vep_runs/, respond: () => ({ rows: [], rowCount: 0 }) }]);
  const out = await pollPerformance({
    pgClient: pg,
    env: {}, // would throw if token resolution ran
    fetchImpl: async () => { throw new Error("should not fetch"); },
    log: () => {},
  });
  assert.deepEqual(out, { polled: 0, inserted: 0, errors: 0, results: [] });
});

test("pollPerformance: writes one snapshot per due row", async () => {
  let inserts = 0;
  const pg = {
    async query(sql, params) {
      if (/FROM vep_runs/.test(sql) && /LEFT JOIN/.test(sql)) {
        if (params[0] === "24h") {
          return {
            rows: [
              { run_id: "R1", fb_post_id: "POST1", actual_publication_time: "2026-06-22T00:00:00Z" },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO vep_performance_snapshots/.test(sql)) {
        inserts += 1;
        return { rowCount: 1, rows: [{ snapshot_id: "S" }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const fetchImpl = async (url) => {
    if (url.includes("/insights?metric=")) {
      return okJson({
        data: [
          { name: "post_impressions_unique", values: [{ value: 500 }] },
          { name: "post_reactions_by_type_total", values: [{ value: { like: 10, love: 1 } }] },
          { name: "post_clicks", values: [{ value: 20 }] },
        ],
      });
    }
    if (url.includes("/insights/page_follows")) {
      return okJson({ data: [{ values: [{ value: 4 }] }] });
    }
    if (url.includes("comments.summary")) {
      return okJson({
        comments: { summary: { total_count: 2 } },
        shares: { count: 1 },
      });
    }
    throw new Error(`unexpected url: ${url}`);
  };

  const out = await pollPerformance({
    pgClient: pg,
    env: { FACEBOOK_PAGE_ACCESS_TOKEN: "TOK" },
    fetchImpl,
    log: () => {},
  });
  assert.equal(out.polled, 1);
  assert.equal(out.inserted, 1);
  assert.equal(out.errors, 0);
  assert.equal(inserts, 1);
  assert.equal(out.results[0].mapped.reactions, 11);
  assert.equal(out.results[0].new_followers, 4);
});

test("pollPerformance: per-row failures are isolated", async () => {
  const pg = {
    async query(sql, params) {
      if (/FROM vep_runs/.test(sql) && /LEFT JOIN/.test(sql)) {
        if (params[0] === "24h") {
          return {
            rows: [{ run_id: "R1", fb_post_id: "P1", actual_publication_time: "t" }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const fetchImpl = async () => errJson(500, { error: "boom" });
  const out = await pollPerformance({
    pgClient: pg,
    env: { FACEBOOK_PAGE_ACCESS_TOKEN: "TOK" },
    fetchImpl,
    log: () => {},
  });
  assert.equal(out.polled, 1);
  assert.equal(out.inserted, 0);
  assert.equal(out.errors, 1);
  assert.equal(out.results[0].stage, "insights");
});
