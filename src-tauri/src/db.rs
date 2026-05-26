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
    pub folder: Option<String>,
    pub user_tags: Vec<String>,
    pub watched: bool,
    pub favorite: bool,
    pub added_at: i64,
    pub channel_url: Option<String>,
    pub channel_id: Option<String>,
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
    add_column_if_missing(&conn, "channel_videos", "upload_timestamp", "INTEGER")?;
    add_column_if_missing(&conn, "channel_videos", "seen_at", "INTEGER")?;
    add_column_if_missing(&conn, "channels", "category", "TEXT")?;
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
}

pub fn insert_video(conn: &Connection, v: NewVideo<'_>) -> Result<i64> {
    let now = unix_now();
    let raw_tags_json = serde_json::to_string(v.raw_tags)?;
    conn.execute(
        r#"INSERT INTO videos
            (url, source, video_id, title, description, thumbnail_url, uploader,
             duration, upload_date, category, raw_tags, added_at, channel_url, channel_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"#,
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
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn insert_video_at(conn: &Connection, v: NewVideo<'_>, added_at: i64) -> Result<i64> {
    let raw_tags_json = serde_json::to_string(v.raw_tags)?;
    conn.execute(
        r#"INSERT INTO videos
            (url, source, video_id, title, description, thumbnail_url, uploader,
             duration, upload_date, category, raw_tags, added_at, channel_url, channel_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"#,
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
                  duration, upload_date, category, raw_tags, folder, watched, favorite,
                  added_at, channel_url, channel_id
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
                  duration, upload_date, category, raw_tags, folder, watched, favorite,
                  added_at, channel_url, channel_id
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
        folder: r.get("folder")?,
        user_tags: Vec::new(),
        watched: watched_int != 0,
        favorite: favorite_int != 0,
        added_at: r.get("added_at")?,
        channel_url: r.get("channel_url").ok(),
        channel_id: r.get("channel_id").ok(),
    })
}

pub fn delete_video(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM videos WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_folder(conn: &Connection, id: i64, folder: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE videos SET folder = ?1 WHERE id = ?2",
        params![folder, id],
    )?;
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

pub fn add_tag(conn: &Connection, video_id: i64, name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO tags(name) VALUES (?1)",
        params![name],
    )?;
    let tag_id: i64 = conn.query_row(
        "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
        params![name],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO video_tags(video_id, tag_id) VALUES (?1, ?2)",
        params![video_id, tag_id],
    )?;
    Ok(())
}

pub fn remove_tag(conn: &Connection, video_id: i64, name: &str) -> Result<()> {
    conn.execute(
        r#"DELETE FROM video_tags
           WHERE video_id = ?1
             AND tag_id = (SELECT id FROM tags WHERE name = ?2 COLLATE NOCASE)"#,
        params![video_id, name],
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

pub fn list_folders(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT folder FROM videos
         WHERE folder IS NOT NULL AND folder != ''
         ORDER BY folder COLLATE NOCASE",
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
        r#"INSERT INTO channels (url, source, channel_id, name, thumbnail_url, followed_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
        params![c.url, c.source, c.channel_id, c.name, c.thumbnail_url, now],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn delete_channel(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM channels WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn get_channel(conn: &Connection, id: i64) -> Result<Option<Channel>> {
    let row = conn
        .query_row(
            r#"SELECT c.id, c.url, c.source, c.channel_id, c.name, c.thumbnail_url,
                      c.category, c.followed_at, c.last_checked_at,
                      (SELECT COUNT(*) FROM channel_videos cv
                       WHERE cv.channel_id = c.id
                         AND cv.dismissed = 0
                         AND cv.seen_at IS NULL
                         AND cv.upload_timestamp IS NOT NULL
                         AND cv.upload_timestamp >= (strftime('%s', 'now') - 14 * 86400)
                         AND cv.url NOT IN (SELECT url FROM videos)) AS inbox_count
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
                  c.category, c.followed_at, c.last_checked_at,
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
             dismissed, auto_dismissed_at_follow, timestamp_verified)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0)"#,
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
                  cv.first_seen_at, cv.seen_at, cv.dismissed,
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
    })
}

pub fn get_channel_video(conn: &Connection, id: i64) -> Result<Option<ChannelVideo>> {
    let row = conn
        .query_row(
            r#"SELECT cv.id, cv.channel_id, c.name AS channel_name, c.url AS channel_url,
                      cv.video_external_id, cv.url, cv.title, cv.thumbnail_url,
                      cv.duration, cv.upload_date, cv.upload_timestamp,
                      cv.first_seen_at, cv.dismissed,
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
