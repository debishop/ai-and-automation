-- THEAAAAA-498: VEP pipeline schema.
-- Tables: vep_runs, vep_publish_attempts, vep_performance_snapshots, vep_run_status_events.
-- Plan: /THEAAAAA/issues/THEAAAAA-496#document-plan (Section 15).

BEGIN;

CREATE TABLE IF NOT EXISTS public.vep_runs (
  run_id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type                     text NOT NULL CHECK (run_type IN ('scheduled','manual')),
  status                       text NOT NULL,
  started_at                   timestamptz NOT NULL DEFAULT now(),
  completed_at                 timestamptz,
  series_name                  text,
  topic                        text,
  topic_hash                   text GENERATED ALWAYS AS (lower(btrim(topic))) STORED,
  audience_problem             text,
  technical_principle          text,
  inspirational_lesson         text,
  top_headline                 text,
  bottom_headline              text,
  footer_principle             text,
  visual_comparison            jsonb,
  caption                      text,
  discussion_question          text,
  core_hashtags                text[],
  topic_hashtags               text[],
  audience_mentions            text[],
  image_prompt                 text,
  image_url                    text,
  image_width                  int,
  image_height                 int,
  fact_check_result            jsonb,
  cco_approval_status          text,
  approver_agent_id            text,
  scheduled_publication_time   timestamptz,
  actual_publication_time      timestamptz,
  fb_post_id                   text,
  fb_post_url                  text,
  publishing_result            text,
  failure_reason               text,
  retry_count                  int NOT NULL DEFAULT 0,
  lessons_learned              text
);

-- Section 15 unique guard: one publish per (day, topic_hash).
-- date_trunc(timestamptz) is STABLE (timezone-dependent); cast to UTC date so the expression
-- is IMMUTABLE and indexable. Day-bucketing semantics unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS vep_runs_day_topic_uniq
  ON public.vep_runs ((((scheduled_publication_time AT TIME ZONE 'UTC')::date)), topic_hash)
  WHERE scheduled_publication_time IS NOT NULL AND topic_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS vep_runs_status_started_idx
  ON public.vep_runs (status, started_at DESC);

CREATE INDEX IF NOT EXISTS vep_runs_fb_post_id_idx
  ON public.vep_runs (fb_post_id) WHERE fb_post_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS public.vep_publish_attempts (
  attempt_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                  uuid NOT NULL REFERENCES public.vep_runs(run_id) ON DELETE CASCADE,
  attempted_at            timestamptz NOT NULL DEFAULT now(),
  outcome                 text NOT NULL,
  fb_response             jsonb,
  error                   text,
  confirmed_not_published boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS vep_publish_attempts_run_idx
  ON public.vep_publish_attempts (run_id, attempted_at);


CREATE TABLE IF NOT EXISTS public.vep_performance_snapshots (
  snapshot_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES public.vep_runs(run_id) ON DELETE CASCADE,
  interval          text NOT NULL CHECK (interval IN ('24h','72h','7d')),
  taken_at          timestamptz NOT NULL DEFAULT now(),
  reach             int,
  reactions         int NOT NULL DEFAULT 0,
  comments          int NOT NULL DEFAULT 0,
  shares            int NOT NULL DEFAULT 0,
  clicks            int,
  new_followers     int,
  engagement_score  int GENERATED ALWAYS AS (reactions + (comments * 3) + (shares * 5)) STORED,
  raw               jsonb,
  UNIQUE (run_id, interval)
);


CREATE TABLE IF NOT EXISTS public.vep_run_status_events (
  event_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES public.vep_runs(run_id) ON DELETE CASCADE,
  status           text NOT NULL,
  actor_agent_id   text,
  changed_at       timestamptz NOT NULL DEFAULT now(),
  note             text
);

CREATE INDEX IF NOT EXISTS vep_run_status_events_run_idx
  ON public.vep_run_status_events (run_id, changed_at);

COMMIT;
