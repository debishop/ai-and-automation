# The Lens Facebook Routine

Standalone Facebook-only Node runtime for ranking, verifying, deduplicating, and publishing AI news stories.

## Runtime contract

- Inputs: JSON array of candidate research briefs enriched with draft copy and fact-check outputs
- Deduplication: normalized article URLs claimed and persisted in PostgreSQL before publish
- Fetch behavior: bounded HTTP fetch with explicit 30s timeout and bounded retries for transient failures
- Fallback: article fetch failures can still proceed only when the candidate marks `fallback_summary_verified=true`
- Publish path: Facebook Graph API `/{page-id}/feed`, preferring a system-user token that resolves a page-scoped token at runtime and allowing an explicit page token override when already provided
- Storage path: PostgreSQL datatables for publication dedupe state and per-run audit payloads
- Outputs: structured run log with selected story, rejected stories, duplicate URLs, and publish metadata
- Optional downstream steps stay outside the publish critical path. This runtime always returns the primary publish outcome plus audit data.

## Required candidate fields

The runtime expects the fields defined in [ai-news-facebook-routine-rubric.md](./ai-news-facebook-routine-rubric.md), plus:

- `article_url`
- `draft`
- `fact_check_verdict`
- `fact_check_sources`
- `fallback_summary_verified`
- `metadata.requires_video_links`
- `metadata.contains_rumor`

## Example

```bash
node ./src/cli.js \
  --candidates ./fixtures/candidates.json \
  --database-url "$DATABASE_URL" \
  --publications-table public.facebook_publications \
  --runs-table public.facebook_runs \
  --run-log ./logs/run.json
```

## Pipeline fail-closed guard

The agent-orchestrated step chain (parent run + 10 step issues) must never advance a step to
`done` without proof of work. `src/pipeline-guard.js` enforces gate propagation, publish
proof-of-work, and the dedup-log precondition; step agents run `scripts/pipeline-guard-check.mjs`
to compute their allowed disposition. See [docs/pipeline-fail-closed.md](./docs/pipeline-fail-closed.md).

## Secrets

- `FACEBOOK_PAGE_ID`
- `FACEBOOK_SYSTEM_USER_TOKEN` or `FACEBOOK_PAGE_ACCESS_TOKEN`
- `DATABASE_URL`
- `FACEBOOK_PUBLICATIONS_TABLE`
- `FACEBOOK_RUNS_TABLE`

## PostgreSQL tables

The runtime creates the target tables automatically if they do not already exist.

- Publications table: one row per normalized article URL, used for dedupe and publish state
- Runs table: one row per routine run with the full structured result payload in `JSONB`

The configured table names must be plain identifiers like `facebook_publications` or schema-qualified identifiers like `public.facebook_publications`.

## Smoke path

1. Provide a candidate JSON file with at least one publishable story.
2. Export the Facebook and PostgreSQL secrets above.
3. Run `node ./src/cli.js --candidates ./fixtures/candidates.json --database-url "$DATABASE_URL" --publications-table "$FACEBOOK_PUBLICATIONS_TABLE" --runs-table "$FACEBOOK_RUNS_TABLE" --run-log ./logs/run.json`.
4. Inspect `./logs/run.json` for the selected story, duplicate URLs, evaluation scores, and Facebook post id.
5. Inspect the configured PostgreSQL tables for the persisted dedupe row and run audit payload.
