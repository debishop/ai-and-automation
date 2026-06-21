import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateGate,
  verifyPublishArtifact,
  assertDedupLogPrecondition,
  resolvePublishStepDisposition,
  resolveDedupLogStepDisposition,
  isRealFacebookPostId,
  isRealPermalink,
  STEP_DONE,
  STEP_BLOCKED,
} from "../src/pipeline-guard.js";

const REAL_ARTIFACT = {
  facebook_post_id: "1097492980106238_1234567890",
  permalink: "https://www.facebook.com/1097492980106238/posts/1234567890",
};

test("isRealFacebookPostId accepts page_post and bare numeric ids only", () => {
  assert.equal(isRealFacebookPostId("1097492980106238_1234567890"), true);
  assert.equal(isRealFacebookPostId("1234567890"), true);
  assert.equal(isRealFacebookPostId(""), false);
  assert.equal(isRealFacebookPostId("pending"), false);
  assert.equal(isRealFacebookPostId(null), false);
  assert.equal(isRealFacebookPostId("abc_123"), false);
});

test("isRealPermalink requires https facebook host", () => {
  assert.equal(isRealPermalink("https://www.facebook.com/x/posts/1"), true);
  assert.equal(isRealPermalink("https://fb.watch/abc"), true);
  assert.equal(isRealPermalink("http://www.facebook.com/x"), false, "http rejected");
  assert.equal(isRealPermalink("https://example.com/x"), false, "non-fb host rejected");
  assert.equal(isRealPermalink(""), false);
  assert.equal(isRealPermalink(null), false);
});

test("gate 1: a cancelled upstream gate propagates as blocked, never proceed", () => {
  const gate = evaluateGate({ status: "cancelled" });
  assert.equal(gate.proceed, false);
  assert.equal(gate.propagateStatus, STEP_BLOCKED);
});

test("gate 1: unknown / missing upstream gate refuses to advance", () => {
  assert.equal(evaluateGate({}).proceed, false);
  assert.equal(evaluateGate({ status: "in_progress" }).proceed, false);
  assert.equal(evaluateGate(undefined).proceed, false);
});

test("gate 1: only an approved/done upstream gate proceeds", () => {
  assert.equal(evaluateGate({ status: "done" }).proceed, true);
  assert.equal(evaluateGate({ status: "approved" }).proceed, true);
});

test("gate 2: publish artifact must carry real post id + permalink", () => {
  assert.equal(verifyPublishArtifact(REAL_ARTIFACT).ok, true);
  assert.equal(verifyPublishArtifact(null).ok, false);
  assert.equal(verifyPublishArtifact({}).ok, false);
  assert.equal(verifyPublishArtifact({ facebook_post_id: REAL_ARTIFACT.facebook_post_id }).ok, false);
  assert.equal(verifyPublishArtifact({ permalink: REAL_ARTIFACT.permalink }).ok, false);
});

test("gate 3: dedup-log precondition throws a blocking error when artifact absent", () => {
  assert.throws(() => assertDedupLogPrecondition(null), /precondition failed/);
  assert.throws(() => assertDedupLogPrecondition({}), (err) => {
    assert.equal(err.code, "MISSING_PUBLISH_PROOF");
    assert.equal(err.blocked, true);
    return true;
  });
  assert.deepEqual(assertDedupLogPrecondition(REAL_ARTIFACT).ok, true);
});

test("publish step disposition: blocked when gate cancelled even if an artifact exists", () => {
  const d = resolvePublishStepDisposition({ upstreamGate: { status: "cancelled" }, artifact: REAL_ARTIFACT });
  assert.equal(d.status, STEP_BLOCKED);
});

test("publish step disposition: blocked when gate passes but no artifact (the run-195 defect)", () => {
  const d = resolvePublishStepDisposition({ upstreamGate: { status: "done" }, artifact: null });
  assert.equal(d.status, STEP_BLOCKED);
  assert.match(d.reason, /no verifiable artifact/);
});

test("publish step disposition: done only with gate passed + real artifact", () => {
  const d = resolvePublishStepDisposition({ upstreamGate: { status: "done" }, artifact: REAL_ARTIFACT });
  assert.equal(d.status, STEP_DONE);
  assert.equal(d.artifact.facebook_post_id, REAL_ARTIFACT.facebook_post_id);
});

test("dedup-log disposition: blocked when publish step is not done", () => {
  const publishStep = resolvePublishStepDisposition({ upstreamGate: { status: "done" }, artifact: null });
  const d = resolveDedupLogStepDisposition({ publishStep });
  assert.equal(d.status, STEP_BLOCKED);
});

test("dedup-log disposition: done when publish step carried proof", () => {
  const publishStep = resolvePublishStepDisposition({ upstreamGate: { status: "done" }, artifact: REAL_ARTIFACT });
  const d = resolveDedupLogStepDisposition({ publishStep });
  assert.equal(d.status, STEP_DONE);
});

// End-to-end reproduction of run THEAAAAA-195: Step 8.5 cancelled, Step 9 produced nothing.
test("run-195 scenario: cancelled gate + empty publish => whole chain stays fail-closed", () => {
  const publishStep = resolvePublishStepDisposition({
    upstreamGate: { status: "cancelled" }, // THEAAAAA-204
    artifact: null, // THEAAAAA-205 produced no facebook_post_id / permalink
  });
  assert.equal(publishStep.status, STEP_BLOCKED, "Step 9 must not be done");

  const logStep = resolveDedupLogStepDisposition({ publishStep });
  assert.equal(logStep.status, STEP_BLOCKED, "Step 10 must not be done");
});
