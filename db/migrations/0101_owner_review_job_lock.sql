-- Hold-only lock for owner review (2026-09-29). Owner acceptance inserts a
-- review command whose foreign key takes a key-share on the reviewed job. It
-- must take that key-share before the tenant completion-gate integrity row,
-- because quality inspection holds the job FOR UPDATE before the same gate row.
-- This column can never change; it grants row-lock ability, not job mutation.
SET lock_timeout = '5s';
SET statement_timeout = '120s';

ALTER TABLE control_jobs ADD COLUMN web_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_jobs_web_lock CHECK (web_lock IS FALSE);
