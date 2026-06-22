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

// Approved-post caption hard cap (THEAAAAA-434 keeps the 205-word gate from the photo step).
export const CAPTION_WORD_CAP = 205;

export function wordCount(text) {
  if (typeof text !== "string") return 0;
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/).length;
}

// True only when the caption is non-empty and within the word cap. Empty/oversized => fail closed.
export function withinWordCap(text, cap = CAPTION_WORD_CAP) {
  const count = wordCount(text);
  return count > 0 && count <= cap;
}

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
// Reel (video_reels) ids returned by the 3-phase publish are bare numeric video ids.
const FACEBOOK_VIDEO_ID = /^\d+$/;

export function isRealFacebookPostId(value) {
  return typeof value === "string" && FACEBOOK_POST_ID.test(value.trim());
}

// THEAAAAA-434: the publish step now emits a Facebook Reel (video_reels) instead of a photo.
// A reel proof carries a bare-numeric `video_id` (the reel id) in addition to the post_id.
export function isRealReelVideoId(value) {
  return typeof value === "string" && FACEBOOK_VIDEO_ID.test(value.trim());
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

// 2. Publish proof-of-work. An artifact only counts if it carries a real publish id + permalink.
//
// THEAAAAA-434: the chain now publishes a Reel (video_reels), not a photo. A reel artifact is
// `{"media_type":"reel","video_id":"<bare numeric reel id>","facebook_post_id":"<page_post>",
//   "permalink":"<https fb url>"}`. The discriminator is `media_type:"reel"` (or a bare `video_id`
// with no post id). Photo artifacts (no media_type / no video_id) keep the original contract so
// the guard stays backward-compatible with the pre-434 step bodies and tests.
export function verifyPublishArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") {
    return {
      ok: false,
      reasons: ["no publish artifact captured"],
      media_type: null,
      facebook_post_id: null,
      video_id: null,
      permalink: null,
    };
  }
  const mediaType =
    typeof artifact.media_type === "string" ? artifact.media_type.toLowerCase().trim() : null;
  const postId = artifact.facebook_post_id ?? artifact.post_id ?? null;
  const videoId = artifact.video_id ?? artifact.reel_id ?? null;
  const permalink = artifact.permalink ?? artifact.permalink_url ?? artifact.url ?? null;
  // Treat as a reel when explicitly tagged, or when a video id is present without a post id.
  const isReel = mediaType === "reel" || (videoId != null && postId == null);
  const reasons = [];

  let resolvedVideoId = null;
  if (isReel) {
    if (!isRealReelVideoId(videoId)) reasons.push("missing or malformed video_id (reel)");
    else resolvedVideoId = String(videoId).trim();
  }
  // A real Facebook post id is still required for both photo and reel (the reel finish phase
  // returns a `{pageId}_{postId}` feed id alongside the video id; Step 10 logs it as before).
  if (!isRealFacebookPostId(postId)) reasons.push("missing or malformed facebook_post_id");
  if (!isRealPermalink(permalink)) reasons.push("missing or malformed permalink");

  return {
    ok: reasons.length === 0,
    reasons,
    media_type: isReel ? "reel" : "photo",
    facebook_post_id: isRealFacebookPostId(postId) ? String(postId).trim() : null,
    video_id: resolvedVideoId,
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
  const provenArtifact = {
    media_type: proof.media_type,
    facebook_post_id: proof.facebook_post_id,
    permalink: proof.permalink,
  };
  if (proof.media_type === "reel") provenArtifact.video_id = proof.video_id;
  return {
    status: STEP_DONE,
    reason:
      proof.media_type === "reel"
        ? "publish proof captured (reel video_id + facebook_post_id + permalink)"
        : "publish proof captured (facebook_post_id + permalink)",
    artifact: provenArtifact,
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
