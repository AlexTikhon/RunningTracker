ALTER TABLE runs
ADD CONSTRAINT runs_start_within_auto_finish_window CHECK (
  started_at <= created_at + INTERVAL '24 hours'
);
