-- VidMinder web schema (Cloudflare D1 / SQLite).
-- Mirrors the desktop app's schema (src-tauri/src/db.rs) with a user_id scope
-- on every root table, plus users/sessions for in-app auth. Offline-download
-- columns are omitted — the Worker synthesizes offline_status:'none' so the
-- shared frontend's Video shape stays identical.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  lookback_days INTEGER NOT NULL DEFAULT 14,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS videos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'youtube',
  video_id      TEXT,
  title         TEXT NOT NULL,
  description   TEXT,
  thumbnail_url TEXT,
  uploader      TEXT,
  duration      INTEGER,
  upload_date   TEXT,
  category      TEXT,
  raw_tags      TEXT NOT NULL DEFAULT '[]',
  watched       INTEGER NOT NULL DEFAULT 0,
  favorite      INTEGER NOT NULL DEFAULT 0,
  is_short      INTEGER NOT NULL DEFAULT 0,
  added_at      INTEGER NOT NULL,
  channel_url   TEXT,
  channel_id    TEXT,
  UNIQUE (user_id, url)
);
CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id);
CREATE INDEX IF NOT EXISTS idx_videos_user_vid ON videos(user_id, video_id);

CREATE TABLE IF NOT EXISTS tags (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT NOT NULL COLLATE NOCASE,
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS video_tags (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url              TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'youtube',
  channel_id       TEXT NOT NULL,
  name             TEXT NOT NULL,
  thumbnail_url    TEXT,
  category         TEXT,
  description      TEXT,
  subscriber_count INTEGER,
  followed_at      INTEGER NOT NULL,
  last_checked_at  INTEGER,
  UNIQUE (user_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);

CREATE TABLE IF NOT EXISTS channel_videos (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id               INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  video_external_id        TEXT NOT NULL,
  url                      TEXT NOT NULL,
  title                    TEXT NOT NULL,
  thumbnail_url            TEXT,
  duration                 INTEGER,
  upload_date              TEXT,
  upload_timestamp         INTEGER,
  first_seen_at            INTEGER NOT NULL,
  seen_at                  INTEGER,
  dismissed                INTEGER NOT NULL DEFAULT 0,
  auto_dismissed_at_follow INTEGER NOT NULL DEFAULT 0,
  is_short                 INTEGER NOT NULL DEFAULT 0,
  UNIQUE (channel_id, video_external_id)
);
CREATE INDEX IF NOT EXISTS idx_cv_channel ON channel_videos(channel_id, dismissed);
