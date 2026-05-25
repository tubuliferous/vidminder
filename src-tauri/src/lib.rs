mod db;
mod youtube_rss;
mod ytdlp;

use db::{Channel, ChannelVideo, Db, NewChannel, NewChannelVideo, NewVideo, Video};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex as AsyncMutex;

const REFRESH_INTERVAL_SECS: u64 = 30 * 60;
const INITIAL_REFRESH_DELAY_SECS: u64 = 8;
const PER_CHANNEL_MAX_ENTRIES: usize = 20;
const RECENT_WINDOW_SECS: i64 = 30 * 24 * 60 * 60;

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
    overlay_rss_timestamps(&mut listing.entries, external_id.as_deref()).await;

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
    let v = add_video_inner(&cv.url, &db).await?;
    // Dismiss the inbox entry once it's in the library — the inbox query
    // already hides in_library entries, but flipping the flag keeps the
    // table tidy.
    with_conn(&db, |conn| db::dismiss_channel_video(conn, id))?;
    let _ = app.emit("inbox-changed", ());
    let _ = app.emit("videos-changed", ());
    Ok(v)
}

#[tauri::command]
async fn refresh_channels(app: AppHandle) -> AppResult<RefreshSummary> {
    let summary = refresh_all_channels(&app).await?;
    Ok(summary)
}

/// Replace `entry.timestamp` with the accurate value from YouTube's per-channel
/// Atom feed, when available. Falls back silently to whatever yt-dlp gave us
/// if the RSS request fails or the channel isn't a YouTube channel.
async fn overlay_rss_timestamps(
    entries: &mut [ytdlp::ChannelEntry],
    channel_external_id: Option<&str>,
) {
    // Inline note: not a Tauri command; takes &mut references so we adjust
    // entries in place after the yt-dlp call returns.
    let Some(channel_id) = channel_external_id else {
        return;
    };
    let dates = match youtube_rss::fetch_video_timestamps(channel_id).await {
        Ok(map) if !map.is_empty() => map,
        _ => return,
    };
    for entry in entries.iter_mut() {
        if let Some(id) = entry.id.as_deref() {
            if let Some(&ts) = dates.get(id) {
                entry.timestamp = Some(ts);
            }
        }
    }
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

    // Look up the channel's external id so we can pull exact dates from RSS.
    let channel_external_id: Option<String> = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
        db::get_channel(&conn, channel_id)
            .map_err(|e| AppError::Generic(format!("{e:#}")))?
            .and_then(|c| c.channel_id)
    };
    overlay_rss_timestamps(&mut listing.entries, channel_external_id.as_deref()).await;

    let mut surfaced_now: usize = 0;
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
        // Force-apply RSS timestamps to existing rows (overwrites approximate).
        for entry in &listing.entries {
            if let (Some(ext_id), Some(ts)) = (entry.id.as_deref(), entry.timestamp) {
                let _ = db::set_channel_video_timestamp(&conn, channel_id, ext_id, ts);
            }
        }
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
        let resurfaced = db::catch_up_channel(&conn, channel_id, cutoff)
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

    for ch in channels {
        match ytdlp::fetch_channel_listing(&ch.url, PER_CHANNEL_MAX_ENTRIES).await {
            Ok(mut listing) => {
                overlay_rss_timestamps(&mut listing.entries, ch.channel_id.as_deref()).await;
                let db = app.state::<Db>();
                let conn = db
                    .0
                    .lock()
                    .map_err(|e| AppError::Generic(e.to_string()))?;
                // Force-apply RSS timestamps even to rows already in the table
                // (overwriting yt-dlp's approximate values).
                for entry in &listing.entries {
                    if let (Some(ext_id), Some(ts)) = (entry.id.as_deref(), entry.timestamp) {
                        let _ = db::set_channel_video_timestamp(&conn, ch.id, ext_id, ts);
                    }
                }
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
            Err(e) => {
                summary.errors.push(format!("{}: {e:#}", ch.name));
            }
        }
    }

    // After backfilling timestamps from yt-dlp, surface anything the original
    // "pre-dismiss at follow" behavior had hidden that's still within the
    // last 30 days. User-dismissed entries are excluded by auto_dismissed_at_follow=0.
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
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
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(INITIAL_REFRESH_DELAY_SECS)).await;
        let _ = refresh_all_channels(&app).await;
        loop {
            tokio::time::sleep(Duration::from_secs(REFRESH_INTERVAL_SECS)).await;
            let _ = refresh_all_channels(&app).await;
        }
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
            list_inbox,
            dismiss_inbox,
            undismiss_inbox,
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
