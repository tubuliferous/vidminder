use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;

/// Fetch the YouTube channel RSS feed and return an accurate
/// `video_id -> Unix-seconds` map for the most recent ~15 uploads.
///
/// YouTube exposes per-channel Atom feeds at
/// `https://www.youtube.com/feeds/videos.xml?channel_id=UC...`. They are free,
/// quota-free, and ship the *real* `<published>` timestamps — unlike yt-dlp's
/// `--flat-playlist` mode, which only gives us a heuristic approximation that
/// collapses older videos to the wrong day.
pub async fn fetch_video_timestamps(channel_id: &str) -> Result<HashMap<String, i64>> {
    if !looks_like_youtube_channel_id(channel_id) {
        return Ok(HashMap::new());
    }
    let url = format!(
        "https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("VidMinder/0.1 (+yt-dlp sidecar)")
        .build()
        .context("building http client")?;

    let resp = client
        .get(&url)
        .send()
        .await
        .context("fetching YouTube RSS feed")?;

    if !resp.status().is_success() {
        return Err(anyhow!(
            "YouTube RSS returned HTTP {} for {channel_id}",
            resp.status()
        ));
    }

    let body = resp.text().await.context("reading RSS body")?;
    Ok(parse_atom_entries(&body))
}

fn looks_like_youtube_channel_id(id: &str) -> bool {
    // YouTube channel IDs always start with "UC" followed by 22 base64-ish chars.
    id.starts_with("UC") && id.len() >= 20 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn parse_atom_entries(body: &str) -> HashMap<String, i64> {
    let mut out = HashMap::new();
    let mut cursor = body;
    while let Some(start) = cursor.find("<entry>") {
        let after_open = &cursor[start + "<entry>".len()..];
        let Some(close_at) = after_open.find("</entry>") else {
            break;
        };
        let entry_body = &after_open[..close_at];
        cursor = &after_open[close_at + "</entry>".len()..];

        let Some(vid) = extract_between(entry_body, "<yt:videoId>", "</yt:videoId>") else {
            continue;
        };
        let Some(published) = extract_between(entry_body, "<published>", "</published>") else {
            continue;
        };
        let Some(ts) = parse_iso8601_to_unix(published) else {
            continue;
        };
        out.insert(vid.to_string(), ts);
    }
    out
}

fn extract_between<'a>(haystack: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = haystack.find(open)? + open.len();
    let rest = &haystack[start..];
    let end = rest.find(close)?;
    Some(&rest[..end])
}

/// Parse a strict subset of ISO 8601 datetimes (the form YouTube emits, e.g.
/// `2026-04-15T14:30:00+00:00` or `2026-04-15T14:30:00Z`) into Unix seconds.
fn parse_iso8601_to_unix(iso: &str) -> Option<i64> {
    let iso = iso.trim();
    if iso.len() < 19 {
        return None;
    }
    let year: i64 = iso.get(0..4)?.parse().ok()?;
    let month: i64 = iso.get(5..7)?.parse().ok()?;
    let day: i64 = iso.get(8..10)?.parse().ok()?;
    let hour: i64 = iso.get(11..13)?.parse().ok()?;
    let minute: i64 = iso.get(14..16)?.parse().ok()?;
    let second: i64 = iso.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    // Timezone offset
    let tz_seconds: i64 = if iso.len() == 19 {
        0
    } else if iso.as_bytes()[19] == b'Z' {
        0
    } else if iso.len() >= 25 {
        let sign = match iso.as_bytes()[19] {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        let tz_h: i64 = iso.get(20..22)?.parse().ok()?;
        let tz_m: i64 = iso.get(23..25)?.parse().ok()?;
        sign * (tz_h * 3600 + tz_m * 60)
    } else {
        return None;
    };

    // Days from epoch (1970-01-01) to the given calendar date.
    let mut days: i64 = 0;
    if year < 1970 {
        return None;
    }
    for y in 1970..year {
        days += if is_leap_year(y) { 366 } else { 365 };
    }
    let dim = days_in_month(year as i32);
    for m in 0..(month as usize - 1) {
        days += dim[m] as i64;
    }
    days += day - 1;

    let total = days * 86_400 + hour * 3600 + minute * 60 + second - tz_seconds;
    Some(total)
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(year: i32) -> [u32; 12] {
    [
        31,
        if is_leap_year(year as i64) { 29 } else { 28 },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_zulu_time() {
        // 2026-04-15T14:30:00Z → 1776263400
        let ts = parse_iso8601_to_unix("2026-04-15T14:30:00Z").unwrap();
        assert_eq!(ts, 1776263400);
    }

    #[test]
    fn parses_offset_time() {
        // +02:00 → subtract 7200 from the Zulu equivalent
        let z = parse_iso8601_to_unix("2026-04-15T14:30:00Z").unwrap();
        let off = parse_iso8601_to_unix("2026-04-15T14:30:00+02:00").unwrap();
        assert_eq!(off, z - 7200);
    }

    #[test]
    fn pulls_video_ids_from_feed() {
        let sample = r#"<?xml version="1.0" encoding="UTF-8"?>
            <feed>
              <entry>
                <yt:videoId>abc123</yt:videoId>
                <title>First</title>
                <published>2026-04-15T14:30:00Z</published>
              </entry>
              <entry>
                <yt:videoId>def456</yt:videoId>
                <title>Second</title>
                <published>2026-04-10T08:00:00Z</published>
              </entry>
            </feed>"#;
        let out = parse_atom_entries(sample);
        assert_eq!(out.len(), 2);
        assert!(out.contains_key("abc123"));
        assert!(out.contains_key("def456"));
    }
}
