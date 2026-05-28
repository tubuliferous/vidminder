mod db;
mod youtube_rss;
mod ytdlp;

use db::{Channel, ChannelVideo, Db, NewChannel, NewChannelVideo, NewVideo, Video};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex as AsyncMutex;

const INITIAL_REFRESH_DELAY_SECS: u64 = 8;
// Pull deep enough to cover at least the last month for typical channels.
// High-frequency channels (multiple uploads per day) may still get cut off,
// but most weekly/monthly channels' full month of uploads fits within 50.
const PER_CHANNEL_MAX_ENTRIES: usize = 50;
const RECENT_WINDOW_SECS: i64 = 14 * 24 * 60 * 60;

fn is_recent(timestamp: Option<i64>) -> bool {
    let Some(ts) = timestamp else { return false };
    let now = now_secs();
    ts > 0 && (now - ts) <= RECENT_WINDOW_SECS
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Generic(String),
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum IngestResult {
    Video(Video),
    Channel(Channel),
}

#[derive(Default)]
struct RefreshLock {
    inner: AsyncMutex<()>,
}

fn with_conn<F, T>(db: &State<'_, Db>, f: F) -> AppResult<T>
where
    F: FnOnce(&rusqlite::Connection) -> anyhow::Result<T>,
{
    let conn = db.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
    f(&conn).map_err(|e| AppError::Generic(format!("{e:#}")))
}

fn validate_http_url(raw: &str) -> AppResult<()> {
    let parsed = url::Url::parse(raw)
        .map_err(|e| AppError::Generic(format!("invalid URL: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::Generic(format!(
            "unsupported URL scheme: {}",
            parsed.scheme()
        )));
    }
    Ok(())
}

fn validate_youtube_url(raw: &str) -> AppResult<()> {
    validate_http_url(raw)?;
    let parsed = url::Url::parse(raw)
        .map_err(|e| AppError::Generic(format!("invalid URL: {e}")))?;
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    let supported = host == "youtube.com"
        || host == "youtu.be"
        || host.ends_with(".youtube.com");
    if !supported {
        return Err(AppError::Generic(format!(
            "Only YouTube URLs are supported right now (got {host}).",
        )));
    }
    Ok(())
}

async fn add_video_inner(url: &str, db: &Db) -> AppResult<Video> {
    {
        let conn = db.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
        if let Some(existing_id) = db::find_video_by_url(&conn, url)
            .map_err(|e| AppError::Generic(format!("{e:#}")))?
        {
            let v = db::get_video(&conn, existing_id)
                .map_err(|e| AppError::Generic(format!("{e:#}")))?
                .ok_or_else(|| AppError::Generic("video vanished".into()))?;
            return Ok(v);
        }
    }

    let info = ytdlp::fetch_info(url)
        .await
        .map_err(|e| AppError::Generic(format!("yt-dlp: {e:#}")))?;

    let title = info
        .title
        .clone()
        .unwrap_or_else(|| info.webpage_url.clone().unwrap_or_else(|| url.to_string()));
    let canonical_url = info
        .webpage_url
        .clone()
        .or_else(|| info.original_url.clone())
        .unwrap_or_else(|| url.to_string());
    let source = info.source();
    let thumb = info.best_thumbnail();
    let raw_tags = info.tags.clone().unwrap_or_default();
    let category = info.category();
    let uploader = info.uploader.clone().or_else(|| info.channel.clone());
    let duration = info.duration.map(|d| d.round() as i64);
    let channel_url = info
        .channel_url
        .clone()
        .or_else(|| info.uploader_url.clone());
    let channel_external_id = info
        .channel_id
        .clone()
        .or_else(|| info.uploader_id.clone());

    let id = {
        let conn = db.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
        if let Some(existing_id) = db::find_video_by_url(&conn, &canonical_url)
            .map_err(|e| AppError::Generic(format!("{e:#}")))?
        {
            existing_id
        } else {
            db::insert_video(
                &conn,
                NewVideo {
                    url: &canonical_url,
                    source: &source,
                    video_id: info.id.as_deref(),
                    title: &title,
                    description: info.description.as_deref(),
                    thumbnail_url: thumb.as_deref(),
                    uploader: uploader.as_deref(),
                    duration,
                    upload_date: info.upload_date.as_deref(),
                    category: category.as_deref(),
                    raw_tags: &raw_tags,
                    channel_url: channel_url.as_deref(),
                    channel_id: channel_external_id.as_deref(),
                },
            )
            .map_err(|e| AppError::Generic(format!("{e:#}")))?
        }
    };

    let v = {
        let conn = db.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
        db::get_video(&conn, id)
            .map_err(|e| AppError::Generic(format!("{e:#}")))?
            .ok_or_else(|| AppError::Generic("inserted video not found".into()))?
    };
    Ok(v)
}

async fn follow_channel_inner(url: &str, db: &Db) -> AppResult<Channel> {
    let mut listing = ytdlp::fetch_channel_listing(url, PER_CHANNEL_MAX_ENTRIES)
        .await
        .map_err(|e| AppError::Generic(format!("yt-dlp: {e:#}")))?;

    let canonical_url = listing.canonical_url().unwrap_or_else(|| url.to_string());
    let name = listing.name();
    let source = listing.source();
    let thumb = listing.best_thumbnail();
    let external_id = listing.channel_id.clone().or_else(|| listing.id.clone());

    // Replace approximate timestamps with exact ones from YouTube's RSS feed.
    // (channel_db_id isn't known yet at follow time — fall back to per-video
    //  fetches without the DB-cache shortcut)
    let verified_at_follow =
        enrich_timestamps(&mut listing.entries, external_id.as_deref(), -1, db).await;

    let channel_id = {
        let conn = db.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
        if let Some(existing) = db::find_channel_by_url(&conn, &canonical_url)
            .map_err(|e| AppError::Generic(format!("{e:#}")))?
        {
            existing
        } else {
            db::insert_channel(
                &conn,
                NewChannel {
                    url: &canonical_url,
                    source: &source,
                    channel_id: external_id.as_deref(),
                    name: &name,
                    thumbnail_url: thumb.as_deref(),
                },
            )
            .map_err(|e| AppError::Generic(format!("{e:#}")))?
        }
    };

    // Seed channel videos. Videos uploaded within the last RECENT_WINDOW_SECS
    // land in the inbox (dismissed=false); older ones are pre-dismissed so the
    // inbox doesn't flood with months of backlog.
    {
        let conn = db.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
        for entry in &listing.entries {
            let Some(ext_id) = entry.id.as_deref() else {
                continue;
            };
            let Some(page) = entry.webpage() else {
                continue;
            };
            let title = entry.title.clone().unwrap_or_else(|| ext_id.to_string());
            let ts = entry.timestamp;
            let _ = db::upsert_channel_video(
                &conn,
                NewChannelVideo {
                    channel_id,
                    video_external_id: ext_id,
                    url: &page,
                    title: &title,
                    thumbnail_url: entry.best_thumbnail().as_deref(),
                    duration: entry.duration.map(|d| d.round() as i64),
                    upload_date: entry.upload_date.as_deref(),
                    upload_timestamp: ts,
                    dismissed: !is_recent(ts),
                },
            );
        }
        // Promote verified timestamps for the entries we just inserted.
        for entry in &listing.entries {
            if let (Some(ext_id), Some(ts)) = (entry.id.as_deref(), entry.timestamp) {
                if verified_at_follow.contains(ext_id) {
                    let _ = db::set_channel_video_timestamp(&conn, channel_id, ext_id, ts);
                }
            }
        }
        db::set_last_checked(&conn, channel_id, now_secs())
            .map_err(|e| AppError::Generic(format!("{e:#}")))?;
    }

    let ch = {
        let conn = db.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
        db::get_channel(&conn, channel_id)
            .map_err(|e| AppError::Generic(format!("{e:#}")))?
            .ok_or_else(|| AppError::Generic("created channel missing".into()))?
    };
    Ok(ch)
}

#[tauri::command]
async fn add_video(url: String, db: State<'_, Db>) -> AppResult<Video> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err(AppError::Generic("empty URL".into()));
    }
    validate_youtube_url(&url)?;
    add_video_inner(&url, &db).await
}

#[tauri::command]
async fn ingest_url(
    url: String,
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<IngestResult> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err(AppError::Generic("empty URL".into()));
    }
    validate_youtube_url(&url)?;

    if ytdlp::looks_like_channel_url(&url) {
        let ch = follow_channel_inner(&url, &db).await?;
        let _ = app.emit("channels-changed", ());
        return Ok(IngestResult::Channel(ch));
    }

    let v = add_video_inner(&url, &db).await?;
    let _ = app.emit("videos-changed", ());
    Ok(IngestResult::Video(v))
}

#[tauri::command]
async fn follow_channel(
    url: String,
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<Channel> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err(AppError::Generic("empty URL".into()));
    }
    validate_youtube_url(&url)?;
    let ch = follow_channel_inner(&url, &db).await?;
    let _ = app.emit("channels-changed", ());
    Ok(ch)
}

#[tauri::command]
fn unfollow_channel(id: i64, app: AppHandle, db: State<'_, Db>) -> AppResult<()> {
    with_conn(&db, |conn| db::delete_channel(conn, id))?;
    let _ = app.emit("channels-changed", ());
    Ok(())
}

#[tauri::command]
fn list_channels(db: State<'_, Db>) -> AppResult<Vec<Channel>> {
    with_conn(&db, |conn| db::list_channels(conn))
}

#[tauri::command]
fn set_channel_category(
    id: i64,
    category: Option<String>,
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<()> {
    with_conn(&db, |conn| {
        db::set_channel_category(conn, id, category.as_deref())
    })?;
    let _ = app.emit("channels-changed", ());
    Ok(())
}

#[tauri::command]
fn list_inbox(db: State<'_, Db>) -> AppResult<Vec<ChannelVideo>> {
    with_conn(&db, |conn| db::list_inbox(conn))
}

#[tauri::command]
fn dismiss_inbox(id: i64, app: AppHandle, db: State<'_, Db>) -> AppResult<()> {
    with_conn(&db, |conn| db::dismiss_channel_video(conn, id))?;
    let _ = app.emit("inbox-changed", ());
    Ok(())
}

#[tauri::command]
fn undismiss_inbox(id: i64, app: AppHandle, db: State<'_, Db>) -> AppResult<()> {
    with_conn(&db, |conn| db::undismiss_channel_video(conn, id))?;
    let _ = app.emit("inbox-changed", ());
    Ok(())
}

#[tauri::command]
fn mark_inbox_seen(id: i64, app: AppHandle, db: State<'_, Db>) -> AppResult<()> {
    let now = now_secs();
    with_conn(&db, |conn| db::mark_channel_video_seen(conn, id, now))?;
    let _ = app.emit("inbox-changed", ());
    Ok(())
}

#[tauri::command]
fn mark_inbox_unseen(id: i64, app: AppHandle, db: State<'_, Db>) -> AppResult<()> {
    with_conn(&db, |conn| db::unmark_channel_video_seen(conn, id))?;
    let _ = app.emit("inbox-changed", ());
    Ok(())
}

#[tauri::command]
fn dismiss_all_inbox(channel_id: i64, app: AppHandle, db: State<'_, Db>) -> AppResult<()> {
    with_conn(&db, |conn| db::dismiss_all_for_channel(conn, channel_id))?;
    let _ = app.emit("inbox-changed", ());
    Ok(())
}

#[tauri::command]
async fn add_inbox_to_library(
    id: i64,
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<Video> {
    let cv = with_conn(&db, |conn| {
        db::get_channel_video(conn, id)?
            .ok_or_else(|| anyhow::anyhow!("inbox entry not found"))
    })?;

    // Try the normal yt-dlp full fetch first — it brings down description,
    // category, raw tags, etc. If yt-dlp can't access the video (members-
    // only, age-restricted, region-locked, deleted, etc.), fall back to
    // inserting whatever the channel_video row already has: title,
    // thumbnail, URL, channel link. The user still gets the video into
    // their library; only the description ends up empty.
    let v = match add_video_inner(&cv.url, &db).await {
        Ok(v) => v,
        Err(_) => add_video_from_channel_video(&cv, &db)?,
    };

    with_conn(&db, |conn| db::dismiss_channel_video(conn, id))?;
    let _ = app.emit("inbox-changed", ());
    let _ = app.emit("videos-changed", ());
    Ok(v)
}

/// Insert a library video using only what we already know from the
/// channel_video row — no yt-dlp call. Used when the full-fetch path fails
/// (members-only, age-restricted, etc.).
fn add_video_from_channel_video(cv: &db::ChannelVideo, db: &Db) -> AppResult<Video> {
    let conn = db.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
    if let Some(existing_id) = db::find_video_by_url(&conn, &cv.url)
        .map_err(|e| AppError::Generic(format!("{e:#}")))?
    {
        return db::get_video(&conn, existing_id)
            .map_err(|e| AppError::Generic(format!("{e:#}")))?
            .ok_or_else(|| AppError::Generic("video vanished".into()));
    }
    let channel = db::get_channel(&conn, cv.channel_id)
        .map_err(|e| AppError::Generic(format!("{e:#}")))?
        .ok_or_else(|| AppError::Generic("channel missing".into()))?;
    let id = db::insert_video(
        &conn,
        NewVideo {
            url: &cv.url,
            source: &channel.source,
            video_id: Some(&cv.video_external_id),
            title: &cv.title,
            description: None,
            thumbnail_url: cv.thumbnail_url.as_deref(),
            uploader: Some(&channel.name),
            duration: cv.duration,
            upload_date: cv.upload_date.as_deref(),
            category: None,
            raw_tags: &[],
            channel_url: Some(&channel.url),
            channel_id: channel.channel_id.as_deref(),
        },
    )
    .map_err(|e| AppError::Generic(format!("{e:#}")))?;
    db::get_video(&conn, id)
        .map_err(|e| AppError::Generic(format!("{e:#}")))?
        .ok_or_else(|| AppError::Generic("inserted video not found".into()))
}

#[tauri::command]
async fn refresh_channels(app: AppHandle) -> AppResult<RefreshSummary> {
    let summary = refresh_all_channels(&app).await?;
    Ok(summary)
}

/// Pin down accurate upload timestamps for as many entries as possible. The
/// channel listing already has approximate (sometimes wrong) timestamps from
/// yt-dlp's flat-playlist `approximate_date` heuristic; this function tries
/// to upgrade them with exact values from:
///   1. YouTube's per-channel RSS feed (one request, ~free when it works —
///      currently 404'ing in 2026)
///   2. The DB's existing verified entries (no re-fetch needed)
///   3. Per-video yt-dlp full-info fetches (slow, can fail for members-only
///      or otherwise-restricted videos)
///
/// Returns the set of `video_external_id`s whose timestamps are *verified*
/// (RSS or per-video). Anything left over retains its approximate timestamp,
/// which is good enough for recent uploads but possibly wrong for old ones —
/// we'll keep trying to verify on subsequent refreshes.
async fn enrich_timestamps(
    entries: &mut [ytdlp::ChannelEntry],
    channel_external_id: Option<&str>,
    channel_db_id: i64,
    db: &Db,
) -> std::collections::HashSet<String> {
    use std::collections::HashSet;
    let mut verified_now: HashSet<String> = HashSet::new();

    // 1. RSS fast path (cheap, often dead)
    if let Some(channel_id) = channel_external_id {
        if let Ok(map) = youtube_rss::fetch_video_timestamps(channel_id).await {
            for entry in entries.iter_mut() {
                if let Some(id) = entry.id.as_deref() {
                    if let Some(&ts) = map.get(id) {
                        entry.timestamp = Some(ts);
                        verified_now.insert(id.to_string());
                    }
                }
            }
        }
    }

    // 2. DB: which entries are already verified (so we can skip per-video)?
    let already_verified: HashSet<String> = if channel_db_id > 0 {
        let conn = match db.0.lock() {
            Ok(c) => c,
            Err(_) => return verified_now,
        };
        db::list_verified_video_ids(&conn, channel_db_id).unwrap_or_default()
    } else {
        HashSet::new()
    };

    // 3. Per-video yt-dlp for entries still not verified.
    //    Skip entries whose approximate timestamp already places them well
    //    outside the recent window — they bucket as "Earlier" no matter
    //    what we verify, so paying the per-video cost just to refine their
    //    date is wasted. Entries without any timestamp still get verified
    //    (we have no idea where they fall).
    let now = now_secs();
    let need_fetch: Vec<(usize, String, String)> = entries
        .iter()
        .enumerate()
        .filter_map(|(i, e)| {
            let id = e.id.as_deref()?;
            if verified_now.contains(id) || already_verified.contains(id) {
                return None;
            }
            if let Some(ts) = e.timestamp {
                if ts > 0 && (now - ts) > RECENT_WINDOW_SECS {
                    return None;
                }
            }
            let url = e.webpage()?;
            Some((i, id.to_string(), url))
        })
        .collect();

    if need_fetch.is_empty() {
        verified_now.extend(already_verified);
        return verified_now;
    }

    const PER_VIDEO_CONCURRENCY: usize = 8;
    let sem = Arc::new(tokio::sync::Semaphore::new(PER_VIDEO_CONCURRENCY));
    let mut tasks: tokio::task::JoinSet<(usize, String, Option<i64>)> =
        tokio::task::JoinSet::new();
    for (idx, id, url) in need_fetch {
        let sem = sem.clone();
        tasks.spawn(async move {
            let _permit = match sem.acquire_owned().await {
                Ok(p) => p,
                Err(_) => return (idx, id, None),
            };
            let ts = ytdlp::fetch_info(&url)
                .await
                .ok()
                .and_then(|info| info.upload_unix());
            (idx, id, ts)
        });
    }
    while let Some(res) = tasks.join_next().await {
        if let Ok((idx, id, Some(ts))) = res {
            if let Some(entry) = entries.get_mut(idx) {
                entry.timestamp = Some(ts); // overwrite approximate with exact
            }
            verified_now.insert(id);
        }
    }

    verified_now.extend(already_verified);
    verified_now
}

#[tauri::command]
async fn catch_up_channel(
    channel_id: i64,
    app: AppHandle,
) -> AppResult<CatchUpSummary> {
    // First refresh the channel's listing so we have upload_timestamp populated
    // for any older entries that were seeded before timestamps were captured.
    let ch_url: String = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
        db::get_channel(&conn, channel_id)
            .map_err(|e| AppError::Generic(format!("{e:#}")))?
            .ok_or_else(|| AppError::Generic("channel not found".into()))?
            .url
    };

    let mut listing = ytdlp::fetch_channel_listing(&ch_url, PER_CHANNEL_MAX_ENTRIES)
        .await
        .map_err(|e| AppError::Generic(format!("yt-dlp: {e:#}")))?;

    let channel_external_id: Option<String> = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
        db::get_channel(&conn, channel_id)
            .map_err(|e| AppError::Generic(format!("{e:#}")))?
            .and_then(|c| c.channel_id)
    };
    let verified_ids = enrich_timestamps(
        &mut listing.entries,
        channel_external_id.as_deref(),
        channel_id,
        app.state::<Db>().inner(),
    )
    .await;

    let mut surfaced_now: usize = 0;
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
        // Promote verified timestamps to timestamp_verified=1. Approximate
        // ones go through the upsert path below without the verified flag.
        for entry in &listing.entries {
            if let (Some(ext_id), Some(ts)) = (entry.id.as_deref(), entry.timestamp) {
                if verified_ids.contains(ext_id) {
                    let _ = db::set_channel_video_timestamp(&conn, channel_id, ext_id, ts);
                }
            }
        }
        // Resurface step (aggressive): un-dismiss + un-see every entry in the
        // last RECENT_WINDOW_SECS for this channel — even ones the user
        // explicitly dismissed.
        // Backfill timestamps for any entries we already know about.
        for entry in &listing.entries {
            let Some(ext_id) = entry.id.as_deref() else {
                continue;
            };
            let Some(page) = entry.webpage() else {
                continue;
            };
            let title = entry.title.clone().unwrap_or_else(|| ext_id.to_string());
            let res = db::upsert_channel_video(
                &conn,
                NewChannelVideo {
                    channel_id,
                    video_external_id: ext_id,
                    url: &page,
                    title: &title,
                    thumbnail_url: entry.best_thumbnail().as_deref(),
                    duration: entry.duration.map(|d| d.round() as i64),
                    upload_date: entry.upload_date.as_deref(),
                    upload_timestamp: entry.timestamp,
                    dismissed: false,
                },
            )
            .unwrap_or(db::UpsertResult {
                inserted: false,
                backfilled_timestamp: false,
            });
            if res.inserted {
                surfaced_now += 1;
            }
        }
        let cutoff = now_secs() - RECENT_WINDOW_SECS;
        let resurfaced = db::resurface_channel_recent(&conn, channel_id, cutoff)
            .map_err(|e| AppError::Generic(format!("{e:#}")))?;
        surfaced_now += resurfaced as usize;
        let _ = db::set_last_checked(&conn, channel_id, now_secs());
    }

    let _ = app.emit("inbox-changed", ());
    let _ = app.emit("channels-changed", ());
    Ok(CatchUpSummary {
        surfaced: surfaced_now,
    })
}

#[tauri::command]
fn list_videos(db: State<'_, Db>) -> AppResult<Vec<Video>> {
    with_conn(&db, |conn| db::list_videos(conn))
}

#[tauri::command]
fn delete_video(id: i64, db: State<'_, Db>) -> AppResult<()> {
    with_conn(&db, |conn| db::delete_video(conn, id))
}

#[tauri::command]
fn restore_video(video: Video, db: State<'_, Db>) -> AppResult<Video> {
    with_conn(&db, |conn| {
        // Re-create the row with its original added_at so it sits where it was.
        let id = db::insert_video_at(
            conn,
            NewVideo {
                url: &video.url,
                source: &video.source,
                video_id: video.video_id.as_deref(),
                title: &video.title,
                description: video.description.as_deref(),
                thumbnail_url: video.thumbnail_url.as_deref(),
                uploader: video.uploader.as_deref(),
                duration: video.duration,
                upload_date: video.upload_date.as_deref(),
                category: video.category.as_deref(),
                raw_tags: &video.raw_tags,
                channel_url: video.channel_url.as_deref(),
                channel_id: video.channel_id.as_deref(),
            },
            video.added_at,
        )?;
        if let Some(f) = &video.folder {
            db::set_folder(conn, id, Some(f))?;
        }
        if video.watched {
            db::set_watched(conn, id, true)?;
        }
        if video.favorite {
            db::set_favorite(conn, id, true)?;
        }
        for t in &video.user_tags {
            db::add_tag(conn, id, t)?;
        }
        db::get_video(conn, id)?
            .ok_or_else(|| anyhow::anyhow!("restored video missing"))
    })
}

#[tauri::command]
fn set_folder(id: i64, folder: Option<String>, db: State<'_, Db>) -> AppResult<()> {
    let f = folder
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    with_conn(&db, |conn| db::set_folder(conn, id, f))
}

#[tauri::command]
fn set_watched(id: i64, watched: bool, db: State<'_, Db>) -> AppResult<()> {
    with_conn(&db, |conn| db::set_watched(conn, id, watched))
}

#[tauri::command]
fn set_favorite(id: i64, favorite: bool, db: State<'_, Db>) -> AppResult<()> {
    with_conn(&db, |conn| db::set_favorite(conn, id, favorite))
}

#[tauri::command]
fn add_tag(id: i64, tag: String, db: State<'_, Db>) -> AppResult<Vec<String>> {
    with_conn(&db, |conn| {
        db::add_tag(conn, id, &tag)?;
        db::list_tags_for_video(conn, id)
    })
}

#[tauri::command]
fn remove_tag(id: i64, tag: String, db: State<'_, Db>) -> AppResult<Vec<String>> {
    with_conn(&db, |conn| {
        db::remove_tag(conn, id, &tag)?;
        db::list_tags_for_video(conn, id)
    })
}

#[tauri::command]
fn list_folders(db: State<'_, Db>) -> AppResult<Vec<String>> {
    with_conn(&db, |conn| db::list_folders(conn))
}

#[tauri::command]
fn list_tags(db: State<'_, Db>) -> AppResult<Vec<String>> {
    with_conn(&db, |conn| db::list_all_tags(conn))
}

#[tauri::command]
fn list_categories(db: State<'_, Db>) -> AppResult<Vec<String>> {
    with_conn(&db, |conn| db::list_categories(conn))
}

#[derive(Debug, Serialize, Clone, Default)]
struct RefreshSummary {
    checked: usize,
    new_videos: usize,
    errors: Vec<String>,
}

#[derive(Debug, Serialize, Clone, Default)]
struct CatchUpSummary {
    surfaced: usize,
}

async fn refresh_all_channels(app: &AppHandle) -> AppResult<RefreshSummary> {
    // Coalesce concurrent refreshes — only one at a time.
    let lock = app
        .try_state::<Arc<RefreshLock>>()
        .map(|s| s.inner().clone())
        .unwrap_or_else(|| Arc::new(RefreshLock::default()));
    let _guard = lock.inner.lock().await;

    let channels: Vec<Channel> = {
        let db = app.state::<Db>();
        with_conn(&db, |conn| db::list_channels(conn))?
    };

    let mut summary = RefreshSummary {
        checked: channels.len(),
        ..Default::default()
    };

    // Fan out: fetch yt-dlp listing + RSS timestamps for every channel in
    // parallel. A bounded semaphore keeps us from spawning hundreds of yt-dlp
    // subprocesses on a user with a giant subscription list.
    const MAX_CONCURRENT: usize = 8;
    let semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT));
    let mut tasks: tokio::task::JoinSet<(
        Channel,
        Option<std::collections::HashSet<String>>,
        anyhow::Result<ytdlp::ChannelListing>,
    )> = tokio::task::JoinSet::new();
    for ch in channels {
        let sem = semaphore.clone();
        let handle = app.clone();
        tasks.spawn(async move {
            let _permit = match sem.acquire_owned().await {
                Ok(p) => p,
                Err(_) => return (ch, None, Err(anyhow::anyhow!("semaphore closed"))),
            };
            let url = ch.url.clone();
            let ext_id = ch.channel_id.clone();
            let ch_id = ch.id;
            let result = ytdlp::fetch_channel_listing(&url, PER_CHANNEL_MAX_ENTRIES).await;
            match result {
                Ok(mut listing) => {
                    let db = handle.state::<Db>();
                    let verified =
                        enrich_timestamps(&mut listing.entries, ext_id.as_deref(), ch_id, db.inner()).await;
                    (ch, Some(verified), Ok(listing))
                }
                Err(e) => (ch, None, Err(e)),
            }
        });
    }

    type CompletedTask = (
        Channel,
        Option<std::collections::HashSet<String>>,
        anyhow::Result<ytdlp::ChannelListing>,
    );
    let mut completed: Vec<CompletedTask> = Vec::with_capacity(summary.checked);
    while let Some(res) = tasks.join_next().await {
        if let Ok(triple) = res {
            completed.push(triple);
        }
    }

    // Drain all results into the database in one acquisition of the Mutex.
    {
        let db = app.state::<Db>();
        let conn = db
            .0
            .lock()
            .map_err(|e| AppError::Generic(e.to_string()))?;
        for (ch, verified_ids, listing_result) in completed {
            let listing = match listing_result {
                Ok(l) => l,
                Err(e) => {
                    summary.errors.push(format!("{}: {e:#}", ch.name));
                    continue;
                }
            };
            let verified = verified_ids.unwrap_or_default();
            // Only flip timestamp_verified=1 for entries whose timestamps came
            // from RSS or per-video fetch. Approximate timestamps go through
            // the upsert path with verified=0 so we keep trying to verify them.
            for entry in &listing.entries {
                if let (Some(ext_id), Some(ts)) = (entry.id.as_deref(), entry.timestamp) {
                    if verified.contains(ext_id) {
                        let _ = db::set_channel_video_timestamp(&conn, ch.id, ext_id, ts);
                    }
                }
            }
            for entry in &listing.entries {
                let Some(ext_id) = entry.id.as_deref() else { continue };
                let Some(page) = entry.webpage() else { continue };
                let title = entry.title.clone().unwrap_or_else(|| ext_id.to_string());
                let res = db::upsert_channel_video(
                    &conn,
                    NewChannelVideo {
                        channel_id: ch.id,
                        video_external_id: ext_id,
                        url: &page,
                        title: &title,
                        thumbnail_url: entry.best_thumbnail().as_deref(),
                        duration: entry.duration.map(|d| d.round() as i64),
                        upload_date: entry.upload_date.as_deref(),
                        upload_timestamp: entry.timestamp,
                        dismissed: false,
                    },
                )
                .unwrap_or(db::UpsertResult {
                    inserted: false,
                    backfilled_timestamp: false,
                });
                if res.inserted {
                    summary.new_videos += 1;
                }
            }
            let _ = db::set_last_checked(&conn, ch.id, now_secs());
        }

        // After timestamp backfills, surface anything the original "pre-dismiss
        // at follow" behavior had hidden that's still within the last 30 days.
        let cutoff = now_secs() - RECENT_WINDOW_SECS;
        let n = db::catch_up_all_channels(&conn, cutoff)
            .map_err(|e| AppError::Generic(format!("{e:#}")))?;
        summary.new_videos += n as usize;
    }

    let _ = app.emit("inbox-changed", ());
    let _ = app.emit("channels-changed", ());
    Ok(summary)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn spawn_background_refresh(app: AppHandle) {
    // Single startup refresh after a short delay. The recurring schedule is
    // owned by the frontend (so it can respect the user's
    // `pollIntervalMinutes` setting and react immediately to changes).
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(INITIAL_REFRESH_DELAY_SECS)).await;
        let _ = refresh_all_channels(&app).await;
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let database = db::open_db().expect("opening database");
            app.manage(database);
            app.manage(Arc::new(RefreshLock::default()));
            spawn_background_refresh(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_video,
            ingest_url,
            follow_channel,
            unfollow_channel,
            list_channels,
            set_channel_category,
            list_inbox,
            dismiss_inbox,
            undismiss_inbox,
            mark_inbox_seen,
            mark_inbox_unseen,
            dismiss_all_inbox,
            add_inbox_to_library,
            refresh_channels,
            catch_up_channel,
            list_videos,
            delete_video,
            restore_video,
            set_folder,
            set_watched,
            set_favorite,
            add_tag,
            remove_tag,
            list_folders,
            list_tags,
            list_categories,
        ])
        .run(tauri::generate_context!())
        .expect("error while running VidMinder");
}
