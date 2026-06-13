// Seed-comment copy + post-type classification for the Comment-Reply Window.
//
// CMO/CCO own the voice. To revise a seed string, edit SEED_COPY below — that is
// the single source of truth for every seeding path (run-comment-replies.mjs and
// seed-latest-post.mjs both import from here). No logic lives in the copy map, so
// it can be revised without touching behaviour.
//
// Canonical copy: THEAAAAA-106.

/**
 * Seed comments keyed by detected post type. `generic` is the fallback used when
 * a post does not match any specific type.
 * @type {Record<"tool"|"prompt"|"poll"|"recap"|"generic", string>}
 */
export const SEED_COPY = {
  tool: "Quick one for the group 👇 What's the one task you'd hand to an AI tool tomorrow if it just worked? Drop it below — we'll dig into the best answers.",
  prompt: "Show us yours 👀 What prompt got you the best result this week? Paste it in the comments — we'll feature the sharpest ones.",
  poll: "No wrong answers here 🙌 Tell us *why* you voted the way you did — the reasoning is where it gets interesting. 👇",
  recap: "Catch anything we missed this week? Drop the AI tool or trick that earned a permanent spot in your workflow 👇",
  generic: "Curious where everyone lands on this 👇 What's your take? One line is plenty — we read every comment.",
};

export const FALLBACK_POST_TYPE = "generic";

/**
 * Classify a post's message into one of the SEED_COPY keys.
 * Order matters: more specific signals are checked before broad ones.
 * Returns FALLBACK_POST_TYPE ("generic") when nothing matches.
 */
export function classifyPostType(message) {
  const m = (message || "").toLowerCase();
  if (/recap|this week|round ?up|weekly/.test(m)) return "recap";
  if (/prompt/.test(m)) return "prompt";
  if (/poll|this or that|vote|would you rather/.test(m)) return "poll";
  if (/tool|app|try |feature|launch|release/.test(m)) return "tool";
  return FALLBACK_POST_TYPE;
}

/**
 * Convenience: classify a post message and return { postType, seed } in one call.
 */
export function selectSeedCopy(message) {
  const postType = classifyPostType(message);
  return { postType, seed: SEED_COPY[postType] ?? SEED_COPY[FALLBACK_POST_TYPE] };
}
