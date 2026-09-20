CREATE TABLE IF NOT EXISTS reminders (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  start_local   TEXT NOT NULL,            -- wall clock "YYYY-MM-DDTHH:MM" in tz
  tz            TEXT NOT NULL,            -- IANA zone the wall clock refers to
  rule          TEXT NOT NULL,            -- JSON: {"type":"none"|"daily"|"weekly"|"monthly"|"yearly"|"weekdays","days":[..]|"custom","every":n,"unit":"day|week|month"}
  enabled       INTEGER NOT NULL DEFAULT 1,
  next_at       INTEGER,                  -- epoch ms of the next send; NULL = nothing scheduled
  last_fired_at INTEGER,                  -- epoch ms of the last send
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (next_at) WHERE enabled = 1 AND next_at IS NOT NULL;
