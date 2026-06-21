// Fail-closed guards for the agent-orchestrated publish pipeline (THEAAAAA-195 step chain).
//
// Root cause (THEAAAAA-380): the daily publish chain is a set of Paperclip step issues wired
// by blockers. When the Step 8.5 CCO gate (THEAAAAA-204) was *cancelled*, the platform cleared
// the downstream blocker (a cancelled blocker reads as "resolved"), so Step 9 publish
// (THEAAAAA-205) woke and was marked `done` with NO facebook_post_id, NO permalink, NO artifact.
// The run "looked complete" while nothing shipped. That is a fail-OPEN defect.
//
// These guards make step advancement fail CLOSED:
//   1. A cancelled / blocked / unknown upstream gate propagates downstream as `blocked`.
//   2. A publish step may only reach `done` after a real post id + permalink artifact is captured.
//   3. The dedup-log step hard-fails (blocked) when the publish artifact is absent.

export const STEP_DONE = "done";
export const STEP_BLOCKED = "blocked";

// Upstream states that authorize a downstream step to proceed.
export const GATE_PASS_STATES = new Set(["done", "approved", "completed", "accepted"]);
// Terminal-stop upstream states that must propagate fail-closed (never auto-advance downstream).
export const GATE_STOP_STATES = new Set([
  "cancelled",
  "canceled",
  "blocked",
  "failed",
  "rejected",
  "declined",
]);

// Facebook feed/photo post ids are "{pageId}_{postId}" or a bare numeric id.
const FACEBOOK_POST_ID = /^\d+(_\d+)?$/;

export function isRealFacebookPostId(value) {
  return typeof value === "string" && FACEBOOK_POST_ID.test(value.trim());
}

export function isRealPermalink(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return /(^|\.)facebook\.com$/.test(url.hostname) || /(^|\.)fb\.(com|me|watch)$/.test(url.hostname);
}

// 1. Gate propagation. A cancelled/blocked/unknown upstream gate must NOT let the
// downstream step advance to `done`; it propagates as `blocked`.
export function evaluateGate(upstreamGate) {
  const status = String(upstreamGate?.status ?? "").toLowerCase().trim();
  if (GATE_PASS_STATES.has(status)) {
    return { proceed: true, propagateStatus: null, reason: `upstream gate ${status}` };
  }
  if (GATE_STOP_STATES.has(status)) {
    return {
      proceed: false,
      propagateStatus: STEP_BLOCKED,
      reason: `upstream gate is ${status}; propagating fail-closed (no auto-advance)`,
    };
  }
  // Missing, in-flight, or unrecognized state: refuse to advance.
  return {
    proceed: false,
    propagateStatus: STEP_BLOCKED,
    reason: `upstream gate not approved (status=${status || "missing"}); refusing to advance`,
  };
}

// 2. Publish proof-of-work. An artifact only counts if it carries a real post id + permalink.
export function verifyPublishArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") {
    return { ok: false, reasons: ["no publish artifact captured"], facebook_post_id: null, permalink: null };
  }
  const postId = artifact.facebook_post_id ?? artifact.post_id ?? null;
  const permalink = artifact.permalink ?? artifact.permalink_url ?? artifact.url ?? null;
  const reasons = [];
  if (!isRealFacebookPostId(postId)) reasons.push("missing or malformed facebook_post_id");
  if (!isRealPermalink(permalink)) reasons.push("missing or malformed permalink");
  return {
    ok: reasons.length === 0,
    reasons,
    facebook_post_id: isRealFacebookPostId(postId) ? String(postId).trim() : null,
    permalink: isRealPermalink(permalink) ? String(permalink).trim() : null,
  };
}

// 3. Dedup-log precondition. Step 10 must read the Step 9 artifact and hard-fail if absent.
// Throws a blocking error (keeps the run-195 behavior, makes it the contract).
export function assertDedupLogPrecondition(step9Artifact) {
  const proof = verifyPublishArtifact(step9Artifact);
  if (!proof.ok) {
    const error = new Error(`dedup-log precondition failed: ${proof.reasons.join("; ")}`);
    error.code = "MISSING_PUBLISH_PROOF";
    error.blocked = true;
    throw error;
  }
  return proof;
}

// Disposition resolver for the publish step (Step 9).
// Returns the only status the step is allowed to take given the gate + captured artifact.
export function resolvePublishStepDisposition({ upstreamGate, artifact } = {}) {
  const gate = evaluateGate(upstreamGate);
  if (!gate.proceed) {
    return { status: STEP_BLOCKED, reason: gate.reason, artifact: null };
  }
  const proof = verifyPublishArtifact(artifact);
  if (!proof.ok) {
    return {
      status: STEP_BLOCKED,
      reason: `publish produced no verifiable artifact: ${proof.reasons.join("; ")}`,
      artifact: null,
    };
  }
  return {
    status: STEP_DONE,
    reason: "publish proof captured (facebook_post_id + permalink)",
    artifact: { facebook_post_id: proof.facebook_post_id, permalink: proof.permalink },
  };
}

// Disposition resolver for the dedup-log step (Step 10).
// `publishStep` is the resolved disposition object from resolvePublishStepDisposition.
export function resolveDedupLogStepDisposition({ publishStep } = {}) {
  if (!publishStep || publishStep.status !== STEP_DONE) {
    return {
      status: STEP_BLOCKED,
      reason: "upstream publish step is not `done` with proof; refusing to log a fabricated post_id",
      artifact: null,
    };
  }
  try {
    const proof = assertDedupLogPrecondition(publishStep.artifact);
    return { status: STEP_DONE, reason: "publish proof present; dedup log may proceed", artifact: proof };
  } catch (error) {
    return { status: STEP_BLOCKED, reason: error.message, artifact: null };
  }
}
