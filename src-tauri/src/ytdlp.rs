use anyhow::{anyhow, Context, Result};
use once_cell::sync::OnceCell;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// The bundle's resource directory, set once at startup from `lib.rs`. The
/// embedded Python runtime is shipped under `<resource_dir>/runtime/`.
static RESOURCE_DIR: OnceCell<PathBuf> = OnceCell::new();

/// Record where bundled resources live. Called once during Tauri setup with
/// `app.path().resource_dir()`. Idempotent; later calls are ignored.
pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

/// Locate the embedded Python runtime directory (containing `python/` and
/// `pylib/`). In production it's under the bundle resources; in dev it's
/// `src-tauri/runtime/`, populated by `npm run install-sidecar`.
fn runtime_dir() -> Option<PathBuf> {
    if let Some(res) = RESOURCE_DIR.get() {
        let rt = res.join("runtime");
        if rt.join("pylib").is_dir() {
            return Some(rt);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime");
    if dev.join("pylib").is_dir() {
        return Some(dev);
    }
    None
}

/// Path to the relocatable interpreter inside a runtime dir. We strip pbs's
/// convenience symlinks when staging, so we resolve the real versioned binary
/// (any `bin/python3.NN`), falling back to plain names.
fn python_exe(runtime: &Path) -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        let c = runtime.join("python").join("python.exe");
        return c.is_file().then_some(c);
    }
    let bin = runtime.join("python").join("bin");
    if let Ok(rd) = std::fs::read_dir(&bin) {
        let mut hit = None;
        for e in rd.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("python3.") && !name.ends_with("-config") {
                hit = Some(e.path());
                break;
            }
        }
        if let Some(path) = hit {
            ensure_executable(&path);
            return Some(path);
        }
    }
    for name in ["python3", "python"] {
        let c = bin.join(name);
        if c.is_file() {
            ensure_executable(&c);
            return Some(c);
        }
    }
    None
}

/// Tauri's resource copier doesn't always preserve the executable bit, so make
/// sure the interpreter is runnable. Best-effort; ignore failures.
#[cfg(not(target_os = "windows"))]
fn ensure_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mode = meta.permissions().mode();
        if mode & 0o111 == 0 {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode | 0o755));
        }
    }
}

#[cfg(target_os = "windows")]
fn ensure_executable(_path: &Path) {}

/// Build a command that runs yt-dlp. In production we run the bundled
/// relocatable CPython as `python -m yt_dlp` (fast cold start, ~0.3s). In dev,
/// or if the runtime is somehow missing, we fall back to a `yt-dlp` on PATH.
fn yt_dlp_command() -> Command {
    let mut cmd = match runtime_dir().and_then(|rt| python_exe(&rt).map(|py| (rt, py))) {
        Some((rt, py)) => {
            let pylib = rt.join("pylib");
            let mut c = Command::new(py);
            c.arg("-m").arg("yt_dlp");
            c.env("PYTHONPATH", &pylib);
            // Don't let a user's site-packages or PYTHON* env leak in, and don't
            // litter the (possibly read-only) bundle with .pyc files.
            c.env("PYTHONNOUSERSITE", "1");
            c.env("PYTHONDONTWRITEBYTECODE", "1");
            // The relocatable interpreter has no system trust store; point it at
            // the bundled certifi CA bundle so HTTPS verification works.
            let cert = pylib.join("certifi").join("cacert.pem");
            if cert.is_file() {
                c.env("SSL_CERT_FILE", &cert);
            }
            c
        }
        None => Command::new("yt-dlp"),
    };
    augment_path(&mut cmd);
    suppress_console_on_windows(&mut cmd);
    cmd
}

/// Add common binary locations (and the bundled-sidecar dir) to the child's
/// PATH. macOS GUI apps inherit a minimal PATH that omits Homebrew, so a
/// PATH-resolved ffmpeg — needed to merge separate video+audio streams for any
/// resolution above ~720p — silently goes missing and downloads end up as two
/// unmerged fragments. This makes ffmpeg (and a PATH yt-dlp) discoverable.
#[cfg(not(target_os = "windows"))]
fn augment_path(cmd: &mut Command) {
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    if let Some(dir) = sidecar_dir() {
        paths.push(dir);
    }
    for p in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        paths.push(std::path::PathBuf::from(p));
    }
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        cmd.env("PATH", joined);
    }
}

#[cfg(target_os = "windows")]
fn augment_path(_cmd: &mut Command) {}

/// On Windows, spawning a console subprocess from a GUI app pops up a flash of
/// a black console window. CREATE_NO_WINDOW (0x08000000) suppresses it.
#[cfg(target_os = "windows")]
fn suppress_console_on_windows(cmd: &mut Command) {
    cmd.creation_flags(0x08000000);
}

#[cfg(not(target_os = "windows"))]
fn suppress_console_on_windows(_cmd: &mut Command) {}

/// The directory the bundled binaries live in (next to the main executable).
/// In dev there is no sidecar dir, so this is None and we fall back to PATH.
fn sidecar_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.parent().map(|p| p.to_path_buf())
}

/// Locate a bundled ffmpeg, if present. Used to merge separate video+audio
/// streams (required for any resolution above ~720p). When absent, yt-dlp can
/// still fetch progressive (already-merged) formats up to ~720p.
fn ffmpeg_path() -> Option<PathBuf> {
    let dir = sidecar_dir()?;
    let name = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let candidate = dir.join(name);
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

#[derive(Debug, Deserialize)]
pub struct YtdlpInfo {
    pub id: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub thumbnail: Option<String>,
    pub thumbnails: Option<Vec<Thumbnail>>,
    pub uploader: Option<String>,
    pub channel: Option<String>,
    pub channel_id: Option<String>,
    pub channel_url: Option<String>,
    #[allow(dead_code)]
    pub uploader_id: Option<String>,
    pub uploader_url: Option<String>,
    pub duration: Option<f64>,
    pub upload_date: Option<String>,
    /// Unix-epoch seconds. Returned by yt-dlp's full info dump for most
    /// extractors. Authoritative when present.
    pub timestamp: Option<i64>,
    pub categories: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub extractor_key: Option<String>,
    pub extractor: Option<String>,
    pub webpage_url: Option<String>,
    pub original_url: Option<String>,
    #[serde(default)]
    pub formats: Option<Vec<Format>>,
}

/// A single downloadable stream from yt-dlp's `formats` array. We only care
/// about whether it carries video (`vcodec != "none"`) and its `height`.
#[derive(Debug, Deserialize)]
pub struct Format {
    #[serde(default)]
    pub height: Option<i64>,
    #[serde(default)]
    pub vcodec: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Thumbnail {
    pub url: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    #[allow(dead_code)]
    pub preference: Option<i32>,
    /// yt-dlp's thumbnail id. For channels this distinguishes the square
    /// "avatar_uncropped" from the wide "banner_uncropped".
    #[serde(default)]
    pub id: Option<String>,
}

impl YtdlpInfo {
    pub fn best_thumbnail(&self) -> Option<String> {
        if let Some(thumbs) = &self.thumbnails {
            let mut best: Option<&Thumbnail> = None;
            for t in thumbs {
                if t.url.contains("storyboard") {
                    continue;
                }
                match best {
                    None => best = Some(t),
                    Some(cur) => {
                        let cur_score = (cur.width.unwrap_or(0) as i64)
                            * (cur.height.unwrap_or(0) as i64);
                        let new_score = (t.width.unwrap_or(0) as i64)
                            * (t.height.unwrap_or(0) as i64);
                        if new_score > cur_score {
                            best = Some(t);
                        }
                    }
                }
            }
            if let Some(t) = best {
                return Some(t.url.clone());
            }
        }
        self.thumbnail.clone()
    }

    pub fn category(&self) -> Option<String> {
        self.categories.as_ref().and_then(|cs| cs.first().cloned())
    }

    /// Distinct video heights (e.g. 2160, 1440, 1080, 720, 480, 360) available
    /// for this video, largest first. Audio-only formats (vcodec "none") are
    /// excluded. Empty if yt-dlp returned no formats.
    pub fn available_heights(&self) -> Vec<i64> {
        let Some(formats) = &self.formats else {
            return Vec::new();
        };
        let mut heights: Vec<i64> = formats
            .iter()
            .filter(|f| {
                f.vcodec
                    .as_deref()
                    .map(|c| c != "none")
                    .unwrap_or(false)
            })
            .filter_map(|f| f.height)
            .filter(|&h| h > 0)
            .collect();
        heights.sort_unstable_by(|a, b| b.cmp(a));
        heights.dedup();
        heights
    }

    pub fn source(&self) -> String {
        self.extractor_key
            .clone()
            .or_else(|| self.extractor.clone())
            .unwrap_or_else(|| "Unknown".to_string())
    }

    /// Resolve a Unix-second timestamp from whatever yt-dlp gave us — the
    /// dedicated `timestamp` field if present, otherwise `upload_date` (UTC
    /// midnight). Returns None if both are missing/invalid.
    pub fn upload_unix(&self) -> Option<i64> {
        if let Some(ts) = self.timestamp {
            if ts > 0 {
                return Some(ts);
            }
        }
        yyyymmdd_to_unix(self.upload_date.as_deref()?)
    }
}

/// YYYYMMDD (yt-dlp's upload_date format) → Unix seconds at 00:00 UTC.
pub fn yyyymmdd_to_unix(date: &str) -> Option<i64> {
    if date.len() < 8 {
        return None;
    }
    let y: i64 = date.get(0..4)?.parse().ok()?;
    let m: i64 = date.get(4..6)?.parse().ok()?;
    let d: i64 = date.get(6..8)?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || y < 1970 {
        return None;
    }
    let mut days: i64 = 0;
    for yr in 1970..y {
        days += if is_leap_year(yr) { 366 } else { 365 };
    }
    let dim = days_in_month(y);
    for mi in 0..(m as usize - 1) {
        days += dim[mi] as i64;
    }
    days += d - 1;
    Some(days * 86_400)
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64) -> [i64; 12] {
    [
        31,
        if is_leap_year(y) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ]
}

#[derive(Debug, Deserialize)]
pub struct ChannelListing {
    pub id: Option<String>,
    pub title: Option<String>,
    pub channel: Option<String>,
    pub channel_id: Option<String>,
    pub channel_url: Option<String>,
    pub uploader: Option<String>,
    #[allow(dead_code)]
    pub uploader_id: Option<String>,
    pub uploader_url: Option<String>,
    pub thumbnails: Option<Vec<Thumbnail>>,
    pub webpage_url: Option<String>,
    pub extractor_key: Option<String>,
    pub extractor: Option<String>,
    /// The channel's "about" blurb.
    #[serde(default)]
    pub description: Option<String>,
    /// Subscriber count, when YouTube exposes it.
    #[serde(default)]
    pub channel_follower_count: Option<i64>,
    #[serde(default)]
    pub entries: Vec<ChannelEntry>,
}

#[derive(Debug, Deserialize)]
pub struct ChannelEntry {
    pub id: Option<String>,
    pub title: Option<String>,
    pub url: Option<String>,
    pub webpage_url: Option<String>,
    pub duration: Option<f64>,
    pub upload_date: Option<String>,
    /// Unix epoch seconds. Populated when yt-dlp is called with
    /// `--extractor-args youtubetab:approximate_date` for YouTube channels.
    pub timestamp: Option<i64>,
    pub thumbnails: Option<Vec<Thumbnail>>,
    pub thumbnail: Option<String>,
    /// Set by us (not yt-dlp) when an entry came from the channel's /shorts tab.
    #[serde(default)]
    pub is_short: bool,
}

impl ChannelListing {
    pub fn name(&self) -> String {
        self.channel
            .clone()
            .or_else(|| self.uploader.clone())
            .or_else(|| self.title.clone())
            .unwrap_or_else(|| "Unknown channel".to_string())
    }

    pub fn canonical_url(&self) -> Option<String> {
        self.channel_url
            .clone()
            .or_else(|| self.uploader_url.clone())
            .or_else(|| self.webpage_url.clone())
    }

    pub fn source(&self) -> String {
        self.extractor_key
            .clone()
            .or_else(|| self.extractor.clone())
            .unwrap_or_else(|| "Unknown".to_string())
    }

    pub fn best_thumbnail(&self) -> Option<String> {
        let thumbs = self.thumbnails.as_ref()?;
        let mut best: Option<&Thumbnail> = None;
        for t in thumbs {
            if t.url.contains("storyboard") {
                continue;
            }
            match best {
                None => best = Some(t),
                Some(cur) => {
                    let cur_score = (cur.width.unwrap_or(0) as i64)
                        * (cur.height.unwrap_or(0) as i64);
                    let new_score = (t.width.unwrap_or(0) as i64)
                        * (t.height.unwrap_or(0) as i64);
                    if new_score > cur_score {
                        best = Some(t);
                    }
                }
            }
        }
        best.map(|t| t.url.clone())
    }

    /// The channel's circular avatar URL — the square profile image, NOT the
    /// wide banner. YouTube returns both in `thumbnails`; the avatar is tagged
    /// with an "avatar…" id and is square, the banner is very wide. Prefer an
    /// avatar-tagged or square thumbnail (largest known size); fall back to the
    /// overall best thumbnail only if no avatar candidate exists.
    pub fn best_avatar(&self) -> Option<String> {
        let thumbs = self.thumbnails.as_ref()?;
        let is_avatar = |t: &Thumbnail| {
            t.id.as_deref().map(|i| i.starts_with("avatar")).unwrap_or(false)
                || matches!((t.width, t.height), (Some(w), Some(h)) if w == h && w > 0)
        };
        let mut best: Option<&Thumbnail> = None;
        for t in thumbs
            .iter()
            .filter(|t| !t.url.contains("storyboard") && is_avatar(t))
        {
            match best {
                None => best = Some(t),
                Some(cur) => {
                    let cur_score = (cur.width.unwrap_or(0) as i64)
                        * (cur.height.unwrap_or(0) as i64);
                    let new_score = (t.width.unwrap_or(0) as i64)
                        * (t.height.unwrap_or(0) as i64);
                    if new_score > cur_score {
                        best = Some(t);
                    }
                }
            }
        }
        best.map(|t| t.url.clone()).or_else(|| self.best_thumbnail())
    }
}

impl ChannelEntry {
    pub fn webpage(&self) -> Option<String> {
        self.webpage_url.clone().or_else(|| self.url.clone())
    }

    pub fn best_thumbnail(&self) -> Option<String> {
        if let Some(thumbs) = &self.thumbnails {
            let mut best: Option<&Thumbnail> = None;
            for t in thumbs {
                if t.url.contains("storyboard") {
                    continue;
                }
                match best {
                    None => best = Some(t),
                    Some(cur) => {
                        let cur_score = (cur.width.unwrap_or(0) as i64)
                            * (cur.height.unwrap_or(0) as i64);
                        let new_score = (t.width.unwrap_or(0) as i64)
                            * (t.height.unwrap_or(0) as i64);
                        if new_score > cur_score {
                            best = Some(t);
                        }
                    }
                }
            }
            if let Some(t) = best {
                return Some(t.url.clone());
            }
        }
        self.thumbnail.clone()
    }
}

/// Turn raw yt-dlp stderr into a message a non-technical user can act on.
fn friendly_ytdlp_error(stderr: &str) -> String {
    let s = stderr.trim();
    // Bot-detection / sign-in wall
    if s.contains("Sign in to confirm")
        || s.contains("confirm you're not a bot")
        || s.contains("Use --cookies-from-browser")
        || s.contains("Use --cookies")
    {
        return "YouTube is blocking this request. \
            Open Settings → YouTube authentication and pick the browser \
            where you're signed in to YouTube, then try again."
            .to_string();
    }
    // Members-only or age-restricted content that cookies couldn't unlock
    if s.contains("Join this channel")
        || s.contains("members-only")
        || s.contains("This video is available to this channel")
    {
        return "This video is members-only and can't be added.".to_string();
    }
    // Age-gate
    if s.contains("Sign in to confirm your age") || s.contains("age-restricted") {
        return "This video is age-restricted. Open Settings → YouTube authentication, \
            pick the browser where you're signed in to YouTube, then try again."
            .to_string();
    }
    s.to_string()
}

pub async fn fetch_info(url: &str, cookies_browser: Option<&str>) -> Result<YtdlpInfo> {
    let mut cmd = yt_dlp_command();
    cmd.args([
        "--dump-single-json",
        "--no-download",
        "--no-warnings",
        "--no-playlist",
        "--skip-download",
        "--no-check-formats",
        // Allow metadata extraction even when yt-dlp can't find a downloadable
        // format (e.g. DRM-gated content visible to authenticated users).
        "--ignore-no-formats-error",
        "--socket-timeout",
        "15",
    ]);
    if let Some(b) = cookies_browser.filter(|b| !b.is_empty()) {
        cmd.args(["--cookies-from-browser", b]);
    }
    cmd.arg(url);
    let output = cmd
        .output()
        .await
        .context("spawning yt-dlp (is it bundled or on PATH?)")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "yt-dlp: {}",
            friendly_ytdlp_error(&stderr)
        ));
    }

    let info: YtdlpInfo =
        serde_json::from_slice(&output.stdout).with_context(|| "parsing yt-dlp JSON output")?;
    Ok(info)
}

pub async fn fetch_channel_listing(
    url: &str,
    max_entries: usize,
    cookies_browser: Option<&str>,
) -> Result<ChannelListing> {
    // Primary: the /videos tab, trusting its natural reverse-chronological
    // ordering. (An earlier multi-tab merge re-sorted by yt-dlp's approximate
    // dates, which are unreliable enough that legitimate /videos entries got
    // out-ordered and dropped — so we keep /videos as the authoritative list.)
    let mut listing = fetch_single_tab(url, max_entries, "videos", cookies_browser).await?;

    // Also pull the /shorts tab in the background and flag those entries, so a
    // user preference can show or hide Shorts without a refetch. Non-fatal: a
    // channel may have no Shorts, or the tab may error — we just skip them then.
    if let Ok(shorts) = fetch_single_tab(url, max_entries, "shorts", cookies_browser).await {
        let have: std::collections::HashSet<String> = listing
            .entries
            .iter()
            .filter_map(|e| e.id.clone())
            .collect();
        for mut e in shorts.entries {
            e.is_short = true;
            let dup = e.id.as_ref().map(|id| have.contains(id)).unwrap_or(false);
            if !dup {
                listing.entries.push(e);
            }
        }
    }
    Ok(listing)
}

async fn fetch_single_tab(
    url: &str,
    max_entries: usize,
    tab: &str,
    cookies_browser: Option<&str>,
) -> Result<ChannelListing> {
    let url = channel_tab_url(url, tab);
    let mut cmd = yt_dlp_command();
    cmd.args([
        "--dump-single-json",
        "--flat-playlist",
        "--no-warnings",
        "--skip-download",
        "--extractor-args",
        "youtubetab:approximate_date",
        "--playlist-end",
        &max_entries.to_string(),
        "--socket-timeout",
        "20",
    ]);
    if let Some(b) = cookies_browser.filter(|b| !b.is_empty()) {
        cmd.args(["--cookies-from-browser", b]);
    }
    cmd.arg(&url);
    let output = cmd
        .output()
        .await
        .context("spawning yt-dlp for channel listing")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "yt-dlp: {}",
            friendly_ytdlp_error(&stderr)
        ));
    }

    let info: ChannelListing = serde_json::from_slice(&output.stdout)
        .with_context(|| "parsing yt-dlp channel JSON output")?;
    Ok(info)
}


/// For a YouTube channel URL, force it onto the given tab (e.g. "videos" or
/// "shorts"), replacing any existing tab segment. Non-channel URLs are left
/// alone.
fn channel_tab_url(url: &str, tab: &str) -> String {
    let Ok(parsed) = url::Url::parse(url) else {
        return url.to_string();
    };
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    if !(host == "youtube.com" || host.ends_with(".youtube.com")) {
        return url.to_string();
    }
    let path = parsed.path().trim_end_matches('/');
    let is_channel_path = path.starts_with("/@")
        || path.starts_with("/channel/")
        || path.starts_with("/c/")
        || path.starts_with("/user/");
    if !is_channel_path {
        return url.to_string();
    }
    // Drop any trailing tab segment so we can append the one we want.
    let known = [
        "videos",
        "streams",
        "shorts",
        "playlists",
        "community",
        "featured",
        "about",
    ];
    let mut segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segs.last().map(|s| known.contains(s)).unwrap_or(false) {
        segs.pop();
    }
    let scheme = parsed.scheme();
    let host = parsed.host_str().unwrap_or("youtube.com");
    let base = segs.join("/");
    format!("{scheme}://{host}/{base}/{tab}")
}

/// Heuristic — does this URL look like a channel/uploader page rather than a single video?
pub fn looks_like_channel_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    let path = parsed.path();

    if host == "youtube.com" || host.ends_with(".youtube.com") {
        if path.starts_with("/watch")
            || path.starts_with("/shorts/")
            || path.starts_with("/live/")
            || path.starts_with("/embed/")
            || path == "/"
        {
            return false;
        }
        if path.starts_with("/@")
            || path.starts_with("/channel/")
            || path.starts_with("/c/")
            || path.starts_with("/user/")
        {
            return true;
        }
    }
    if host == "youtu.be" {
        return false;
    }
    if host == "vimeo.com" || host.ends_with(".vimeo.com") {
        if path.starts_with("/channels/")
            || path.starts_with("/showcase/")
            || path.starts_with("/user/")
        {
            return true;
        }
    }
    false
}

/// Result of a successful download.
pub struct DownloadOutcome {
    pub path: PathBuf,
    pub size: i64,
    /// Human label for what was fetched ("1080p", "Best", "Audio").
    pub quality: String,
}

/// Download a single video into `dest_dir`, naming the file `<stem>.<ext>`.
/// `max_height` caps the resolution: `None` = best available, `Some(0)` =
/// audio-only mp3, `Some(h)` = best video at or below `h` pixels tall. Anything
/// above ~720p needs the bundled ffmpeg to merge streams; without it yt-dlp
/// falls back to progressive formats. `on_progress` is called with 0.0–100.0.
pub async fn download_video<F>(
    url: &str,
    dest_dir: &Path,
    stem: &str,
    max_height: Option<i64>,
    cookies_browser: Option<&str>,
    on_progress: F,
) -> Result<DownloadOutcome>
where
    F: Fn(f64) + Send,
{
    std::fs::create_dir_all(dest_dir)
        .with_context(|| format!("creating offline dir {}", dest_dir.display()))?;
    // Clear any earlier file/fragments for this stem so the post-download glob
    // is unambiguous.
    remove_stem_files(dest_dir, stem);

    let out_template = dest_dir.join(format!("{stem}.%(ext)s"));
    let audio_only = max_height == Some(0);

    let mut cmd = yt_dlp_command();
    cmd.args(["--newline", "--no-warnings", "--no-playlist", "--no-part"])
        .arg("-o")
        .arg(&out_template);

    if let Some(ff) = ffmpeg_path() {
        cmd.arg("--ffmpeg-location").arg(ff);
    }

    let quality_label = if audio_only {
        cmd.args(["-f", "bestaudio/best", "-x", "--audio-format", "mp3"]);
        "Audio".to_string()
    } else {
        let selector = match max_height {
            Some(h) if h > 0 => format!("bv*[height<={h}]+ba/b[height<={h}]"),
            _ => "bv*+ba/b".to_string(),
        };
        cmd.args(["-f", &selector, "--merge-output-format", "mp4"]);
        // Download English subtitles (uploaded + auto-generated) alongside the
        // video as .srt files AND embed them into the container. Use plain "en"
        // — NOT "en.*", which also pulls every auto-translated track (en-de,
        // en-fr, …), flooding YouTube and tripping HTTP 429. `--ignore-errors`
        // keeps a subtitle hiccup from ever aborting the video download itself.
        cmd.args([
            "--write-subs",
            "--write-auto-subs",
            "--sub-langs",
            "en",
            "--convert-subs",
            "srt",
            "--embed-subs",
            "--ignore-errors",
        ]);
        match max_height {
            Some(h) if h > 0 => format!("{h}p"),
            _ => "Best".to_string(),
        }
    };

    if let Some(b) = cookies_browser.filter(|b| !b.is_empty()) {
        cmd.args(["--cookies-from-browser", b]);
    }
    cmd.arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().context("spawning yt-dlp download")?;
    let stdout = child.stdout.take().context("capturing yt-dlp stdout")?;
    let stderr = child.stderr.take().context("capturing yt-dlp stderr")?;

    // Drain stderr concurrently so a full pipe can't deadlock the child.
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });

    // yt-dlp downloads several streams in sequence (subtitles, then video,
    // then audio), each reporting its own 0→100%. Map them onto one monotonic
    // scale so the UI ring/bar fills ONCE instead of repeating per stream:
    // subtitle streams are ignored (tiny), the first media stream covers
    // 0–85%, the second 85–99%, and completion lands on 100%.
    let mut media_phase: u32 = 0;
    let mut in_subtitle = false;
    let mut last_emitted: f64 = 0.0;
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if let Some(dest) = trimmed.strip_prefix("[download] Destination: ") {
            in_subtitle = Path::new(dest)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| matches!(e.to_ascii_lowercase().as_str(), "srt" | "vtt" | "ass" | "ssa"))
                .unwrap_or(false);
            if !in_subtitle {
                media_phase += 1;
            }
            continue;
        }
        if in_subtitle {
            continue;
        }
        if let Some(pct) = parse_progress(trimmed) {
            let overall = match media_phase {
                0 | 1 => pct * 0.85,
                2 => 85.0 + pct * 0.14,
                _ => 99.0,
            };
            if overall > last_emitted {
                last_emitted = overall;
                on_progress(overall);
            }
        }
    }

    let status = child.wait().await.context("waiting for yt-dlp")?;
    let stderr_out = stderr_task.await.unwrap_or_default();
    if !status.success() {
        return Err(anyhow!("yt-dlp: {}", friendly_ytdlp_error(&stderr_out)));
    }
    on_progress(100.0);

    let path = match find_stem_file(dest_dir, stem) {
        Some(p) => p,
        None => {
            // Streams downloaded but no single merged file remains — almost
            // always a broken or missing ffmpeg (the merge step failed). Give a
            // message that points at the real cause.
            if has_stem_fragments(dest_dir, stem) {
                return Err(anyhow!(
                    "couldn't merge audio + video — ffmpeg is missing or broken. \
                     Try `brew reinstall ffmpeg`. {}",
                    stderr_out.trim()
                ));
            }
            return Err(anyhow!(
                "download produced no file. {}",
                stderr_out.trim()
            ));
        }
    };
    // Remove any leftover media fragments, but keep subtitle sidecars (.srt)
    // so they sit next to the video. (yt-dlp normally deletes fragments after
    // a successful merge; this is belt-and-suspenders.)
    let keep_exts = ["srt", "vtt", "ass", "ssa"];
    if let Ok(entries) = std::fs::read_dir(dest_dir) {
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name();
            let name = name.to_string_lossy();
            if p == path || !name.starts_with(&format!("{stem}.")) {
                continue;
            }
            let is_subtitle = p
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| keep_exts.contains(&x.to_ascii_lowercase().as_str()))
                .unwrap_or(false);
            if !is_subtitle {
                let _ = std::fs::remove_file(p);
            }
        }
    }

    let size = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
    Ok(DownloadOutcome {
        path,
        size,
        quality: quality_label,
    })
}

/// True if any `<stem>.*` file is left in `dir` — used to distinguish a failed
/// merge (leftover fragments) from a download that produced nothing at all.
fn has_stem_fragments(dir: &Path, stem: &str) -> bool {
    std::fs::read_dir(dir)
        .ok()
        .map(|entries| {
            entries.flatten().any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(&format!("{stem}."))
            })
        })
        .unwrap_or(false)
}

/// Parse a yt-dlp "[download]  42.3% of ..." line into a percent (0.0–100.0).
fn parse_progress(line: &str) -> Option<f64> {
    let line = line.trim();
    if !line.starts_with("[download]") {
        return None;
    }
    let token = line.split_whitespace().find(|t| t.ends_with('%'))?;
    token.trim_end_matches('%').parse::<f64>().ok()
}

/// Does `name` look like exactly `<stem>.<ext>` (single extension, no fragment
/// markers like `<stem>.f137.mp4`)? Guards against `<stem>` being a prefix of a
/// different id's file.
fn file_matches_stem(name: &std::ffi::OsStr, stem: &str) -> bool {
    match name.to_string_lossy().strip_prefix(stem) {
        Some(rest) => rest.starts_with('.') && !rest[1..].contains('.'),
        None => false,
    }
}

/// Remove a stem's downloaded file plus any leftover fragments. Public so the
/// command layer can clean up after a cancelled or deleted download.
pub fn remove_stem_files(dir: &Path, stem: &str) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            // Remove the final file plus any leftover fragments for this stem.
            if e.file_name().to_string_lossy().starts_with(&format!("{stem}.")) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

fn find_stem_file(dir: &Path, stem: &str) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .find(|e| file_matches_stem(&e.file_name(), stem))
        .map(|e| e.path())
}
