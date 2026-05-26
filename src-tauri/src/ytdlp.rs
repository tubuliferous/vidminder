use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::path::PathBuf;
use tokio::process::Command;

/// Locate yt-dlp. In production we ship it as a Tauri sidecar so the binary
/// lives next to the main executable (Tauri strips the target-triple suffix
/// from `externalBin` files when bundling). In dev we fall back to whatever
/// yt-dlp is on the user's PATH.
fn yt_dlp_command() -> Command {
    let mut cmd = if let Some(path) = sidecar_path() {
        Command::new(path)
    } else {
        Command::new("yt-dlp")
    };
    suppress_console_on_windows(&mut cmd);
    cmd
}

/// On Windows, spawning a console subprocess from a GUI app pops up a flash of
/// a black console window. CREATE_NO_WINDOW (0x08000000) suppresses it.
#[cfg(target_os = "windows")]
fn suppress_console_on_windows(cmd: &mut Command) {
    cmd.creation_flags(0x08000000);
}

#[cfg(not(target_os = "windows"))]
fn suppress_console_on_windows(_cmd: &mut Command) {}

fn sidecar_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(target_os = "windows") {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
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
    pub categories: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub extractor_key: Option<String>,
    pub extractor: Option<String>,
    pub webpage_url: Option<String>,
    pub original_url: Option<String>,
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

    pub fn source(&self) -> String {
        self.extractor_key
            .clone()
            .or_else(|| self.extractor.clone())
            .unwrap_or_else(|| "Unknown".to_string())
    }
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

pub async fn fetch_info(url: &str) -> Result<YtdlpInfo> {
    let output = yt_dlp_command()
        .args([
            "--dump-single-json",
            "--no-download",
            "--no-warnings",
            "--no-playlist",
            "--skip-download",
            "--socket-timeout",
            "15",
            url,
        ])
        .output()
        .await
        .context("spawning yt-dlp (is it bundled or on PATH?)")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "yt-dlp exited with status {}: {}",
            output.status,
            stderr.trim()
        ));
    }

    let info: YtdlpInfo =
        serde_json::from_slice(&output.stdout).with_context(|| "parsing yt-dlp JSON output")?;
    Ok(info)
}

pub async fn fetch_channel_listing(url: &str, max_entries: usize) -> Result<ChannelListing> {
    let url = normalize_channel_url(url);
    let output = yt_dlp_command()
        .args([
            "--dump-single-json",
            "--flat-playlist",
            "--no-warnings",
            "--skip-download",
            // YouTube's flat-playlist mode normally omits upload dates entirely.
            // approximate_date asks the extractor to estimate them without
            // per-video lookups, giving us a `timestamp` field per entry.
            "--extractor-args",
            "youtubetab:approximate_date",
            "--playlist-end",
            &max_entries.to_string(),
            "--socket-timeout",
            "20",
            &url,
        ])
        .output()
        .await
        .context("spawning yt-dlp for channel listing")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "yt-dlp exited with status {}: {}",
            output.status,
            stderr.trim()
        ));
    }

    let info: ChannelListing = serde_json::from_slice(&output.stdout)
        .with_context(|| "parsing yt-dlp channel JSON output")?;
    Ok(info)
}

/// For YouTube channel URLs, append `/videos` to restrict to the videos tab.
/// Otherwise leave the URL alone.
fn normalize_channel_url(url: &str) -> String {
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
    // Already ends in /videos, /streams, /shorts, etc.
    let last_seg = path.rsplit('/').next().unwrap_or("");
    let has_tab = matches!(
        last_seg,
        "videos" | "streams" | "shorts" | "playlists" | "community" | "featured" | "about"
    );
    if has_tab {
        return url.to_string();
    }
    let scheme = parsed.scheme();
    let host = parsed.host_str().unwrap_or("youtube.com");
    format!("{scheme}://{host}{path}/videos")
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
