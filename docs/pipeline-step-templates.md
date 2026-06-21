# Guarded publish-chain step templates (THEAAAAA-381)

Canonical Step 9 (publish) and Step 10 (dedup-log) **issue-body templates** for the daily
10-step "Viral AI and Automation News Story" chain. These bake the [THEAAAAA-380] fail-closed
guard into the step *definition* the generator emits, so a false `done` is impossible **by
template**, not by an agent remembering to run a check.

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

## Step 9 of 10 — Publish approved post + image to Facebook Page (Engineer)

> Run {PARENT_IDENTIFIER}. **Step 9 of 10** (Engineer). Publish the CCO-approved post (Step 8.5)
> with the real image (Step 8) to the Lens Facebook Page **1097492980106238**. Mint a Page access
> token at runtime from `FACEBOOK_SYSTEM_USER_TOKEN` (raw system-user token hits #200
> publish_actions — see Facebook publish pattern). Use the Graph API photo/feed publish. Comment
> the resulting `post_id` + public permalink; this unblocks Step 10 logging.
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
> 2. **Publish, then prove it.** After the Graph API call, capture the real `facebook_post_id`
>    (`{pageId}_{postId}` or bare numeric) and the https facebook permalink into an artifact JSON.
>
> 3. **Run the guard. Exit 0 is the only thing that authorizes `done`:**
>    ```bash
>    node scripts/pipeline-guard-check.mjs publish \
>      --gate-status "$GATE" \
>      --artifact '{"facebook_post_id":"<id>","permalink":"<https fb url>"}'
>    ```
>    - Exit `0` → you may set this step `done` and comment the `post_id` + permalink.
>    - Non-zero → set this step **`blocked`** with the printed reason. **Never `done`.** Do not
>      comment, log, or fabricate a `post_id`. If the gate was not authorized, nothing was
>      published — say so and stop the chain here.

## Step 10 of 10 — Log publication record to dedup DB (Engineer)

> Run {PARENT_IDENTIFIER}. **Step 10 of 10** (Engineer). INSERT the published record into
> `public.facebook_publications` via a direct pg connection on `DATABASE_URL` (connects AS owner
> role `fb_routine`; ssl `rejectUnauthorized:false`; set `statement_timeout`). Idempotent:
> `ON CONFLICT (normalized_url) DO NOTHING`. Fields: normalized_url (trailing-slash strip),
> article_url, headline, score (INT; keep decimal in payload.score_detail), used_fallback,
> claim_status='published', claim_run_id = parent run issue UUID {PARENT_ISSUE_ID}, published_at,
> facebook_post_id, payload JSONB (title/source/summary/post_content/media_source/
> hashtags_used[]/facebook_post_link + provenance step map). Report INSERTED_ROWS and new total.
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

[THEAAAAA-380]: ../README.md
[THEAAAAA-195]: ./pipeline-fail-closed.md
[THEAAAAA-204]: ./pipeline-fail-closed.md
[THEAAAAA-205]: ./pipeline-fail-closed.md
