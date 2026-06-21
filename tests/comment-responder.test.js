import test from "node:test";
import assert from "node:assert/strict";

import {
  PostgresCommentSeedStore,
  filterEligibleComments,
  seedMostRecentPost,
} from "../src/comment-responder.js";
import { SEED_COPY, classifyPostType, selectSeedCopy } from "../src/seed-config.js";

const PAGE_ID = "1097492980106238";

// --- Deliverable 4: never reply to our own seed (page-authored comments) ---

test("filterEligibleComments excludes page-authored comments so we never reply to our own seed", () => {
  const now = Date.now();
  const recent = new Date(now - 60 * 60 * 1000).toISOString();
  const comments = [
    // Our own seed comment, authored by the page itself.
    { id: "seed_self", created_time: recent, from: { id: PAGE_ID, name: "The Lens" }, message: SEED_COPY.generic },
    // A genuine follower comment.
    { id: "follower_1", created_time: recent, from: { id: "9999", name: "Reader" }, message: "Great point!" },
  ];

  const eligible = filterEligibleComments({ comments, pageId: PAGE_ID, repliedIds: new Set(), now });

  assert.deepEqual(eligible.map((c) => c.id), ["follower_1"]);
  assert.equal(eligible.some((c) => c.id === "seed_self"), false);
});

// --- Deliverable 1: shared seed copy + classifier ---

test("classifyPostType maps signals to types and falls back to generic", () => {
  assert.equal(classifyPostType("This week's recap of AI news"), "recap");
  assert.equal(classifyPostType("The best prompt we found"), "prompt");
  assert.equal(classifyPostType("Quick poll: which do you prefer?"), "poll");
  assert.equal(classifyPostType("New tool launch you should try"), "tool");
  assert.equal(classifyPostType("Some musing with no signal words"), "generic");
  assert.equal(classifyPostType(undefined), "generic");
});

test("selectSeedCopy returns the canonical copy for the detected type", () => {
  assert.deepEqual(selectSeedCopy("New tool launch"), { postType: "tool", seed: SEED_COPY.tool });
  assert.deepEqual(selectSeedCopy(""), { postType: "generic", seed: SEED_COPY.generic });
});

// --- THEAAAAA-379: tightened recap classifier with realistic news bodies ---

test("classifyPostType: news bodies with 'weekly active users' / 'this week' do NOT mis-route to recap", () => {
  // The exact trap from the THEAAAAA-109 go-live smoke: a SpaceX/Cursor news/tool
  // post mentioning weekly active users. Bare `weekly`/`this week` must not win.
  const newsTrap =
    "Cursor just shipped a major release and SpaceX confirmed Starlink now serves " +
    "more than 900 million weekly active users. Try the new feature today.";
  assert.equal(classifyPostType(newsTrap), "tool");

  // "earlier this week" framing in a launch post — still a tool, not a recap.
  const launchThisWeek =
    "Anthropic announced a new app earlier this week — here's what launched.";
  assert.equal(classifyPostType(launchThisWeek), "tool");

  // Generic news with the bare tokens but no roundup intent and no tool signal.
  assert.equal(
    classifyPostType("The model hit 100 million weekly active users this week."),
    "generic",
  );
});

test("classifyPostType: genuine weekly-roundup intent still classifies as recap", () => {
  assert.equal(classifyPostType("This week's AI recap: the biggest stories"), "recap");
  assert.equal(classifyPostType("Our weekly roundup of AI tools and launches"), "recap");
  assert.equal(classifyPostType("Weekly round-up: everything that shipped"), "recap");
  assert.equal(classifyPostType("This week's top AI moments, in one place"), "recap");
  assert.equal(classifyPostType("The weekly digest of automation news"), "recap");
});

test("classifyPostType: one realistic body per post type routes correctly", () => {
  assert.equal(
    classifyPostType("New tool alert: this AI app just launched a feature you can try today."),
    "tool",
  );
  assert.equal(
    classifyPostType("The prompt that got us the cleanest output this sprint — copy it."),
    "prompt",
  );
  assert.equal(
    classifyPostType("Quick poll: would you rather automate email or meetings? Vote below."),
    "poll",
  );
  assert.equal(classifyPostType("Weekly recap of what shipped in AI"), "recap");
  assert.equal(
    classifyPostType("A short reflection on where AI is heading, no links."),
    "generic",
  );
});

// --- Deliverable 2: idempotent seed store ---

function fakeSeedClient({ existingPostIds = [] } = {}) {
  const existing = new Set(existingPostIds);
  const queries = [];
  return {
    queries,
    async connect() {},
    async query(text, params) {
      queries.push({ text, params });
      if (text.includes("SELECT 1")) {
        return { rowCount: existing.has(params[0]) ? 1 : 0, rows: existing.has(params[0]) ? [{ "?column?": 1 }] : [] };
      }
      if (text.includes("INSERT INTO")) {
        if (existing.has(params[0])) return { rowCount: 0, rows: [] }; // ON CONFLICT DO NOTHING
        existing.add(params[0]);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    async end() {},
  };
}

test("PostgresCommentSeedStore creates facebook_comment_seeds and enforces one seed per post id", async () => {
  const client = fakeSeedClient();
  const store = new PostgresCommentSeedStore({
    connectionString: "postgres://example",
    table: "public.facebook_comment_seeds",
    clientFactory: () => client,
  });

  assert.equal(await store.hasSeed("post_1"), false);
  assert.equal(await store.recordSeed({ postId: "post_1", seedCommentId: "c_1", postType: "tool" }), true);
  assert.equal(await store.hasSeed("post_1"), true);
  // Second insert for the same post id is a no-op (ON CONFLICT DO NOTHING).
  assert.equal(await store.recordSeed({ postId: "post_1", seedCommentId: "c_2", postType: "tool" }), false);
  await store.close();

  assert.equal(
    client.queries.some(({ text }) => text.includes('CREATE TABLE IF NOT EXISTS "public"."facebook_comment_seeds"')),
    true,
  );
  assert.equal(
    client.queries.some(({ text }) => text.includes("post_id TEXT PRIMARY KEY")),
    true,
  );
});

test("PostgresCommentSeedStore rejects unsafe table names", () => {
  assert.throws(
    () =>
      new PostgresCommentSeedStore({
        connectionString: "postgres://example",
        table: "public.facebook_comment_seeds;DROP TABLE x",
        clientFactory: () => ({ async connect() {}, async query() { return { rowCount: 0, rows: [] }; }, async end() {} }),
      }),
    /Invalid PostgreSQL table name/,
  );
});

// --- Deliverable 3: orchestration is idempotent and graceful ---

function fakeFbClient({ posts = [], onCreate } = {}) {
  return {
    created: [],
    async listRecentPosts() {
      return posts;
    },
    async createComment(postId, message) {
      this.created.push({ postId, message });
      if (onCreate) onCreate(postId, message);
      return "seed_comment_xyz";
    },
  };
}

test("seedMostRecentPost seeds a new post once with the classified copy", async () => {
  const client = fakeFbClient({ posts: [{ id: "post_9", message: "New AI tool launch", created_time: "now" }] });
  const store = new PostgresCommentSeedStore({
    connectionString: "postgres://example",
    table: "public.facebook_comment_seeds",
    clientFactory: () => fakeSeedClient(),
  });

  const result = await seedMostRecentPost({ client, store });
  assert.equal(result.outcome, "seeded");
  assert.equal(result.post_id, "post_9");
  assert.equal(result.post_type, "tool");
  assert.equal(client.created.length, 1);
  assert.equal(client.created[0].message, SEED_COPY.tool);
});

test("seedMostRecentPost skips a post that was already seeded (no second comment)", async () => {
  const client = fakeFbClient({ posts: [{ id: "post_dup", message: "anything", created_time: "now" }] });
  const store = new PostgresCommentSeedStore({
    connectionString: "postgres://example",
    table: "public.facebook_comment_seeds",
    clientFactory: () => fakeSeedClient({ existingPostIds: ["post_dup"] }),
  });

  const result = await seedMostRecentPost({ client, store });
  assert.equal(result.outcome, "already_seeded");
  assert.equal(client.created.length, 0); // never posts to Graph when already seeded
});

test("seedMostRecentPost reports no_post when the page has no recent posts", async () => {
  const client = fakeFbClient({ posts: [] });
  const store = new PostgresCommentSeedStore({
    connectionString: "postgres://example",
    table: "public.facebook_comment_seeds",
    clientFactory: () => fakeSeedClient(),
  });

  const result = await seedMostRecentPost({ client, store });
  assert.equal(result.outcome, "no_post");
  assert.equal(client.created.length, 0);
});
