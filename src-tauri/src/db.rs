use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Video {
    pub id: i64,
    pub url: String,
    pub source: String,
    pub video_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub thumbnail_url: Option<String>,
    pub uploader: Option<String>,
    pub duration: Option<i64>,
    pub upload_date: Option<String>,
    pub category: Option<String>,
    pub raw_tags: Vec<String>,
    pub user_tags: Vec<String>,
    pub watched: bool,
    pub favorite: bool,
    pub added_at: i64,
    pub channel_url: Option<String>,
    pub channel_id: Option<String>,
    /// Offline-download state. `offline_status` is one of "none",
    /// "downloading", "ready", or "error". The remaining fields are populated
    /// only when a download has succeeded (status "ready").
    pub offline_status: String,
    pub offline_path: Option<String>,
    pub offline_quality: Option<String>,
    pub offline_size: Option<i64>,
    pub offline_downloaded_at: Option<i64>,
    /// True for YouTube Shorts.
    pub is_short: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Channel {
    pub id: i64,
    pub url: String,
    pub source: String,
    pub channel_id: Option<String>,
    pub name: String,
    pub thumbnail_url: Option<String>,
    pub category: Option<String>,
    pub description: Option<String>,
    pub subscriber_count: Option<i64>,
    pub followed_at: i64,
    pub last_checked_at: Option<i64>,
    pub inbox_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChannelVideo {
    pub id: i64,
    pub channel_id: i64,
    pub channel_name: String,
    pub channel_url: String,
    pub video_external_id: String,
    pub url: String,
    pub title: String,
    pub thumbnail_url: Option<String>,
    pub duration: Option<i64>,
    pub upload_date: Option<String>,
    pub upload_timestamp: Option<i64>,
    pub first_seen_at: i64,
    pub seen_at: Option<i64>,
    pub dismissed: bool,
    pub in_library: bool,
    pub is_short: bool,
}

pub fn open_db() -> Result<Db> {
    let dir = data_dir().context("locating data dir")?;
    std::fs::create_dir_all(&dir).context("creating data dir")?;
    let path = dir.join("vidminder.sqlite");
    let conn = Connection::open(&path).with_context(|| format!("opening {}", path.display()))?;
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL UNIQUE,
            source TEXT NOT NULL,
            video_id TEXT,
            title TEXT NOT NULL,
            description TEXT,
            thumbnail_url TEXT,
            uploader TEXT,
            duration INTEGER,
            upload_date TEXT,
            category TEXT,
            raw_tags TEXT NOT NULL DEFAULT '[]',
            folder TEXT,
            watched INTEGER NOT NULL DEFAULT 0,
            added_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE
        );

        CREATE TABLE IF NOT EXISTS video_tags (
            video_id INTEGER NOT NULL,
            tag_id INTEGER NOT NULL,
            PRIMARY KEY (video_id, tag_id),
            FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL UNIQUE,
            source TEXT NOT NULL,
            channel_id TEXT,
            name TEXT NOT NULL,
            thumbnail_url TEXT,
            followed_at INTEGER NOT NULL,
            last_checked_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS channel_videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL,
            video_external_id TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            thumbnail_url TEXT,
            duration INTEGER,
            upload_date TEXT,
            first_seen_at INTEGER NOT NULL,
            dismissed INTEGER NOT NULL DEFAULT 0,
            UNIQUE (channel_id, video_external_id),
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_videos_folder ON videos(folder);
        CREATE INDEX IF NOT EXISTS idx_videos_category ON videos(category);
        CREATE INDEX IF NOT EXISTS idx_videos_added_at ON videos(added_at DESC);
        CREATE INDEX IF NOT EXISTS idx_channel_videos_channel ON channel_videos(channel_id, dismissed);
        CREATE INDEX IF NOT EXISTS idx_channel_videos_first_seen ON channel_videos(first_seen_at DESC);
        "#,
    )
    .context("initializing schema")?;

    // Idempotent column additions for older databases.
    add_column_if_missing(&conn, "videos", "channel_url", "TEXT")?;
    add_column_if_missing(&conn, "videos", "channel_id", "TEXT")?;
    add_column_if_missing(&conn, "videos", "favorite", "INTEGER NOT NULL DEFAULT 0")?;
    // Offline-download state. `offline_status` defaults to 'none'; the rest stay
    // NULL until a download succeeds.
    add_column_if_missing(&conn, "videos", "offline_status", "TEXT NOT NULL DEFAULT 'none'")?;
    add_column_if_missing(&conn, "videos", "offline_path", "TEXT")?;
    add_column_if_missing(&conn, "videos", "offline_quality", "TEXT")?;
    add_column_if_missing(&conn, "videos", "offline_size", "INTEGER")?;
    add_column_if_missing(&conn, "videos", "offline_downloaded_at", "INTEGER")?;
    add_column_if_missing(&conn, "channel_videos", "upload_timestamp", "INTEGER")?;
    add_column_if_missing(&conn, "channel_videos", "seen_at", "INTEGER")?;
    // Whether an item is a YouTube Short. Fetched in the background regardless;
    // a user preference governs whether they appear in the lists.
    add_column_if_missing(&conn, "channel_videos", "is_short", "INTEGER NOT NULL DEFAULT 0")?;
    add_column_if_missing(&conn, "videos", "is_short", "INTEGER NOT NULL DEFAULT 0")?;
    add_column_if_missing(&conn, "channels", "category", "TEXT")?;
    add_column_if_missing(&conn, "channels", "description", "TEXT")?;
    add_column_if_missing(&conn, "channels", "subscriber_count", "INTEGER")?;
    // One-time wipe: every existing upload_timestamp predates the
    // "RSS-as-sole-truth" rule and was sourced from yt-dlp's approximate_date
    // heuristic, which is wildly wrong for older videos. Force RSS to repopulate.
    let added_verified = add_column_if_missing_returning(
        &conn,
        "channel_videos",
        "timestamp_verified",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    if added_verified {
        conn.execute("UPDATE channel_videos SET upload_timestamp = NULL", [])
            .context("wiping pre-RSS upload_timestamps")?;
    }
    let added_auto_dismissed = add_column_if_missing_returning(
        &conn,
        "channel_videos",
        "auto_dismissed_at_follow",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    if added_auto_dismissed {
        // Backfill: any rows already in the dismissed state at the moment this
        // column was added were dismissed by the original "pre-dismiss at
        // follow" behavior — never by the user. Mark them so the new auto
        // catch-up surfaces them on the next refresh.
        conn.execute(
            "UPDATE channel_videos SET auto_dismissed_at_follow = 1 WHERE dismissed = 1",
            [],
        )
        .context("backfilling auto_dismissed_at_follow")?;
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_videos_favorite ON videos(favorite) WHERE favorite = 1;",
    )
    .context("favorite index")?;

    // Playlists were superseded by the dotted-tag tree. Drop legacy tables on
    // first run after the upgrade so they stop appearing in introspection;
    // existing playlist memberships are not migrated (per project decision).
    conn.execute_batch(
        "DROP TABLE IF EXISTS playlist_videos;\n\
         DROP TABLE IF EXISTS playlists;",
    )
    .context("dropping legacy playlist tables")?;
    Ok(Db(Mutex::new(conn)))
}

fn add_column_if_missing(conn: &Connection, table: &str, column: &str, ty: &str) -> Result<()> {
    add_column_if_missing_returning(conn, table, column, ty).map(|_| ())
}

/// Like add_column_if_missing, but returns true if the column was actually
/// added (so callers can run one-time backfills).
fn add_column_if_missing_returning(
    conn: &Connection,
    table: &str,
    column: &str,
    ty: &str,
) -> Result<bool> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2",
            params![table, column],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_none() {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {ty}"),
            [],
        )?;
        Ok(true)
    } else {
        Ok(false)
    }
}

fn data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("VidMinder"))
}

pub struct NewVideo<'a> {
    pub url: &'a str,
    pub source: &'a str,
    pub video_id: Option<&'a str>,
    pub title: &'a str,
    pub description: Option<&'a str>,
    pub thumbnail_url: Option<&'a str>,
    pub uploader: Option<&'a str>,
    pub duration: Option<i64>,
    pub upload_date: Option<&'a str>,
    pub category: Option<&'a str>,
    pub raw_tags: &'a [String],
    pub channel_url: Option<&'a str>,
    pub channel_id: Option<&'a str>,
    pub is_short: bool,
}

pub fn insert_video(conn: &Connection, v: NewVideo<'_>) -> Result<i64> {
    let now = unix_now();
    let raw_tags_json = serde_json::to_string(v.raw_tags)?;
    conn.execute(
        r#"INSERT INTO videos
            (url, source, video_id, title, description, thumbnail_url, uploader,
             duration, upload_date, category, raw_tags, added_at, channel_url, channel_id,
             is_short)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"#,
        params![
            v.url,
            v.source,
            v.video_id,
            v.title,
            v.description,
            v.thumbnail_url,
            v.uploader,
            v.duration,
            v.upload_date,
            v.category,
            raw_tags_json,
            now,
            v.channel_url,
            v.channel_id,
            v.is_short as i64,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn insert_video_at(conn: &Connection, v: NewVideo<'_>, added_at: i64) -> Result<i64> {
    let raw_tags_json = serde_json::to_string(v.raw_tags)?;
    conn.execute(
        r#"INSERT INTO videos
            (url, source, video_id, title, description, thumbnail_url, uploader,
             duration, upload_date, category, raw_tags, added_at, channel_url, channel_id,
             is_short)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"#,
        params![
            v.url,
            v.source,
            v.video_id,
            v.title,
            v.description,
            v.thumbnail_url,
            v.uploader,
            v.duration,
            v.upload_date,
            v.category,
            raw_tags_json,
            added_at,
            v.channel_url,
            v.channel_id,
            v.is_short as i64,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn find_video_by_url(conn: &Connection, url: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT id FROM videos WHERE url = ?1",
            params![url],
            |r| r.get::<_, i64>(0),
        )
        .optional()?)
}

pub fn get_video(conn: &Connection, id: i64) -> Result<Option<Video>> {
    let mut stmt = conn.prepare(
        r#"SELECT id, url, source, video_id, title, description, thumbnail_url, uploader,
                  duration, upload_date, category, raw_tags, watched, favorite,
                  added_at, channel_url, channel_id, offline_status, offline_path,
                  offline_quality, offline_size, offline_downloaded_at, is_short
           FROM videos WHERE id = ?1"#,
    )?;
    let row = stmt
        .query_row(params![id], |r| Ok(row_to_video(r)))
        .optional()?;
    match row {
        Some(Ok(mut v)) => {
            v.user_tags = list_tags_for_video(conn, v.id)?;
            Ok(Some(v))
        }
        Some(Err(e)) => Err(e.into()),
        None => Ok(None),
    }
}

pub fn list_videos(conn: &Connection) -> Result<Vec<Video>> {
    let mut stmt = conn.prepare(
        r#"SELECT id, url, source, video_id, title, description, thumbnail_url, uploader,
                  duration, upload_date, category, raw_tags, watched, favorite,
                  added_at, channel_url, channel_id, offline_status, offline_path,
                  offline_quality, offline_size, offline_downloaded_at, is_short
           FROM videos
           ORDER BY added_at DESC"#,
    )?;
    let rows = stmt.query_map([], |r| Ok(row_to_video(r)))?;
    let mut out = Vec::new();
    for row in rows {
        let mut v = row??;
        v.user_tags = list_tags_for_video(conn, v.id)?;
        out.push(v);
    }
    Ok(out)
}

fn row_to_video(r: &rusqlite::Row<'_>) -> rusqlite::Result<Video> {
    let raw_tags_json: String = r.get("raw_tags")?;
    let raw_tags: Vec<String> = serde_json::from_str(&raw_tags_json).unwrap_or_default();
    let watched_int: i64 = r.get("watched")?;
    let favorite_int: i64 = r.get("favorite").unwrap_or(0);
    Ok(Video {
        id: r.get("id")?,
        url: r.get("url")?,
        source: r.get("source")?,
        video_id: r.get("video_id")?,
        title: r.get("title")?,
        description: r.get("description")?,
        thumbnail_url: r.get("thumbnail_url")?,
        uploader: r.get("uploader")?,
        duration: r.get("duration")?,
        upload_date: r.get("upload_date")?,
        category: r.get("category")?,
        raw_tags,
        user_tags: Vec::new(),
        watched: watched_int != 0,
        favorite: favorite_int != 0,
        added_at: r.get("added_at")?,
        channel_url: r.get("channel_url").ok(),
        channel_id: r.get("channel_id").ok(),
        offline_status: r
            .get::<_, String>("offline_status")
            .unwrap_or_else(|_| "none".to_string()),
        offline_path: r.get("offline_path").ok().flatten(),
        offline_quality: r.get("offline_quality").ok().flatten(),
        offline_size: r.get("offline_size").ok().flatten(),
        offline_downloaded_at: r.get("offline_downloaded_at").ok().flatten(),
        is_short: r.get::<_, i64>("is_short").unwrap_or(0) != 0,
    })
}

/// Mark a video's download state. Used to flip to "downloading"/"error".
pub fn set_offline_status(conn: &Connection, id: i64, status: &str) -> Result<()> {
    conn.execute(
        "UPDATE videos SET offline_status = ?1 WHERE id = ?2",
        params![status, id],
    )?;
    Ok(())
}

/// Record a completed download: path, quality label, byte size, timestamp.
pub fn set_offline_ready(
    conn: &Connection,
    id: i64,
    path: &str,
    quality: &str,
    size: i64,
) -> Result<()> {
    conn.execute(
        r#"UPDATE videos
           SET offline_status = 'ready', offline_path = ?1, offline_quality = ?2,
               offline_size = ?3, offline_downloaded_at = ?4
           WHERE id = ?5"#,
        params![path, quality, size, unix_now(), id],
    )?;
    Ok(())
}

/// Clear offline state back to "none" and return the previous file path (if any)
/// so the caller can unlink it from disk.
pub fn clear_offline(conn: &Connection, id: i64) -> Result<Option<String>> {
    let prev: Option<String> = conn
        .query_row(
            "SELECT offline_path FROM videos WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    conn.execute(
        r#"UPDATE videos
           SET offline_status = 'none', offline_path = NULL, offline_quality = NULL,
               offline_size = NULL, offline_downloaded_at = NULL
           WHERE id = ?1"#,
        params![id],
    )?;
    Ok(prev)
}

/// The current offline file path for a video, if downloaded.
pub fn get_offline_path(conn: &Connection, id: i64) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT offline_path FROM videos WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

pub fn delete_video(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM videos WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_watched(conn: &Connection, id: i64, watched: bool) -> Result<()> {
    conn.execute(
        "UPDATE videos SET watched = ?1 WHERE id = ?2",
        params![watched as i64, id],
    )?;
    Ok(())
}

pub fn set_favorite(conn: &Connection, id: i64, favorite: bool) -> Result<()> {
    conn.execute(
        "UPDATE videos SET favorite = ?1 WHERE id = ?2",
        params![favorite as i64, id],
    )?;
    Ok(())
}

// === Tags: dotted-namespace, Calibre-style ===============================
//
// Tags are stored as flat dotted strings in `tags.name`. The hierarchy is
// derived at render time on the frontend from the dotted string itself
// ("science.biology" is a child of "science"). Operations that touch a tag
// also touch its descendants — `delete_tag("science")` removes "science",
// "science.biology", "science.biology.computational", etc., and renaming
// re-paths the whole subtree.
//
// Casing: the table's `UNIQUE COLLATE NOCASE` constraint enforces case-
// insensitive identity, but display casing is preserved as first-written.
// When a tag is created we canonicalize each dotted segment against the
// earliest-created casing already in use for that segment-path — so typing
// "science.biology" attaches as "Science.Biology" if those casings won
// earlier. Renaming a tag is the way to change canonical casing everywhere.

/// Normalize: trim each dotted segment, drop empties, rejoin with '.'.
/// "science . biology .. " -> "science.biology". Case preserved.
pub fn normalize_tag(t: &str) -> String {
    t.split('.')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(".")
}

/// Build lowercased-segment-path -> canonical (display-cased) path from all
/// existing tags. Earliest tag.id wins per path.
fn tag_canon_map(conn: &Connection) -> Result<std::collections::HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT name FROM tags ORDER BY id ASC")?;
    let existing: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    let mut canon = std::collections::HashMap::new();
    for t in &existing {
        let (mut acc, mut lacc) = (String::new(), String::new());
        for seg in t.split('.') {
            if acc.is_empty() {
                acc.push_str(seg);
                lacc.push_str(&seg.to_lowercase());
            } else {
                acc.push('.');
                acc.push_str(seg);
                lacc.push('.');
                lacc.push_str(&seg.to_lowercase());
            }
            canon.entry(lacc.clone()).or_insert_with(|| acc.clone());
        }
    }
    Ok(canon)
}

/// Canonicalize one (already-normalized) dotted tag against `canon`, registering
/// any new segment-paths so a multi-segment new tag stays self-consistent.
fn canon_apply(canon: &mut std::collections::HashMap<String, String>, tag: &str) -> String {
    let (mut out, mut lacc) = (String::new(), String::new());
    for seg in tag.split('.') {
        if lacc.is_empty() {
            lacc = seg.to_lowercase();
        } else {
            lacc.push('.');
            lacc.push_str(&seg.to_lowercase());
        }
        if let Some(c) = canon.get(&lacc) {
            out = c.clone();
        } else {
            if out.is_empty() {
                out = seg.to_string();
            } else {
                out.push('.');
                out.push_str(seg);
            }
            canon.insert(lacc.clone(), out.clone());
        }
    }
    out
}

/// Get-or-create a tag row for the given (already-canonical) name.
fn get_or_create_tag(conn: &Connection, name: &str) -> Result<i64> {
    conn.execute(
        "INSERT OR IGNORE INTO tags(name) VALUES (?1)",
        params![name],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
        params![name],
        |r| r.get(0),
    )?;
    Ok(id)
}

/// A distinct full tag and the number of videos carrying it exactly. The
/// frontend builds the dotted tree + inclusive parent counts from this.
#[derive(Debug, Serialize, Clone)]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

pub fn list_tag_counts(conn: &Connection) -> Result<Vec<TagCount>> {
    let mut stmt = conn.prepare(
        "SELECT t.name, COUNT(DISTINCT vt.video_id)
         FROM tags t
         JOIN video_tags vt ON vt.tag_id = t.id
         GROUP BY t.id
         ORDER BY t.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TagCount {
            tag: r.get(0)?,
            count: r.get(1)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Add one tag to one video. Normalizes + canonicalizes against existing tags.
pub fn add_tag(conn: &Connection, video_id: i64, name: &str) -> Result<()> {
    let t = normalize_tag(name);
    if t.is_empty() {
        return Ok(());
    }
    let mut canon = tag_canon_map(conn)?;
    let t = canon_apply(&mut canon, &t);
    let tag_id = get_or_create_tag(conn, &t)?;
    conn.execute(
        "INSERT OR IGNORE INTO video_tags(video_id, tag_id) VALUES (?1, ?2)",
        params![video_id, tag_id],
    )?;
    Ok(())
}

/// Remove one exact tag from one video (does NOT touch descendants — that's
/// `delete_tag`'s job, which acts library-wide).
pub fn remove_tag(conn: &Connection, video_id: i64, name: &str) -> Result<()> {
    let t = normalize_tag(name);
    if t.is_empty() {
        return Ok(());
    }
    conn.execute(
        r#"DELETE FROM video_tags
           WHERE video_id = ?1
             AND tag_id = (SELECT id FROM tags WHERE name = ?2 COLLATE NOCASE)"#,
        params![video_id, t],
    )?;
    Ok(())
}

/// Replace all of a video's tags with `tags` (normalized + canonicalized).
pub fn set_video_tags(conn: &Connection, video_id: i64, tags: &[String]) -> Result<()> {
    let mut canon = tag_canon_map(conn)?;
    conn.execute(
        "DELETE FROM video_tags WHERE video_id = ?1",
        params![video_id],
    )?;
    for t in tags {
        let t = normalize_tag(t);
        if t.is_empty() {
            continue;
        }
        let t = canon_apply(&mut canon, &t);
        let tag_id = get_or_create_tag(conn, &t)?;
        conn.execute(
            "INSERT OR IGNORE INTO video_tags(video_id, tag_id) VALUES (?1, ?2)",
            params![video_id, tag_id],
        )?;
    }
    Ok(())
}

/// Add one tag to many videos (bulk drag-to-tag from the sidebar).
pub fn add_tag_to_videos(conn: &Connection, video_ids: &[i64], tag: &str) -> Result<()> {
    let t = normalize_tag(tag);
    if t.is_empty() {
        return Ok(());
    }
    let mut canon = tag_canon_map(conn)?;
    let t = canon_apply(&mut canon, &t);
    let tag_id = get_or_create_tag(conn, &t)?;
    for &vid in video_ids {
        conn.execute(
            "INSERT OR IGNORE INTO video_tags(video_id, tag_id) VALUES (?1, ?2)",
            params![vid, tag_id],
        )?;
    }
    Ok(())
}

/// Rename `old` and every descendant tag (`old.…`) to sit under `new`, across
/// every video that carries them. Examples:
///   "science.bio" -> "science.biology"  also rewrites "science.bio.x".
///   "science"     -> "Science"          changes the capitalization everywhere.
///
/// Rename is authoritative about casing — it does NOT canonicalize against
/// existing tags (which would snap a case change back to the old spelling).
/// Each affected tag is renamed IN PLACE; if the new path collides with a
/// different existing tag, the two are merged instead.
pub fn rename_tag_in_db(conn: &Connection, old: &str, new: &str) -> Result<()> {
    let old = normalize_tag(old);
    let new = normalize_tag(new);
    // Exact (case-sensitive) equality is the only true no-op; a case-only
    // change like "science" -> "Science" must go through.
    if old.is_empty() || new.is_empty() || old == new {
        return Ok(());
    }
    let pattern = format!("{}.", old);
    let mut stmt = conn.prepare(
        "SELECT id, name FROM tags
         WHERE name = ?1 COLLATE NOCASE
            OR substr(name, 1, ?2) = ?3 COLLATE NOCASE",
    )?;
    let affected: Vec<(i64, String)> = stmt
        .query_map(params![&old, pattern.len() as i64, &pattern], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();
    for (old_id, old_name) in affected {
        // Sliced at the matched-prefix length (case-insensitive match — so we
        // use old_name's own prefix length, which equals old.len()).
        let suffix = if old_name.len() >= old.len() {
            &old_name[old.len()..]
        } else {
            ""
        };
        let new_name = normalize_tag(&format!("{}{}", new, suffix));
        // Is there a DIFFERENT existing tag already at the target path?
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
                params![&new_name],
                |r| r.get(0),
            )
            .optional()?;
        match existing {
            Some(other_id) if other_id != old_id => {
                // Merge into the existing tag, then drop the old one.
                conn.execute(
                    "INSERT OR IGNORE INTO video_tags(video_id, tag_id)
                     SELECT video_id, ?1 FROM video_tags WHERE tag_id = ?2",
                    params![other_id, old_id],
                )?;
                conn.execute("DELETE FROM video_tags WHERE tag_id = ?1", params![old_id])?;
                conn.execute("DELETE FROM tags WHERE id = ?1", params![old_id])?;
            }
            _ => {
                // Rename in place. Covers a case-only change (the row matches
                // itself NOCASE) and a move to a brand-new path; the NOCASE
                // UNIQUE index is satisfied since we update that same row.
                conn.execute(
                    "UPDATE tags SET name = ?1 WHERE id = ?2",
                    params![&new_name, old_id],
                )?;
            }
        }
    }
    Ok(())
}

/// Remove `tag` from every video.
///
/// For a SUB-TAG ("science.biology"): collapse the leaf segment instead of
/// hard-deleting — every affected path is rewritten with the deleted segment
/// stripped, so the parent ancestry survives:
///   "science.biology"               → "science"
///   "science.biology.computational" → "science.computational"
/// This is the Calibre intuition: removing a leaf folder should leave its
/// parent folder intact for items that lived there.
///
/// For a TOP-LEVEL tag ("science"): there's no parent to fall back to, so we
/// remove the tag and every descendant outright from every video.
pub fn delete_tag_in_db(conn: &Connection, tag: &str) -> Result<()> {
    let tag = normalize_tag(tag);
    if tag.is_empty() {
        return Ok(());
    }
    // Sub-tag: collapse to parent. Rename does the prefix rewrite for us —
    // exact-match rows become the parent, descendants get the deleted segment
    // spliced out (because rename rewrites `old.…` → `new.…`).
    if let Some(dot_idx) = tag.rfind('.') {
        let parent = tag[..dot_idx].to_string();
        return rename_tag_in_db(conn, &tag, &parent);
    }
    // Top-level: nuke the tag and its whole subtree from every video.
    let pattern = format!("{}.", tag);
    conn.execute(
        "DELETE FROM video_tags WHERE tag_id IN (
            SELECT id FROM tags
            WHERE name = ?1 COLLATE NOCASE
               OR substr(name, 1, ?2) = ?3 COLLATE NOCASE
         )",
        params![&tag, pattern.len() as i64, &pattern],
    )?;
    conn.execute(
        "DELETE FROM tags
         WHERE name = ?1 COLLATE NOCASE
            OR substr(name, 1, ?2) = ?3 COLLATE NOCASE",
        params![&tag, pattern.len() as i64, &pattern],
    )?;
    Ok(())
}

pub fn list_tags_for_video(conn: &Connection, video_id: i64) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        r#"SELECT t.name FROM tags t
           JOIN video_tags vt ON vt.tag_id = t.id
           WHERE vt.video_id = ?1
           ORDER BY t.name COLLATE NOCASE"#,
    )?;
    let rows = stmt.query_map(params![video_id], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn list_all_tags(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT t.name FROM tags t
         JOIN video_tags vt ON vt.tag_id = t.id
         ORDER BY t.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn list_categories(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT category FROM videos
         WHERE category IS NOT NULL AND category != ''
         ORDER BY category COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// --- Channels -----------------------------------------------------------------

pub struct NewChannel<'a> {
    pub url: &'a str,
    pub source: &'a str,
    pub channel_id: Option<&'a str>,
    pub name: &'a str,
    pub thumbnail_url: Option<&'a str>,
    pub description: Option<&'a str>,
    pub subscriber_count: Option<i64>,
}

pub fn find_channel_by_url(conn: &Connection, url: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT id FROM channels WHERE url = ?1",
            params![url],
            |r| r.get::<_, i64>(0),
        )
        .optional()?)
}

pub fn insert_channel(conn: &Connection, c: NewChannel<'_>) -> Result<i64> {
    let now = unix_now();
    conn.execute(
        r#"INSERT INTO channels
            (url, source, channel_id, name, thumbnail_url, description, subscriber_count, followed_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
        params![
            c.url,
            c.source,
            c.channel_id,
            c.name,
            c.thumbnail_url,
            c.description,
            c.subscriber_count,
            now
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn delete_channel(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM channels WHERE id = ?1", params![id])?;
    Ok(())
}

/// Refresh a channel's display metadata. NULL inputs keep the existing value
/// (so a refresh that doesn't return a field doesn't wipe it).
pub fn update_channel_meta(
    conn: &Connection,
    id: i64,
    thumbnail_url: Option<&str>,
    description: Option<&str>,
    subscriber_count: Option<i64>,
) -> Result<()> {
    conn.execute(
        r#"UPDATE channels
           SET thumbnail_url = COALESCE(?1, thumbnail_url),
               description = COALESCE(?2, description),
               subscriber_count = COALESCE(?3, subscriber_count)
           WHERE id = ?4"#,
        params![thumbnail_url, description, subscriber_count, id],
    )?;
    Ok(())
}

pub fn get_channel(conn: &Connection, id: i64) -> Result<Option<Channel>> {
    let row = conn
        .query_row(
            r#"SELECT c.id, c.url, c.source, c.channel_id, c.name, c.thumbnail_url,
                      c.category, c.description, c.subscriber_count, c.followed_at, c.last_checked_at,
                      (SELECT COUNT(*) FROM channel_videos cv
                       WHERE cv.channel_id = c.id
                         AND cv.dismissed = 0
                         AND cv.seen_at IS NULL
                         AND cv.upload_timestamp IS NOT NULL
                         AND cv.upload_timestamp >= (strftime('%s', 'now') - 14 * 86400)
                         AND cv.url NOT IN (SELECT url FROM videos)
                         AND cv.is_short = 0) AS inbox_count
               FROM channels c
               WHERE c.id = ?1"#,
            params![id],
            |r| Ok(channel_from_row(r)),
        )
        .optional()?;
    match row {
        Some(Ok(c)) => Ok(Some(c)),
        Some(Err(e)) => Err(e.into()),
        None => Ok(None),
    }
}

pub fn list_channels(conn: &Connection) -> Result<Vec<Channel>> {
    // The badge on each channel row counts items that are:
    //   - not dismissed
    //   - not yet seen
    //   - not already in the library
    //   - uploaded within the last 30 days (so "Earlier" backlog doesn't bloat
    //     the badge — older items still appear in the inbox but don't count)
    let mut stmt = conn.prepare(
        r#"SELECT c.id, c.url, c.source, c.channel_id, c.name, c.thumbnail_url,
                  c.category, c.description, c.subscriber_count, c.followed_at, c.last_checked_at,
                  (SELECT COUNT(*) FROM channel_videos cv
                   WHERE cv.channel_id = c.id
                     AND cv.dismissed = 0
                     AND cv.seen_at IS NULL
                     AND cv.upload_timestamp IS NOT NULL
                     AND cv.upload_timestamp >= (strftime('%s', 'now') - 14 * 86400)
                     AND cv.url NOT IN (SELECT url FROM videos)) AS inbox_count
           FROM channels c
           ORDER BY c.name COLLATE NOCASE"#,
    )?;
    let rows = stmt.query_map([], |r| Ok(channel_from_row(r)))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row??);
    }
    Ok(out)
}

fn channel_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Channel> {
    Ok(Channel {
        id: r.get("id")?,
        url: r.get("url")?,
        source: r.get("source")?,
        channel_id: r.get("channel_id")?,
        name: r.get("name")?,
        thumbnail_url: r.get("thumbnail_url")?,
        category: r.get("category").ok().flatten(),
        description: r.get("description").ok().flatten(),
        subscriber_count: r.get("subscriber_count").ok().flatten(),
        followed_at: r.get("followed_at")?,
        last_checked_at: r.get("last_checked_at").ok(),
        inbox_count: r.get("inbox_count").unwrap_or(0),
    })
}

pub fn set_channel_category(
    conn: &Connection,
    channel_id: i64,
    category: Option<&str>,
) -> Result<()> {
    let cleaned = category
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    conn.execute(
        "UPDATE channels SET category = ?1 WHERE id = ?2",
        params![cleaned, channel_id],
    )?;
    Ok(())
}

pub fn set_last_checked(conn: &Connection, channel_id: i64, when: i64) -> Result<()> {
    conn.execute(
        "UPDATE channels SET last_checked_at = ?1 WHERE id = ?2",
        params![when, channel_id],
    )?;
    Ok(())
}


pub struct NewChannelVideo<'a> {
    pub channel_id: i64,
    pub video_external_id: &'a str,
    pub url: &'a str,
    pub title: &'a str,
    pub thumbnail_url: Option<&'a str>,
    pub duration: Option<i64>,
    pub upload_date: Option<&'a str>,
    pub upload_timestamp: Option<i64>,
    pub dismissed: bool,
    pub is_short: bool,
}

pub struct UpsertResult {
    pub inserted: bool,
    #[allow(dead_code)]
    pub backfilled_timestamp: bool,
}

/// Insert a new entry, OR if it already exists, backfill missing timestamp/date
/// fields without touching the user's dismissed state.
///
/// The timestamp written here is treated as *unverified* — it might be a
/// rough estimate from yt-dlp's approximate_date heuristic. Callers should
/// follow up with `set_channel_video_timestamp` for entries they've confirmed
/// with a per-video fetch or RSS lookup, which flips `timestamp_verified=1`.
pub fn upsert_channel_video(conn: &Connection, v: NewChannelVideo<'_>) -> Result<UpsertResult> {
    let now = unix_now();
    let auto_dismissed_flag: i64 = if v.dismissed { 1 } else { 0 };
    let inserted = conn.execute(
        r#"INSERT OR IGNORE INTO channel_videos
            (channel_id, video_external_id, url, title, thumbnail_url,
             duration, upload_date, upload_timestamp, first_seen_at,
             dismissed, auto_dismissed_at_follow, is_short, timestamp_verified)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0)"#,
        params![
            v.channel_id,
            v.video_external_id,
            v.url,
            v.title,
            v.thumbnail_url,
            v.duration,
            v.upload_date,
            v.upload_timestamp,
            now,
            v.dismissed as i64,
            auto_dismissed_flag,
            v.is_short as i64,
        ],
    )?;
    if inserted > 0 {
        return Ok(UpsertResult { inserted: true, backfilled_timestamp: false });
    }
    // Row already existed — only update timestamp/date if currently null and
    // we now have a value. Do NOT change dismissed.
    let mut backfilled = false;
    if v.upload_timestamp.is_some() {
        // Backfill only when upload_timestamp is NULL; don't mark verified —
        // this is still the approximate-source path. set_channel_video_timestamp
        // is the only call that flips timestamp_verified to 1.
        let n = conn.execute(
            r#"UPDATE channel_videos
               SET upload_timestamp = ?1
               WHERE channel_id = ?2 AND video_external_id = ?3
                 AND upload_timestamp IS NULL"#,
            params![v.upload_timestamp, v.channel_id, v.video_external_id],
        )?;
        if n > 0 {
            backfilled = true;
        }
    }
    // Sync metadata that YouTube can change after the fact — channels
    // routinely rename videos and swap thumbnails after publication. Title,
    // thumbnail, and duration get overwritten from the channel listing on
    // every refresh; user-state fields (dismissed, seen_at, etc.) are not
    // touched.
    conn.execute(
        r#"UPDATE channel_videos
           SET title = ?1
           WHERE channel_id = ?2 AND video_external_id = ?3
             AND title IS NOT ?1"#,
        params![v.title, v.channel_id, v.video_external_id],
    )?;
    // Promote to Short if we now know it is one (e.g. first seen via /videos,
    // later confirmed via the /shorts tab). Never demote.
    if v.is_short {
        conn.execute(
            r#"UPDATE channel_videos
               SET is_short = 1
               WHERE channel_id = ?1 AND video_external_id = ?2 AND is_short = 0"#,
            params![v.channel_id, v.video_external_id],
        )?;
    }
    if v.thumbnail_url.is_some() {
        conn.execute(
            r#"UPDATE channel_videos
               SET thumbnail_url = ?1
               WHERE channel_id = ?2 AND video_external_id = ?3
                 AND thumbnail_url IS NOT ?1"#,
            params![v.thumbnail_url, v.channel_id, v.video_external_id],
        )?;
    }
    if v.duration.is_some() {
        conn.execute(
            r#"UPDATE channel_videos
               SET duration = ?1
               WHERE channel_id = ?2 AND video_external_id = ?3
                 AND duration IS NOT ?1"#,
            params![v.duration, v.channel_id, v.video_external_id],
        )?;
    }
    // If the video has already been added to the library, mirror the title/
    // thumbnail update into `videos` too — so renamed YouTube uploads stay
    // recognizable without forcing a delete + re-add.
    conn.execute(
        r#"UPDATE videos
           SET title = ?1,
               thumbnail_url = COALESCE(?2, thumbnail_url)
           WHERE url = ?3 AND title IS NOT ?1"#,
        params![v.title, v.thumbnail_url, v.url],
    )?;
    if v.upload_date.is_some() {
        conn.execute(
            r#"UPDATE channel_videos
               SET upload_date = ?1
               WHERE channel_id = ?2 AND video_external_id = ?3
                 AND upload_date IS NULL"#,
            params![v.upload_date, v.channel_id, v.video_external_id],
        )?;
    }
    Ok(UpsertResult { inserted: false, backfilled_timestamp: backfilled })
}

/// Un-dismiss entries for a channel that were originally auto-dismissed at
/// follow time and were uploaded within the given cutoff (Unix seconds).
/// Returns the number of rows un-dismissed. Anything the user explicitly
/// dismissed is left alone. Currently superseded by
/// `resurface_channel_recent` for the per-channel button; kept for
/// `catch_up_all_channels` symmetry and future fine-grained use.
#[allow(dead_code)]
pub fn catch_up_channel(
    conn: &Connection,
    channel_id: i64,
    cutoff_unix: i64,
) -> Result<i64> {
    let n = conn.execute(
        r#"UPDATE channel_videos
           SET dismissed = 0, auto_dismissed_at_follow = 0
           WHERE channel_id = ?1
             AND dismissed = 1
             AND auto_dismissed_at_follow = 1
             AND upload_timestamp IS NOT NULL
             AND upload_timestamp >= ?2
             AND url NOT IN (SELECT url FROM videos)"#,
        params![channel_id, cutoff_unix],
    )?;
    Ok(n as i64)
}

/// Catch up across every followed channel in one statement.
pub fn catch_up_all_channels(conn: &Connection, cutoff_unix: i64) -> Result<i64> {
    let n = conn.execute(
        r#"UPDATE channel_videos
           SET dismissed = 0, auto_dismissed_at_follow = 0
           WHERE dismissed = 1
             AND auto_dismissed_at_follow = 1
             AND upload_timestamp IS NOT NULL
             AND upload_timestamp >= ?1
             AND url NOT IN (SELECT url FROM videos)"#,
        params![cutoff_unix],
    )?;
    Ok(n as i64)
}

/// Aggressive resurface — un-dismiss every entry for the channel that's within
/// the cutoff window, including ones the user explicitly dismissed. Also
/// clears seen_at so the rows show as fresh again. Used by the per-channel
/// "Resurface recent" button.
pub fn resurface_channel_recent(
    conn: &Connection,
    channel_id: i64,
    cutoff_unix: i64,
) -> Result<i64> {
    let n = conn.execute(
        r#"UPDATE channel_videos
           SET dismissed = 0, auto_dismissed_at_follow = 0, seen_at = NULL
           WHERE channel_id = ?1
             AND upload_timestamp IS NOT NULL
             AND upload_timestamp >= ?2
             AND url NOT IN (SELECT url FROM videos)"#,
        params![channel_id, cutoff_unix],
    )?;
    Ok(n as i64)
}

pub fn list_inbox(conn: &Connection) -> Result<Vec<ChannelVideo>> {
    let mut stmt = conn.prepare(
        r#"SELECT cv.id, cv.channel_id, c.name AS channel_name, c.url AS channel_url,
                  cv.video_external_id, cv.url, cv.title, cv.thumbnail_url,
                  cv.duration, cv.upload_date, cv.upload_timestamp,
                  cv.first_seen_at, cv.seen_at, cv.dismissed, cv.is_short,
                  (cv.url IN (SELECT url FROM videos)) AS in_library
           FROM channel_videos cv
           JOIN channels c ON c.id = cv.channel_id
           WHERE cv.dismissed = 0
           ORDER BY COALESCE(cv.upload_timestamp, cv.first_seen_at) DESC, cv.id DESC"#,
    )?;
    let rows = stmt.query_map([], |r| Ok(channel_video_from_row(r)))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row??);
    }
    Ok(out)
}

#[allow(dead_code)]
pub fn count_inbox(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        r#"SELECT COUNT(*) FROM channel_videos cv
           WHERE cv.dismissed = 0
             AND cv.url NOT IN (SELECT url FROM videos)"#,
        [],
        |r| r.get::<_, i64>(0),
    )?)
}

fn channel_video_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ChannelVideo> {
    let dismissed_i: i64 = r.get("dismissed")?;
    let in_library_i: i64 = r.get("in_library")?;
    Ok(ChannelVideo {
        id: r.get("id")?,
        channel_id: r.get("channel_id")?,
        channel_name: r.get("channel_name")?,
        channel_url: r.get("channel_url")?,
        video_external_id: r.get("video_external_id")?,
        url: r.get("url")?,
        title: r.get("title")?,
        thumbnail_url: r.get("thumbnail_url")?,
        duration: r.get("duration")?,
        upload_date: r.get("upload_date")?,
        upload_timestamp: r.get("upload_timestamp").ok(),
        first_seen_at: r.get("first_seen_at")?,
        seen_at: r.get("seen_at").ok().flatten(),
        dismissed: dismissed_i != 0,
        in_library: in_library_i != 0,
        is_short: r.get::<_, i64>("is_short").unwrap_or(0) != 0,
    })
}

pub fn get_channel_video(conn: &Connection, id: i64) -> Result<Option<ChannelVideo>> {
    let row = conn
        .query_row(
            r#"SELECT cv.id, cv.channel_id, c.name AS channel_name, c.url AS channel_url,
                      cv.video_external_id, cv.url, cv.title, cv.thumbnail_url,
                      cv.duration, cv.upload_date, cv.upload_timestamp,
                      cv.first_seen_at, cv.dismissed, cv.is_short,
                      (cv.url IN (SELECT url FROM videos)) AS in_library
               FROM channel_videos cv
               JOIN channels c ON c.id = cv.channel_id
               WHERE cv.id = ?1"#,
            params![id],
            |r| Ok(channel_video_from_row(r)),
        )
        .optional()?;
    match row {
        Some(Ok(c)) => Ok(Some(c)),
        Some(Err(e)) => Err(e.into()),
        None => Ok(None),
    }
}

/// Apply an exact, RSS-sourced upload timestamp to a channel_video. Marks
/// the row as having a verified timestamp so the inbox views can trust it.
/// Set of `video_external_id` values for this channel where we already have a
/// verified timestamp. Used by the refresh loop to skip per-video yt-dlp
/// fetches for entries we've already accurately dated.
pub fn list_verified_video_ids(
    conn: &Connection,
    channel_id: i64,
) -> Result<std::collections::HashSet<String>> {
    let mut stmt = conn.prepare(
        "SELECT video_external_id FROM channel_videos
         WHERE channel_id = ?1 AND timestamp_verified = 1
           AND upload_timestamp IS NOT NULL",
    )?;
    let rows = stmt.query_map(params![channel_id], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn set_channel_video_timestamp(
    conn: &Connection,
    channel_id: i64,
    video_external_id: &str,
    timestamp: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE channel_videos
         SET upload_timestamp = ?1, timestamp_verified = 1
         WHERE channel_id = ?2 AND video_external_id = ?3",
        params![timestamp, channel_id, video_external_id],
    )?;
    Ok(())
}

pub fn dismiss_channel_video(conn: &Connection, id: i64) -> Result<()> {
    // An explicit dismiss clears the "auto-dismissed at follow" flag so the
    // automatic catch-up doesn't resurrect it on the next refresh.
    conn.execute(
        "UPDATE channel_videos
         SET dismissed = 1, auto_dismissed_at_follow = 0
         WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn undismiss_channel_video(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE channel_videos
         SET dismissed = 0, auto_dismissed_at_follow = 0
         WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn mark_channel_video_seen(conn: &Connection, id: i64, when: i64) -> Result<()> {
    conn.execute(
        "UPDATE channel_videos SET seen_at = ?1 WHERE id = ?2",
        params![when, id],
    )?;
    Ok(())
}

pub fn unmark_channel_video_seen(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE channel_videos SET seen_at = NULL WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn dismiss_all_for_channel(conn: &Connection, channel_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE channel_videos
         SET dismissed = 1, auto_dismissed_at_follow = 0
         WHERE channel_id = ?1",
        params![channel_id],
    )?;
    Ok(())
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT,
                 name TEXT NOT NULL UNIQUE COLLATE NOCASE);
             CREATE TABLE video_tags (video_id INTEGER NOT NULL, tag_id INTEGER NOT NULL,
                 PRIMARY KEY (video_id, tag_id));",
        )
        .unwrap();
        conn
    }

    fn tags_for(conn: &Connection, vid: i64) -> Vec<String> {
        let mut stmt = conn
            .prepare(
                "SELECT t.name FROM video_tags vt JOIN tags t ON t.id = vt.tag_id
                 WHERE vt.video_id = ?1 ORDER BY t.name",
            )
            .unwrap();
        stmt.query_map([vid], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    #[test]
    fn rename_repaths_tag_and_descendants_on_all_videos() {
        let conn = setup();
        // video 1: "science" + "science.biology"; video 2: "science.biology.cell"
        add_tag(&conn, 1, "science").unwrap();
        add_tag(&conn, 1, "science.biology").unwrap();
        add_tag(&conn, 2, "science.biology.cell").unwrap();

        rename_tag_in_db(&conn, "science", "physics").unwrap();

        assert_eq!(tags_for(&conn, 1), vec!["physics", "physics.biology"]);
        assert_eq!(tags_for(&conn, 2), vec!["physics.biology.cell"]);
    }

    #[test]
    fn rename_a_subtag_updates_videos() {
        let conn = setup();
        add_tag(&conn, 1, "science.biology").unwrap();
        add_tag(&conn, 2, "science.biology.cell").unwrap();

        rename_tag_in_db(&conn, "science.biology", "science.bio").unwrap();

        assert_eq!(tags_for(&conn, 1), vec!["science.bio"]);
        assert_eq!(tags_for(&conn, 2), vec!["science.bio.cell"]);
    }

    #[test]
    fn rename_changes_capitalization_everywhere() {
        let conn = setup();
        add_tag(&conn, 1, "science").unwrap();
        add_tag(&conn, 1, "science.biology").unwrap();
        add_tag(&conn, 2, "science.biology.cell").unwrap();

        rename_tag_in_db(&conn, "science", "Science").unwrap();

        assert_eq!(tags_for(&conn, 1), vec!["Science", "Science.biology"]);
        assert_eq!(tags_for(&conn, 2), vec!["Science.biology.cell"]);
    }

    #[test]
    fn rename_into_existing_tag_merges() {
        let conn = setup();
        add_tag(&conn, 1, "alpha").unwrap();
        add_tag(&conn, 1, "beta").unwrap();
        add_tag(&conn, 2, "alpha").unwrap();

        rename_tag_in_db(&conn, "alpha", "beta").unwrap();

        assert_eq!(tags_for(&conn, 1), vec!["beta"]);
        assert_eq!(tags_for(&conn, 2), vec!["beta"]);
    }
}
