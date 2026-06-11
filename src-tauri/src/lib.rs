mod db;
#[cfg(target_os = "macos")]
mod macos_drag;
mod youtube_rss;
mod ytdlp;

use db::{Channel, ChannelVideo, Db, NewChannel, NewChannelVideo, NewVideo, TagCount, Video};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

const INITIAL_REFRESH_DELAY_SECS: u64 = 8;
// The channel "load videos" lookback window. Default is 2 weeks; the user can
// raise it (up to 10 years) via the Settings dialog, which pushes the value to
// `AppConfig` through the `set_channel_lookback_days` command. It governs which
// of a channel's videos are surfaced (not pre-dismissed) at follow time, the
// catch-up resurface cutoff, and how deep the follow/catch-up fetch goes.
const DEFAULT_LOOKBACK_SECS: i64 = 14 * 24 * 60 * 60;
// Per-video timestamp verification (one yt-dlp call each) is expensive, so we
// bound it to a fixed recent window regardless of how large the lookback is.
// Videos older than this keep yt-dlp's approximate dates — accurate enough for
// display/sorting; exact dates only matter for the recent inbox buckets.
const ENRICH_WINDOW_SECS: i64 = 14 * 24 * 60 * 60;
// The background poll only needs enough entries to catch new uploads; it never
// scales with the lookback (that would re-crawl years of listings every poll).
const REFRESH_MAX_ENTRIES: usize = 50;

/// Runtime-configurable channel settings, set from the frontend and held as
/// managed Tauri state so every channel command can read it without threading
/// the value through each signature.
struct AppConfig {
    /// Channel video lookback window, in seconds. Defaults to 2 weeks.
    lookback_secs: std::sync::atomic::AtomicI64,
}

/// Which browser yt-dlp should read cookies from when YouTube requires sign-in
/// ("Sign in to confirm you're not a bot"). None means no --cookies-from-browser
/// flag is passed. Updated at app start and whenever the user changes the setting.
struct CookieBrowser(StdMutex<Option<String>>);

fn cookies_browser(app: &AppHandle) -> Option<String> {
    app.try_state::<CookieBrowser>()
        .and_then(|s| s.0.lock().ok().and_then(|g| g.clone()))
}

/// Current lookback window (seconds), falling back to the default if unset.
fn lookback_secs(app: &AppHandle) -> i64 {
    app.try_state::<AppConfig>()
        .map(|c| c.lookback_secs.load(std::sync::atomic::Ordering::Relaxed))
        .filter(|&v| v > 0)
        .unwrap_or(DEFAULT_LOOKBACK_SECS)
}

/// How many channel entries to fetch to fill a given lookback window. Scales
/// roughly with the window (assuming up to ~3 uploads/day) but stays bounded so
/// even a 10-year setting can't trigger an unbounded flat-playlist crawl.
fn max_entries_for_window(window_secs: i64) -> usize {
    let days = (window_secs / 86_400).max(1);
    days.saturating_mul(3).clamp(50, 2000) as usize
}

fn is_recent(timestamp: Option<i64>, window_secs: i64) -> bool {
    let Some(ts) = timestamp else { return false };
    let now = now_secs();
    ts > 0 && (now - ts) <= window_secs
}

/// How many video downloads may run at once. yt-dlp + ffmpeg are heavy, so keep
/// this small; the rest queue behind the semaphore.
const MAX_CONCURRENT_DOWNLOADS: usize = 3;

/// Tracks in-flight offline downloads so they can be cancelled, and bounds how
/// many run concurrently. Held as managed Tauri state.
struct DownloadManager {
    /// video id -> the running task's handle (for cancellation).
    tasks: StdMutex<HashMap<i64, tauri::async_runtime::JoinHandle<()>>>,
    gate: Arc<Semaphore>,
}

/// Progress payload emitted to the frontend as a download advances. `status` is
/// one of "downloading", "ready", "error", or "none".
#[derive(Clone, Serialize)]
struct DownloadProgress {
    id: i64,
    percent: f64,
    status: &'static str,
    /// On failure, a human-readable reason the frontend can surface.
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

/// Directory holding downloaded media, alongside the sqlite DB.
fn offline_dir() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| d.join("VidMinder").join("offline"))
}

/// Begin (or no-op if already running) an offline download for one video.
/// Returns immediately; progress and completion are reported via events.
fn start_download(app: &AppHandle, video_id: i64, max_height: Option<i64>) -> AppResult<()> {
    let db = app.state::<Db>();
    let url = with_conn(&db, |conn| db::get_video(conn, video_id))?
        .ok_or_else(|| AppError::Generic("video not found".into()))?
        .url;

    let mgr = app.state::<DownloadManager>();
    if mgr.tasks.lock().unwrap().contains_key(&video_id) {
        return Ok(()); // already downloading
    }

    let dest = offline_dir().ok_or_else(|| AppError::Generic("no data directory".into()))?;
    with_conn(&db, |conn| db::set_offline_status(conn, video_id, "downloading"))?;
    let _ = app.emit("videos-changed", ());
    let _ = app.emit(
        "download-progress",
        DownloadProgress { id: video_id, percent: 0.0, status: "downloading", message: None },
    );

    let cb = cookies_browser(app).map(|s| s.to_string());
    let gate = mgr.gate.clone();
    let app2 = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let _permit = gate.acquire().await; // bounded concurrency
        let stem = video_id.to_string();
        let progress_app = app2.clone();
        let result = ytdlp::download_video(&url, &dest, &stem, max_height, cb.as_deref(), move |pct| {
            let _ = progress_app.emit(
                "download-progress",
                DownloadProgress { id: video_id, percent: pct, status: "downloading", message: None },
            );
        })
        .await;

        let db = app2.state::<Db>();
        match result {
            Ok(outcome) => {
                let path = outcome.path.to_string_lossy().to_string();
                let _ = with_conn(&db, |conn| {
                    db::set_offline_ready(conn, video_id, &path, &outcome.quality, outcome.size)
                });
                let _ = app2.emit(
                    "download-progress",
                    DownloadProgress { id: video_id, percent: 100.0, status: "ready", message: None },
                );
            }
            Err(e) => {
                let _ = with_conn(&db, |conn| db::set_offline_status(conn, video_id, "error"));
                let msg = format!("{e:#}");
                eprintln!("offline download failed for video {video_id}: {msg}");
                let _ = app2.emit(
                    "download-progress",
                    DownloadProgress {
                        id: video_id,
                        percent: 0.0,
                        status: "error",
                        // Keep the toast readable — trim to the first line/200 chars.
                        message: Some(truncate_msg(&msg)),
                    },
                );
            }
        }
        let _ = app2.emit("videos-changed", ());
        app2.state::<DownloadManager>()
            .tasks
            .lock()
            .unwrap()
            .remove(&video_id);
    });

    mgr.tasks.lock().unwrap().insert(video_id, handle);
    Ok(())
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

async fn add_video_inner(url: &str, db: &Db, cookies: Option<&str>) -> AppResult<Video> {
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

    let info = ytdlp::fetch_info(url, cookies)
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
    // A YouTube Short if any of its URL forms is a /shorts/ link.
    let is_short = [
        Some(canonical_url.as_str()),
        Some(url),
        info.webpage_url.as_deref(),
        info.original_url.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|u| u.contains("/shorts/"));

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
                    is_short,
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

async fn follow_channel_inner(
    url: &str,
    db: &Db,
    window_secs: i64,
    cookies: Option<&str>,
) -> AppResult<Channel> {
    let mut listing =
        ytdlp::fetch_channel_listing(url, max_entries_for_window(window_secs), cookies)
            .await
            .map_err(|e| AppError::Generic(format!("yt-dlp: {e:#}")))?;

    let canonical_url = listing.canonical_url().unwrap_or_else(|| url.to_string());
    let name = listing.name();
    let source = listing.source();
    let thumb = listing.best_avatar();
    let description = listing.description.clone();
    let subscriber_count = listing.channel_follower_count;
    let external_id = listing.channel_id.clone().or_else(|| listing.id.clone());

    // Replace approximate timestamps with exact ones from YouTube's RSS feed.
    // (channel_db_id isn't known yet at follow time — fall back to per-video
    //  fetches without the DB-cache shortcut)
    let verified_at_follow =
        enrich_timestamps(&mut listing.entries, external_id.as_deref(), -1, db, cookies).await;

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
                    description: description.as_deref(),
                    subscriber_count,
                },
            )
            .map_err(|e| AppError::Generic(format!("{e:#}")))?
        }
    };

    // Seed channel videos. Videos uploaded within the lookback window land in
    // the inbox (dismissed=false); older ones are pre-dismissed so the inbox
    // doesn't flood with backlog beyond what the user asked to load.
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
                    dismissed: !is_recent(ts, window_secs),
                    is_short: entry.is_short,
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
async fn add_video(url: String, app: AppHandle, db: State<'_, Db>) -> AppResult<Video> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err(AppError::Generic("empty URL".into()));
    }
    validate_youtube_url(&url)?;
    let cb = cookies_browser(&app);
    add_video_inner(&url, &db, cb.as_deref()).await
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
        let cb = cookies_browser(&app);
        let ch = follow_channel_inner(&url, &db, lookback_secs(&app), cb.as_deref()).await?;
        let _ = app.emit("channels-changed", ());
        return Ok(IngestResult::Channel(ch));
    }

    let cb = cookies_browser(&app);
    let v = add_video_inner(&url, &db, cb.as_deref()).await?;
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
    let cb = cookies_browser(&app);
    let ch = follow_channel_inner(&url, &db, lookback_secs(&app), cb.as_deref()).await?;
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
    let cb = cookies_browser(&app);
    let v = match add_video_inner(&cv.url, &db, cb.as_deref()).await {
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
            is_short: cv.is_short,
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
    cookies: Option<&str>,
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
                if ts > 0 && (now - ts) > ENRICH_WINDOW_SECS {
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
        let cb2 = cookies.map(|s| s.to_string());
        tasks.spawn(async move {
            let _permit = match sem.acquire_owned().await {
                Ok(p) => p,
                Err(_) => return (idx, id, None),
            };
            let ts = ytdlp::fetch_info(&url, cb2.as_deref())
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
    let window = lookback_secs(&app);
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

    let cb = cookies_browser(&app);
    let mut listing =
        ytdlp::fetch_channel_listing(&ch_url, max_entries_for_window(window), cb.as_deref())
            .await
            .map_err(|e| AppError::Generic(format!("yt-dlp: {e:#}")))?;

    let channel_external_id: Option<String> = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| AppError::Generic(e.to_string()))?;
        db::get_channel(&conn, channel_id)
            .map_err(|e| AppError::Generic(format!("{e:#}")))?
            .and_then(|c| c.channel_id)
    };
    let cb = cookies_browser(&app);
    let verified_ids = enrich_timestamps(
        &mut listing.entries,
        channel_external_id.as_deref(),
        channel_id,
        app.state::<Db>().inner(),
        cb.as_deref(),
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
        // Resurface step (aggressive): un-dismiss + un-see every entry within
        // the lookback window for this channel — even ones the user explicitly
        // dismissed.
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
                    is_short: entry.is_short,
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
        let cutoff = now_secs() - window;
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

/// Set the channel "load videos" lookback window (in days). Pushed from the
/// frontend settings on startup and whenever the user changes it. `days <= 0`
/// resets to the default. Stored in-memory; the frontend re-pushes on launch.
#[tauri::command]
fn set_channel_lookback_days(days: i64, config: State<'_, AppConfig>) -> AppResult<()> {
    let secs = if days <= 0 {
        DEFAULT_LOOKBACK_SECS
    } else {
        days.saturating_mul(86_400)
    };
    config
        .lookback_secs
        .store(secs, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn set_cookies_browser(browser: Option<String>, state: State<'_, CookieBrowser>) {
    let mut guard = state.0.lock().unwrap();
    *guard = browser.filter(|b| !b.is_empty());
}

#[tauri::command]
fn list_videos(db: State<'_, Db>) -> AppResult<Vec<Video>> {
    with_conn(&db, |conn| db::list_videos(conn))
}

#[tauri::command]
fn delete_video(id: i64, app: AppHandle, db: State<'_, Db>) -> AppResult<()> {
    // Cancel any in-flight download and remove the offline file(s) before the
    // row goes away.
    if let Some(h) = app
        .state::<DownloadManager>()
        .tasks
        .lock()
        .unwrap()
        .remove(&id)
    {
        h.abort();
    }
    let prev = with_conn(&db, |conn| db::get_offline_path(conn, id))?;
    with_conn(&db, |conn| db::delete_video(conn, id))?;
    if let Some(p) = prev {
        let _ = std::fs::remove_file(&p);
    }
    if let Some(dir) = offline_dir() {
        ytdlp::remove_stem_files(&dir, &id.to_string());
    }
    Ok(())
}

#[tauri::command]
async fn list_video_formats(video_id: i64, app: AppHandle) -> AppResult<Vec<i64>> {
    let url = {
        let db = app.state::<Db>();
        with_conn(&db, |conn| db::get_video(conn, video_id))?
            .ok_or_else(|| AppError::Generic("video not found".into()))?
            .url
    };
    let cb = cookies_browser(&app);
    let info = ytdlp::fetch_info(&url, cb.as_deref())
        .await
        .map_err(|e| AppError::Generic(format!("yt-dlp: {e:#}")))?;
    Ok(info.available_heights())
}

#[tauri::command]
fn download_video(video_id: i64, max_height: Option<i64>, app: AppHandle) -> AppResult<()> {
    start_download(&app, video_id, max_height)
}

#[tauri::command]
fn download_videos(video_ids: Vec<i64>, max_height: Option<i64>, app: AppHandle) -> AppResult<()> {
    for id in video_ids {
        // Ignore per-video errors so one bad id doesn't abort the batch.
        let _ = start_download(&app, id, max_height);
    }
    Ok(())
}

#[tauri::command]
fn cancel_download(video_id: i64, app: AppHandle, db: State<'_, Db>) -> AppResult<()> {
    if let Some(h) = app
        .state::<DownloadManager>()
        .tasks
        .lock()
        .unwrap()
        .remove(&video_id)
    {
        h.abort();
    }
    with_conn(&db, |conn| db::set_offline_status(conn, video_id, "none"))?;
    if let Some(dir) = offline_dir() {
        ytdlp::remove_stem_files(&dir, &video_id.to_string());
    }
    let _ = app.emit("videos-changed", ());
    let _ = app.emit(
        "download-progress",
        DownloadProgress { id: video_id, percent: 0.0, status: "none", message: None },
    );
    Ok(())
}

#[tauri::command]
fn delete_offline(video_id: i64, app: AppHandle, db: State<'_, Db>) -> AppResult<()> {
    if let Some(h) = app
        .state::<DownloadManager>()
        .tasks
        .lock()
        .unwrap()
        .remove(&video_id)
    {
        h.abort();
    }
    let prev = with_conn(&db, |conn| db::clear_offline(conn, video_id))?;
    if let Some(p) = prev {
        let _ = std::fs::remove_file(&p);
    }
    if let Some(dir) = offline_dir() {
        ytdlp::remove_stem_files(&dir, &video_id.to_string());
    }
    let _ = app.emit("videos-changed", ());
    let _ = app.emit(
        "download-progress",
        DownloadProgress { id: video_id, percent: 0.0, status: "none", message: None },
    );
    Ok(())
}

/// Open a downloaded video in the OS default app. Returns `true` if the offline
/// file was opened. If the file is gone (deleted outside the app), the video's
/// offline state is reset to "none" and `false` is returned so the caller can
/// fall back to opening the video online.
#[tauri::command]
fn open_offline(video_id: i64, app: AppHandle, db: State<'_, Db>) -> AppResult<bool> {
    let path = with_conn(&db, |conn| db::get_offline_path(conn, video_id))?;
    if let Some(p) = path {
        if std::path::Path::new(&p).is_file() {
            open_in_default_app(&p)?;
            return Ok(true);
        }
    }
    // The file no longer exists — clear the stale offline state and tell the
    // frontend so it can open the video online instead.
    let _ = with_conn(&db, |conn| db::clear_offline(conn, video_id));
    let _ = app.emit("videos-changed", ());
    let _ = app.emit(
        "download-progress",
        DownloadProgress { id: video_id, percent: 0.0, status: "none", message: None },
    );
    Ok(false)
}

/// Open a local file in the OS default app. Uses the platform's native open
/// tool directly rather than the opener plugin, so it isn't gated by webview
/// capabilities (which were blocking open_path).
fn open_in_default_app(path: &str) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    };
    cmd.arg(path);
    cmd.spawn()
        .map_err(|e| AppError::Generic(format!("couldn't open file: {e}")))?;
    Ok(())
}

/// Build a human-readable export filename stem (no extension).
/// Strips characters that are forbidden in filenames on macOS/Windows/Linux
/// while preserving international text.
fn make_export_stem(title: &str, upload_date: Option<&str>) -> String {
    let sanitized: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = sanitized.trim().to_string();
    let short = if trimmed.chars().count() > 100 {
        trimmed.chars().take(100).collect::<String>()
    } else {
        trimmed
    };
    let year = upload_date.filter(|d| d.len() >= 4).map(|d| &d[..4]);
    match year {
        Some(y) => format!("{} ({})", short, y),
        None => short,
    }
}

/// Reveal a file in the OS file manager (Finder on macOS, Explorer on Windows,
/// the default file manager on Linux) with the file pre-selected.
fn reveal_in_file_manager(path: &str) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    let spawn_result = std::process::Command::new("open")
        .args(["-R", path])
        .spawn();
    #[cfg(target_os = "windows")]
    let spawn_result =
        std::process::Command::new("explorer")
            .arg(format!("/select,{path}"))
            .spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let spawn_result = {
        let dir = std::path::Path::new(path)
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or(path);
        std::process::Command::new("xdg-open").arg(dir).spawn()
    };
    spawn_result.map_err(|e| AppError::Generic(format!("reveal file: {e}")))?;
    Ok(())
}

/// Place a copy of `src` at `dest` for export. Hardlink when possible
/// (instant, same filesystem), real copy otherwise.
///
/// MUST remove any stale dest first: if a previous drag left dest as a
/// hardlink of src, `fs::copy` would open dest with truncate — truncating the
/// SHARED inode and destroying the offline file itself (then "copying" the
/// now-empty source). Re-dragging the same video must never be able to do that.
fn place_export_copy(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    let _ = std::fs::remove_file(dest);
    if std::fs::hard_link(src, dest).is_err() {
        std::fs::copy(src, dest)?;
    }
    Ok(())
}

/// Show the locally-downloaded video file in the OS file manager.
#[tauri::command]
fn reveal_offline_file(video_id: i64, db: State<'_, Db>) -> AppResult<()> {
    let path = with_conn(&db, |conn| db::get_offline_path(conn, video_id))?
        .ok_or_else(|| AppError::Generic("video is not downloaded".into()))?;
    reveal_in_file_manager(&path)
}

/// Reveal an arbitrary file path in the OS file manager.  Used by the export
/// workflow where the resulting file is in ~/Downloads (not offline storage).
#[tauri::command]
fn reveal_path(path: String) -> AppResult<()> {
    reveal_in_file_manager(&path)
}

/// Copy the offline video file to a temp dir under a human-readable name and
/// return the absolute path.  The file can then be handed to `startDrag` so
/// the OS drag operation deposits a nicely-named copy wherever the user drops
/// it.  Hardlinks are attempted first (instant; same-filesystem); we fall back
/// to a real copy on a cross-filesystem move.
#[tauri::command]
fn prepare_export_file(video_id: i64, db: State<'_, Db>) -> AppResult<String> {
    let video = with_conn(&db, |conn| db::get_video(conn, video_id))?
        .ok_or_else(|| AppError::Generic("video not found".into()))?;
    let src = video
        .offline_path
        .ok_or_else(|| AppError::Generic("video is not downloaded".into()))?;
    let src_path = std::path::Path::new(&src);
    if !src_path.is_file() {
        return Err(AppError::Generic("offline file is missing from disk".into()));
    }
    let ext = src_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");
    let stem = make_export_stem(&video.title, video.upload_date.as_deref());
    let name = format!("{stem}.{ext}");
    let tmp_dir = std::env::temp_dir().join("VidMinderExport");
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| AppError::Generic(format!("export temp dir: {e}")))?;
    let dest = tmp_dir.join(&name);
    place_export_copy(src_path, &dest)
        .map_err(|e| AppError::Generic(format!("export copy: {e}")))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Make sure the video has a ready offline file, downloading it into the
/// offline store via the normal pipeline if needed (progress ring,
/// "Downloaded" state — the app keeps the copy). Dedupes with an in-flight
/// download of the same video. Returns the offline file's path.
async fn ensure_offline_path(
    app: &AppHandle,
    video_id: i64,
    max_height: Option<i64>,
) -> AppResult<std::path::PathBuf> {
    let db = app.state::<Db>();
    let video = with_conn(&db, |conn| db::get_video(conn, video_id))?
        .ok_or_else(|| AppError::Generic("video not found".into()))?;

    if video.offline_status != "ready" {
        // Kick off the standard offline download (no-op if one is already
        // running for this video) and wait for it to settle.
        start_download(app, video_id, max_height)?;
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let v = with_conn(&db, |conn| db::get_video(conn, video_id))?
                .ok_or_else(|| AppError::Generic("video was removed".into()))?;
            match v.offline_status.as_str() {
                "ready" => break,
                "downloading" => {}
                // "error" / "none" (cancelled) — nothing to export.
                _ => {
                    return Err(AppError::Generic(
                        "the download didn't finish (failed or cancelled)".into(),
                    ))
                }
            }
        }
    }

    let video = with_conn(&db, |conn| db::get_video(conn, video_id))?
        .ok_or_else(|| AppError::Generic("video not found".into()))?;
    let src = video
        .offline_path
        .ok_or_else(|| AppError::Generic("offline file is missing".into()))?;
    let src_path = std::path::PathBuf::from(&src);
    if !src_path.is_file() {
        return Err(AppError::Generic("offline file is missing from disk".into()));
    }
    Ok(src_path)
}

/// Export a video to a caller-chosen destination path (from a save dialog).
/// Downloads into the offline store first if needed.
#[tauri::command]
async fn export_video_to(
    video_id: i64,
    dest_path: String,
    max_height: Option<i64>,
    app: AppHandle,
) -> AppResult<String> {
    let src_path = ensure_offline_path(&app, video_id, max_height).await?;

    let mut dest = std::path::PathBuf::from(dest_path);
    // If the user stripped the extension in the save dialog, restore the
    // source's so the file stays openable.
    if dest.extension().is_none() {
        if let Some(ext) = src_path.extension() {
            dest.set_extension(ext);
        }
    }
    // A real copy (not a hardlink): a file the user owns elsewhere shouldn't
    // share storage with the app's offline store.
    std::fs::copy(src_path, &dest)
        .map_err(|e| AppError::Generic(format!("export copy: {e}")))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Start a native macOS drag-out for a video row, promising the video file.
/// Works for downloaded AND not-yet-downloaded videos: the receiver (Finder,
/// the Desktop, other apps) shows the copy cursor and accepts the drop; the
/// file is then produced at the drop location — downloading into the offline
/// store first when needed. `image` is a PNG data URL for the drag ghost;
/// `on_event` receives one message when the drag session ends.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn start_export_drag(
    video_id: i64,
    max_height: Option<i64>,
    image: String,
    on_event: tauri::ipc::Channel<serde_json::Value>,
) -> AppResult<()> {
    let _ = (video_id, max_height, image, on_event);
    Err(AppError::Generic(
        "file-promise drags are macOS-only".into(),
    ))
}

/// See above — macOS implementation.
#[cfg(target_os = "macos")]
#[tauri::command]
async fn start_export_drag(
    video_id: i64,
    max_height: Option<i64>,
    image: String,
    window: tauri::Window,
    app: AppHandle,
    db: State<'_, Db>,
    on_event: tauri::ipc::Channel<serde_json::Value>,
) -> AppResult<()> {
    use base64::Engine;

    let video = with_conn(&db, |conn| db::get_video(conn, video_id))?
        .ok_or_else(|| AppError::Generic("video not found".into()))?;

    // Predict the file name/type. For non-downloaded videos this matches what
    // the download pipeline will produce (mp4 merge / mp3 audio-only).
    let ext = if video.offline_status == "ready" {
        video
            .offline_path
            .as_deref()
            .and_then(|p| std::path::Path::new(p).extension().and_then(|e| e.to_str()))
            .unwrap_or("mp4")
            .to_string()
    } else if max_height == Some(0) {
        "mp3".into()
    } else {
        "mp4".into()
    };
    let stem = make_export_stem(&video.title, video.upload_date.as_deref());
    let file_name = format!("{stem}.{ext}");
    let file_type_uti = match ext.as_str() {
        "mp4" | "m4v" | "mov" => "public.mpeg-4",
        "mp3" => "public.mp3",
        "m4a" => "public.mpeg-4-audio",
        _ => "public.movie",
    }
    .to_string();

    let png = base64::engine::general_purpose::STANDARD
        .decode(image.strip_prefix("data:image/png;base64,").unwrap_or(&image))
        .map_err(|e| AppError::Generic(format!("bad drag image: {e}")))?;

    let app_for_write = app.clone();
    let write: macos_drag::WriteFn = Box::new(move |dest, done| {
        let app = app_for_write.clone();
        tauri::async_runtime::spawn(async move {
            let res = async {
                let src = ensure_offline_path(&app, video_id, max_height).await?;
                std::fs::copy(&src, &dest)
                    .map_err(|e| AppError::Generic(format!("export copy: {e}")))?;
                Ok::<(), AppError>(())
            }
            .await;
            done(res.map_err(|e| e.to_string()));
        });
    });
    let on_end: macos_drag::EndFn = Box::new(move |dropped| {
        let _ = on_event.send(serde_json::json!({ "dropped": dropped }));
    });

    macos_drag::start_promise_drag(
        &app,
        window,
        macos_drag::PromiseDragOptions {
            file_name,
            file_type_uti,
            url_text: video.url.clone(),
            png,
        },
        write,
        on_end,
    )
    .map_err(AppError::Generic)
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
                is_short: video.is_short,
            },
            video.added_at,
        )?;
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
fn list_tags(db: State<'_, Db>) -> AppResult<Vec<String>> {
    with_conn(&db, |conn| db::list_all_tags(conn))
}

#[tauri::command]
fn list_tag_counts(db: State<'_, Db>) -> AppResult<Vec<TagCount>> {
    with_conn(&db, |conn| db::list_tag_counts(conn))
}

#[tauri::command]
fn set_video_tags(
    id: i64,
    tags: Vec<String>,
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<Vec<String>> {
    let out = with_conn(&db, |conn| {
        db::set_video_tags(conn, id, &tags)?;
        db::list_tags_for_video(conn, id)
    })?;
    let _ = app.emit("videos-changed", ());
    Ok(out)
}

#[tauri::command]
fn add_tag_to_videos(
    video_ids: Vec<i64>,
    tag: String,
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<()> {
    with_conn(&db, |conn| db::add_tag_to_videos(conn, &video_ids, &tag))?;
    let _ = app.emit("videos-changed", ());
    Ok(())
}

#[tauri::command]
fn rename_tag(
    old: String,
    new: String,
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<()> {
    with_conn(&db, |conn| db::rename_tag_in_db(conn, &old, &new))?;
    let _ = app.emit("videos-changed", ());
    Ok(())
}

#[tauri::command]
fn delete_tag(tag: String, app: AppHandle, db: State<'_, Db>) -> AppResult<()> {
    with_conn(&db, |conn| db::delete_tag_in_db(conn, &tag))?;
    let _ = app.emit("videos-changed", ());
    Ok(())
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
    let cb = cookies_browser(app);
    for ch in channels {
        let sem = semaphore.clone();
        let handle = app.clone();
        let cb2 = cb.clone();
        tasks.spawn(async move {
            let _permit = match sem.acquire_owned().await {
                Ok(p) => p,
                Err(_) => return (ch, None, Err(anyhow::anyhow!("semaphore closed"))),
            };
            let url = ch.url.clone();
            let ext_id = ch.channel_id.clone();
            let ch_id = ch.id;
            let result =
                ytdlp::fetch_channel_listing(&url, REFRESH_MAX_ENTRIES, cb2.as_deref()).await;
            match result {
                Ok(mut listing) => {
                    let db = handle.state::<Db>();
                    let verified =
                        enrich_timestamps(&mut listing.entries, ext_id.as_deref(), ch_id, db.inner(), cb2.as_deref()).await;
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
                        is_short: entry.is_short,
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
            // Backfill/refresh channel display metadata: the round avatar (older
            // versions stored the wide banner), the about blurb, and the
            // subscriber count. NULLs preserve whatever's already stored.
            let _ = db::update_channel_meta(
                &conn,
                ch.id,
                listing.best_avatar().as_deref(),
                listing.description.as_deref(),
                listing.channel_follower_count,
            );
        }

        // After timestamp backfills, surface anything the original "pre-dismiss
        // at follow" behavior had hidden that's still within the lookback window.
        let cutoff = now_secs() - lookback_secs(app);
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

/// Condense an error for a toast: first line, capped at ~200 chars.
fn truncate_msg(msg: &str) -> String {
    let first = msg.lines().next().unwrap_or(msg).trim();
    if first.chars().count() > 200 {
        format!("{}…", first.chars().take(200).collect::<String>())
    } else {
        first.to_string()
    }
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
        // single-instance MUST come first per plugin docs. With the `deep-link`
        // feature on, it also forwards URLs from a second-launch into the
        // running instance's deep-link plugin (so drag-onto-icon while the app
        // is already open still ingests instead of opening a duplicate).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .setup(|app| {
            // On Linux & on Windows-dev, URL scheme registration must be done
            // at runtime. Production Windows installers (MSI/NSIS) handle it
            // via the bundle config. macOS handles it via Info.plist at bundle
            // time, so no runtime call needed there.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

            // Tell the yt-dlp layer where bundled resources live so it can find
            // the embedded Python runtime (<resource_dir>/runtime/).
            if let Ok(res) = app.path().resource_dir() {
                ytdlp::set_resource_dir(res);
            }

            // Replace the default macOS "About <binary name>" menu item (it
            // shows lowercase "vidminder" in dev) with one that opens the
            // in-app About dialog — proper name, instructions, shortcut guide.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem, MenuItemKind};
                let menu = Menu::default(app.handle())?;
                if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
                    let about = MenuItem::with_id(
                        app.handle(),
                        "about-vidminder",
                        "About VidMinder",
                        true,
                        None::<&str>,
                    )?;
                    let _ = app_menu.remove_at(0); // the default About item
                    let _ = app_menu.insert(&about, 0);
                }
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id() == "about-vidminder" {
                        let _ = app.emit("open-about", ());
                    }
                });
            }

            let database = db::open_db().expect("opening database");
            app.manage(database);
            app.manage(Arc::new(RefreshLock::default()));
            app.manage(AppConfig {
                lookback_secs: std::sync::atomic::AtomicI64::new(DEFAULT_LOOKBACK_SECS),
            });
            app.manage(DownloadManager {
                tasks: StdMutex::new(HashMap::new()),
                gate: Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS)),
            });
            app.manage(CookieBrowser(StdMutex::new(None)));
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
            set_channel_lookback_days,
            set_cookies_browser,
            list_videos,
            delete_video,
            restore_video,
            list_video_formats,
            download_video,
            download_videos,
            cancel_download,
            delete_offline,
            open_offline,
            reveal_offline_file,
            reveal_path,
            prepare_export_file,
            export_video_to,
            start_export_drag,
            set_watched,
            set_favorite,
            add_tag,
            remove_tag,
            list_tags,
            list_tag_counts,
            set_video_tags,
            add_tag_to_videos,
            rename_tag,
            delete_tag,
            list_categories,
        ])
        .run(tauri::generate_context!())
        .expect("error while running VidMinder");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test: exporting the same video twice must not destroy the
    /// source. The first export hardlinks src→dest; without the stale-dest
    /// removal, the second export's fs::copy fallback truncated the shared
    /// inode, zeroing the offline file itself.
    #[test]
    fn repeated_export_keeps_source_intact() {
        let dir = std::env::temp_dir().join("vidminder-export-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("source.mp4");
        let dest = dir.join("Pretty Name (2026).mp4");
        std::fs::write(&src, b"video bytes here").unwrap();

        for _ in 0..3 {
            place_export_copy(&src, &dest).unwrap();
            assert_eq!(
                std::fs::metadata(&src).unwrap().len(),
                16,
                "source must never be truncated by an export"
            );
            assert_eq!(std::fs::metadata(&dest).unwrap().len(), 16);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_stem_sanitizes_and_keeps_unicode() {
        assert_eq!(
            make_export_stem("What: a/b \"test\"?", Some("20240115")),
            "What_ a_b _test__ (2024)"
        );
        assert_eq!(make_export_stem("한국어 제목", None), "한국어 제목");
    }
}
