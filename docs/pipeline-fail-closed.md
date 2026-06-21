# Publish pipeline fail-closed guard (THEAAAAA-380)

## Root cause

The daily publish run (parent `THEAAAAA-195`) is a 10-step chain of Paperclip **step issues**
distributed across the editorial team, wired together by issue **blockers**. A downstream step
wakes when its blocking upstream step is "resolved".

The defect is that Paperclip treats a **cancelled** blocker as resolved, the same as `done`.
So the chain failed **open**:

1. Step 8.5 CCO publish gate (`THEAAAAA-204`) was **cancelled** — authorization was never granted.
2. That cleared Step 9's blocker, so Step 9 publish (`THEAAAAA-205`) woke and was marked **done**
   even though it captured **no `facebook_post_id`, no permalink, no comment, no document** — it
   published nothing.
3. Step 10 (dedup log) then woke expecting a real `post_id` and correctly refused to fabricate one.

Net effect: the run "looked complete" (steps `done`/`cancelled`) while nothing shipped. Nothing in
the step-advancement path required *proof of work* before a step could reach `done`, and a cancelled
gate did not propagate as a stop signal.

## Fix (fail-closed contract)

`src/pipeline-guard.js` encodes the three required behaviors as pure, testable functions. The
step runners / agents call `scripts/pipeline-guard-check.mjs` to compute the only disposition a
step is allowed to take; the CLI exits non-zero whenever fail-closed blocks a `done`.

1. **Gate propagation** — `evaluateGate(upstreamGate)`
   - Only `done` / `approved` / `completed` / `accepted` upstream lets a downstream step proceed.
   - `cancelled` / `blocked` / `failed` / `rejected` / `declined` **and any unknown or missing
     state** propagate downstream as `blocked`. A cancelled gate can never auto-advance a child.

2. **Publish proof-of-work** — `verifyPublishArtifact(artifact)` / `resolvePublishStepDisposition(...)`
   - Step 9 may only reach `done` after a real `facebook_post_id` (`{pageId}_{postId}` or bare
     numeric) **and** a real https facebook permalink are captured as a first-class artifact.
   - No artifact, or a malformed one → `blocked`, never `done`.

3. **Step 10 precondition** — `assertDedupLogPrecondition(step9Artifact)` /
   `resolveDedupLogStepDisposition(...)`
   - The dedup-log step reads the Step 9 artifact and **hard-fails (`blocked`)** if absent —
     exactly the behavior the run-195 logger already showed. This makes it the contract, not luck.

## How step agents use it

Before marking a step `done`, run the guard. A non-zero exit means the step must be set
`blocked`, not `done`.

```bash
# Step 9 (publish)
node scripts/pipeline-guard-check.mjs publish \
  --gate-status "<status of Step 8.5>" \
  --artifact '{"facebook_post_id":"1097492980106238_123","permalink":"https://www.facebook.com/.../posts/123"}'

# Step 10 (dedup-log)
node scripts/pipeline-guard-check.mjs dedup-log \
  --artifact '<Step 9 artifact JSON, or omit to assert absence>'
```

## Routine wiring follow-up (out of scope here)

The guard makes each step refuse to *self-advance* without proof. The complementary change —
having the pipeline-generating routine wire downstream steps to inspect the upstream **completion
state** (so a `cancelled` Step 8.5 actively sets Step 9/10 to `blocked` rather than relying on the
downstream agent to run the guard) — is a routine-definition change owned by the CTO. This note +
guard is the systemic engineering fix; it does not decide run-195's write-off-vs-rerun disposition
(that is the CCO's call on `THEAAAAA-195`).

## Tests

`tests/pipeline-guard.test.js` — 13 tests including an end-to-end reproduction of the run-195
scenario (cancelled gate + empty publish artifact → whole chain stays `blocked`).
