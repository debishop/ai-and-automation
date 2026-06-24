// THEAAAAA-586 content-hash guard unit tests. Pure JS + mocked pg client.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GUARD_WINDOW_MINUTES,
  checkRecentHash,
  computeContentHash,
  normalizeCaption,
  recordContentHash,
} from "../src/content-hash.js";

function makeMockClient() {
  const store = [];
  const calls = [];
  return {
    store,
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const trimmed = sql.trim();
      if (trimmed.startsWith("SELECT")) {
        const [contentHash, pageId, isDryRun, windowMinutes] = params;
        const cutoff = Date.now() - windowMinutes * 60_000;
        const hit = store
          .filter(
            (r) =>
              r.content_hash === contentHash &&
              r.page_id === pageId &&
              r.is_dry_run === isDryRun &&
              r.published_at.getTime() > cutoff,
          )
          .sort((a, b) => b.published_at - a.published_at)[0];
        return { rows: hit ? [hit] : [] };
      }
      if (trimmed.startsWith("INSERT")) {
        const [contentHash, pageId, postId, isDryRun, note] = params;
        const row = {
          guard_id: `g-${store.length + 1}`,
          content_hash: contentHash,
          page_id: pageId,
          post_id: postId,
          is_dry_run: isDryRun,
          note,
          published_at: new Date(),
        };
        store.push(row);
        return { rows: [{ guard_id: row.guard_id, published_at: row.published_at }] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

const PAGE = "1097492980106238";
const MEDIA = Buffer.from("fake mp4 bytes");

describe("normalizeCaption", () => {
  it("collapses whitespace and lowercases so trivial reflows hash the same", () => {
    assert.equal(normalizeCaption("  Hello   World\nAgain "), "hello world again");
  });
  it("returns empty string for non-strings", () => {
    assert.equal(normalizeCaption(null), "");
    assert.equal(normalizeCaption(undefined), "");
  });
});

describe("computeContentHash", () => {
  it("is deterministic for the same inputs", () => {
    const h1 = computeContentHash({ caption: "Hello world", mediaBytes: MEDIA, pageId: PAGE });
    const h2 = computeContentHash({ caption: "Hello world", mediaBytes: MEDIA, pageId: PAGE });
    assert.equal(h1, h2);
  });
  it("ignores whitespace + case but flips on real text changes", () => {
    const h1 = computeContentHash({ caption: "Hello world", mediaBytes: MEDIA, pageId: PAGE });
    const h2 = computeContentHash({ caption: "  HELLO\nWORLD ", mediaBytes: MEDIA, pageId: PAGE });
    assert.equal(h1, h2);
    const h3 = computeContentHash({ caption: "Hello brave world", mediaBytes: MEDIA, pageId: PAGE });
    assert.notEqual(h1, h3);
  });
  it("changes with page id (so the same content publishing to a different page is allowed)", () => {
    const h1 = computeContentHash({ caption: "A", mediaBytes: MEDIA, pageId: PAGE });
    const h2 = computeContentHash({ caption: "A", mediaBytes: MEDIA, pageId: "999" });
    assert.notEqual(h1, h2);
  });
  it("rejects bad inputs early", () => {
    assert.throws(() => computeContentHash({ caption: "x", mediaBytes: "not bytes", pageId: PAGE }));
    assert.throws(() => computeContentHash({ caption: "x", mediaBytes: MEDIA, pageId: "" }));
  });
});

describe("checkRecentHash + recordContentHash", () => {
  it("returns null when no record exists, then hits after a record is written", async () => {
    const client = makeMockClient();
    const contentHash = computeContentHash({ caption: "Samsung post", mediaBytes: MEDIA, pageId: PAGE });
    const first = await checkRecentHash(client, { contentHash, pageId: PAGE });
    assert.equal(first, null);
    await recordContentHash(client, { contentHash, pageId: PAGE, postId: "p1", note: "first" });
    const second = await checkRecentHash(client, { contentHash, pageId: PAGE });
    assert.ok(second);
    assert.equal(second.post_id, "p1");
  });

  it("uses the configured window minutes", async () => {
    const client = makeMockClient();
    const contentHash = "h";
    // simulate an old record by directly inserting in the past
    client.store.push({
      guard_id: "g0",
      content_hash: contentHash,
      page_id: PAGE,
      post_id: "old",
      is_dry_run: false,
      published_at: new Date(Date.now() - 30 * 60_000),
      note: null,
    });
    const within = await checkRecentHash(client, { contentHash, pageId: PAGE, windowMinutes: 60 });
    assert.ok(within);
    const outside = await checkRecentHash(client, { contentHash, pageId: PAGE, windowMinutes: 15 });
    assert.equal(outside, null);
  });

  it("isolates dry-run records from live lookups", async () => {
    const client = makeMockClient();
    const contentHash = computeContentHash({ caption: "live vs dry", mediaBytes: MEDIA, pageId: PAGE });
    await recordContentHash(client, { contentHash, pageId: PAGE, isDryRun: true });
    const dryHit = await checkRecentHash(client, { contentHash, pageId: PAGE, isDryRun: true });
    const liveHit = await checkRecentHash(client, { contentHash, pageId: PAGE, isDryRun: false });
    assert.ok(dryHit);
    assert.equal(liveHit, null);
  });

  it("GUARD_WINDOW_MINUTES default is 15", () => {
    assert.equal(GUARD_WINDOW_MINUTES, 15);
  });
});
