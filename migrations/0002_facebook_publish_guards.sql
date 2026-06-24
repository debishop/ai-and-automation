-- THEAAAAA-586: pre-publish content-hash idempotency guard for the Lens FB publisher.
-- Records (content_hash, page_id, published_at, post_id, is_dry_run) so the publisher
-- can fail-closed when the same caption+media+page would re-publish within a short window
-- (15 minutes). Separate from `public.facebook_publications` (which dedup-logs on
-- normalized_url after a successful publish) so the guard fires BEFORE the start phase.

BEGIN;

CREATE TABLE IF NOT EXISTS public.facebook_publish_guards (
  guard_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_hash   text NOT NULL,
  page_id        text NOT NULL,
  published_at   timestamptz NOT NULL DEFAULT now(),
  post_id        text,
  is_dry_run     boolean NOT NULL DEFAULT false,
  note           text
);

CREATE INDEX IF NOT EXISTS facebook_publish_guards_lookup_idx
  ON public.facebook_publish_guards (content_hash, page_id, is_dry_run, published_at DESC);

COMMIT;
