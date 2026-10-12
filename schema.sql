-- Run once against the project's Cloudflare D1 database.
CREATE TABLE IF NOT EXISTS cheat_authorized_players (
  player_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_cheat_authorized_players_enabled
  ON cheat_authorized_players(enabled);
