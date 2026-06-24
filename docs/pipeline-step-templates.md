# Guarded publish-chain step templates (THEAAAAA-381, THEAAAAA-434)

Canonical Step 8.7 (reel media-build), Step 9 (publish) and Step 10 (dedup-log) **issue-body
templates** for the daily 10-step "Viral AI and Automation News Story" chain. These bake the
[THEAAAAA-380] fail-closed guard into the step *definition* the generator emits, so a false `done`
is impossible **by template**, not by an agent remembering to run a check.

**THEAAAAA-434 update:** the publish step now emits a **Facebook Reel video** (`video_reels`),
not a static photo. Step 8.7 builds the stitched 9:16 reel (`scripts/build_reel.sh`,
[THEAAAAA-433](/THEAAAAA/issues/THEAAAAA-433)); Step 9 publishes it via the 3-phase `video_reels`
API ([THEAAAAA-322](/THEAAAAA/issues/THEAAAAA-322)) and the guard verifies a reel `video_id` +
`facebook_post_id` + permalink. The CCO owns the chain emission, so this file is the proposed
drop-in for CCO adoption (mirrors the [THEAAAAA-423](/THEAAAAA/issues/THEAAAAA-423)→425 adoption
pattern; GolpoAI render parameters are governed by the
[golpoai-runbook skill](/THEAAAAA/skills/e95e1ff3-4515-4429-a94a-2bc2715e2fc1) §7 — the deprecated
423 runbook redirects there).

## Who generates the chain

The chain is produced each day by the Paperclip routine **"The Viral AI and Automation News
Story"** (`routineId 6b404651-3ce9-490c-8009-fbcfd06790d4`), assigned to and owned by the **CCO**
(`3ef14ba8-5715-4fed-a183-2ef49ab9978a`). The routine fires one execution issue to the CCO, who
emits the Step 1–10 child issues (each step's body is the "template"). There is no separate stored
template artifact — this file is the canonical source the routine's Step 9/10 bodies must adopt.

Because the routine is owned by another agent, the Engineer cannot edit the emitted bodies
unilaterally (see THEAAAAA-381 task 3). This file is the drop-in the CCO/CTO pastes into the
routine so the guard is structural.

## Why the template, not just the guard

In run [THEAAAAA-195] the Step 8.5 CCO gate ([THEAAAAA-204]) was **cancelled**. Paperclip treats a
cancelled blocker as *resolved*, so Step 9 ([THEAAAAA-205]) auto-advanced to `done` with no
`facebook_post_id` and no permalink — a fail-**open** publish of nothing. `src/pipeline-guard.js`
makes a step *able* to refuse that, but only if the step body runs the check. These templates make
running the check the **only** path to `done`, and make the step read Step 8.5's *actual status*
rather than trusting blocker-resolution.

Both rules below mirror `evaluateGate()` / `resolvePublishStepDisposition()` /
`resolveDedupLogStepDisposition()` in `src/pipeline-guard.js`.

---

## Step 8.7 of 10 — Build the stitched 9:16 reel mp4 (Engineer)

> Run {PARENT_IDENTIFIER}. **Step 8.7 of 10** (Engineer). The chain now publishes a **Reel video**,
> not a static photo. Build the reel from the CCO-approved post text (Step 8.5) + the real image
> (Step 8) using the Producer's reel-build script ([THEAAAAA-433](/THEAAAAA/issues/THEAAAAA-433),
> vendored at `scripts/build_reel.sh`):
>
> ```bash
> scripts/build_reel.sh "<headline>" "<approved post body (Step 8.5)>" \
>   "<static image url/path (Step 8)>" "$WORKDIR/final_reel.mp4"
> ```
>
> Env: `GOLPOAI_API_KEY` (Doppler). Output: a 1080×1920 9:16 reel mp4 (3s static intro + Golpo
> animation, uniform libx264/aac/30fps). Re-host the mp4 as a durable Paperclip attachment and
> comment the watchable link. This feeds Step 9.
>
> *Render parameters (animation type, video_duration, watermark, resolution) are **not** restated
> here — `build_reel.sh` reads them from `golpoai-defaults.json`; the single source of truth is the
> [golpoai-runbook skill](/THEAAAAA/skills/e95e1ff3-4515-4429-a94a-2bc2715e2fc1) §7. Do not restate
> values.*
>
> **FAIL-CLOSED:** if `build_reel.sh` exits non-zero, the Golpo render times out, or the media
> gate (`scripts/media-gate.mjs`) exits non-zero, set this step **`blocked`** — never hand a
> bad/absent mp4 to Step 9. The media gate verifies portrait 1080×1920 h264 + AAC audio stream
> + duration > 0 **and** voice presence (non-silent audio ≥ `VOICE_MIN_NONSILENT_FRACTION`,
> default 30%) via `ffmpeg silencedetect`. Closes the Run 527 regression (THEAAAAA-566/-567)
> where a silent-track reel slipped through the legacy probe.
>
> ```bash
> node scripts/media-gate.mjs "$WORKDIR/final_reel.mp4"
> ```

## Step 9 of 10 — Publish the stitched reel to the Facebook Page (Engineer)

> Run {PARENT_IDENTIFIER}. **Step 9 of 10** (Engineer). Publish the **reel mp4** from Step 8.7 to
> the Lens Facebook Page **1097492980106238** as a **Facebook Reel** using the `video_reels`
> 3-phase API (start → upload bytes → finish with `video_state=PUBLISHED`), caption = the
> CCO-approved post text (Step 8.5). Mint a Page access token at runtime from
> `FACEBOOK_SYSTEM_USER_TOKEN` (raw system-user token hits #200 publish_actions — see Facebook
> publish pattern). Recipe: [THEAAAAA-322](/THEAAAAA/issues/THEAAAAA-322). Helper:
> `scripts/publish-reel.mjs`. Comment the resulting **reel `video_id` + `post_id` + public
> watchable permalink**; this unblocks Step 10 logging.
>
> **MANDATORY FAIL-CLOSED GATE (pre-`done`, not optional).**
>
> 1. **Inspect the upstream gate state, not just blocker-resolution.** Read the *actual* status of
>    the Step 8.5 CCO gate issue ({STEP_8_5_IDENTIFIER}) from the API — do not rely on the blocker
>    showing as resolved (a `cancelled` blocker reads as resolved):
>    ```bash
>    GATE=$(curl -fsS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
>      "$PAPERCLIP_API_URL/api/issues/{STEP_8_5_ISSUE_ID}" | jq -r '.status')
>    ```
>    Only `done` / `approved` / `completed` / `accepted` authorizes publishing. `cancelled` /
>    `blocked` / `failed` / `rejected` / `declined` / missing / any unknown state is a **stop**.
>
> 2. **205-word caption cap + portrait check, then publish.** The approved caption must pass the
>    205-word cap and the reel mp4 must be portrait 9:16 (both enforced by `publish-reel.mjs`).
>    Run the `video_reels` 3-phase publish, then capture the real reel `video_id` (bare numeric),
>    the `facebook_post_id` (`{pageId}_{postId}`), and the https facebook permalink into an
>    artifact JSON with `"media_type":"reel"`.
>
> 3. **Run the guard. Exit 0 is the only thing that authorizes `done`:**
>    ```bash
>    node scripts/pipeline-guard-check.mjs publish \
>      --gate-status "$GATE" \
>      --artifact '{"media_type":"reel","video_id":"<reel id>","facebook_post_id":"<{pageId}_{postId}>","permalink":"<https fb reel url>"}'
>    ```
>    - Exit `0` → you may set this step `done` and comment the `video_id` + `post_id` + permalink.
>    - Non-zero → set this step **`blocked`** with the printed reason. **Never `done`.** Do not
>      comment, log, or fabricate ids. If the gate was not authorized, nothing was published — say
>      so and stop the chain here.
>    - **Verify the live id** via `GET /{page-id}/video_reels` (publish-comment ids can be stale).

## Step 10 of 10 — Log publication record to dedup DB (Engineer)

> Run {PARENT_IDENTIFIER}. **Step 10 of 10** (Engineer). INSERT the published record into
> `public.facebook_publications` via a direct pg connection on `DATABASE_URL` (connects AS owner
> role `fb_routine`; ssl `rejectUnauthorized:false`; set `statement_timeout`). Idempotent:
> `ON CONFLICT (normalized_url) DO NOTHING`. Fields: normalized_url (trailing-slash strip),
> article_url, headline, score (INT; keep decimal in payload.score_detail), used_fallback,
> claim_status='published', claim_run_id = parent run issue UUID {PARENT_ISSUE_ID}, published_at,
> facebook_post_id, payload JSONB (title/source/summary/post_content/media_source/
> `media_type:"reel"`/reel_video_id/hashtags_used[]/facebook_post_link + provenance step map).
> Report INSERTED_ROWS and new total.
> This is the terminal step — completes the chain.
>
> **MANDATORY FAIL-CLOSED GATE (pre-anything, not optional).** Before opening the DB connection,
> confirm Step 9 actually shipped — never log a record for a publish that did not happen:
>
> 1. **Inspect Step 9's real status** ({STEP_9_IDENTIFIER}) the same way (API status, not blocker
>    resolution). If Step 9 is not `done`, **stop** → set this step **`blocked`**.
>
> 2. **Re-verify the publish proof** using the `post_id` + permalink Step 9 committed:
>    ```bash
>    node scripts/pipeline-guard-check.mjs dedup-log \
>      --artifact '{"facebook_post_id":"<id from Step 9>","permalink":"<permalink from Step 9>"}'
>    ```
>    - Exit `0` → proceed with the INSERT.
>    - Non-zero (or artifact absent) → set this step **`blocked`**; do **not** connect to the DB
>      and do **not** fabricate a `facebook_post_id`. This is exactly the run-195 behavior, made a
>      contract.

---

## Acceptance check (cancelled Step 8.5)

Simulating a cancelled Step 8.5 with no publish artifact, the guard the templates invoke exits
non-zero for both steps, so each step's only allowed disposition is `blocked`:

```bash
node scripts/pipeline-guard-check.mjs publish --gate-status cancelled --artifact '{}'; echo $?   # -> 1
node scripts/pipeline-guard-check.mjs dedup-log --artifact '{}'; echo $?                          # -> 1
```

`tests/pipeline-guard.test.js` asserts both exit codes (CLI-level) plus the library semantics.

## Acceptance check — reel publish (THEAAAAA-434)

A real gate + a real reel artifact (media_type/video_id/post_id/permalink) is the only path to
`done`; a reel missing the `video_id` fails closed:

```bash
node scripts/pipeline-guard-check.mjs publish --gate-status done \
  --artifact '{"media_type":"reel","video_id":"123","facebook_post_id":"1097492980106238_1","permalink":"https://www.facebook.com/reel/123"}'; echo $?  # -> 0
node scripts/pipeline-guard-check.mjs publish --gate-status done \
  --artifact '{"media_type":"reel","facebook_post_id":"1097492980106238_1","permalink":"https://www.facebook.com/reel/123"}'; echo $?                    # -> 1 (no video_id)
```

Offline/dry validation of the full media build (no live publish — board-gated per
[THEAAAAA-431](/THEAAAAA/issues/THEAAAAA-431)):

```bash
# Probe the stitched mp4 is portrait 9:16 + caption within the 205-word cap; fires NO Graph call.
node scripts/publish-reel.mjs --reel /path/to/final_reel.mp4 --caption "<approved post>" --dry-run; echo $?  # -> 0
```

[THEAAAAA-380]: ../README.md
[THEAAAAA-195]: ./pipeline-fail-closed.md
[THEAAAAA-204]: ./pipeline-fail-closed.md
[THEAAAAA-205]: ./pipeline-fail-closed.md
