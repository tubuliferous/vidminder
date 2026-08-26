// YouTube helpers that work from a Worker: oEmbed for single-video metadata,
// RSS for channel feeds, and channel-page scraping to resolve @handles to
// channel ids. No yt-dlp here — duration/tags/category are unavailable for
// direct URL adds (RSS-sourced rows don't carry duration either).

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export function extractVideoId(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return id.length === 11 ? id : null;
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    const v = u.searchParams.get("v");
    if (v && v.length === 11) return v;
    const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  }
  return null;
}

export function canonicalWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export type OEmbedInfo = {
  title: string;
  author_name: string | null;
  author_url: string | null;
  thumbnail_url: string | null;
};

export async function fetchOEmbed(videoUrl: string): Promise<OEmbedInfo> {
  const api = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
  const res = await fetch(api, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`YouTube oEmbed returned ${res.status} — is the video public?`);
  }
  const j = (await res.json()) as Record<string, unknown>;
  return {
    title: typeof j.title === "string" ? j.title : videoUrl,
    author_name: typeof j.author_name === "string" ? j.author_name : null,
    author_url: typeof j.author_url === "string" ? j.author_url : null,
    thumbnail_url:
      typeof j.thumbnail_url === "string" ? j.thumbnail_url : null,
  };
}

export type ResolvedChannel = {
  channelId: string;
  name: string;
  url: string;
  thumbnailUrl: string | null;
};

/// Accepts a channel URL, @handle, or bare handle text and resolves the UC…
/// channel id by scraping the channel page (the id is embedded in several
/// places; we try a few).
export async function resolveChannel(input: string): Promise<ResolvedChannel> {
  let pageUrl: string;
  const trimmed = input.trim();
  const direct = trimmed.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/);
  if (trimmed.startsWith("http")) {
    pageUrl = trimmed;
  } else {
    const handle = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
    pageUrl = `https://www.youtube.com/${handle}`;
  }

  let channelId = direct?.[1] ?? null;
  let name: string | null = null;
  let thumb: string | null = null;

  const res = await fetch(pageUrl, {
    headers: { "User-Agent": UA, "Accept-Language": "en" },
  });
  if (res.ok) {
    const html = await res.text();
    channelId =
      channelId ??
      html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/)?.[1] ??
      html.match(/channel_id=(UC[A-Za-z0-9_-]{22})/)?.[1] ??
      null;
    name =
      html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ?? null;
    thumb =
      html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? null;
  }
  if (!channelId) {
    throw new Error(
      "couldn't resolve a channel id — try the full https://www.youtube.com/channel/UC… URL"
    );
  }

  // The RSS feed is the authoritative, bot-friendly source for the title.
  if (!name) {
    try {
      const feed = await fetchChannelFeed(channelId);
      name = feed.channelTitle;
    } catch {
      /* keep null */
    }
  }

  return {
    channelId,
    name: name ?? channelId,
    url: `https://www.youtube.com/channel/${channelId}`,
    thumbnailUrl: thumb,
  };
}

export type FeedEntry = {
  videoId: string;
  title: string;
  url: string;
  thumbnailUrl: string | null;
  publishedUnix: number | null;
};

export type ChannelFeed = {
  channelTitle: string | null;
  entries: FeedEntry[];
};

function between(hay: string, start: string, end: string): string | null {
  const i = hay.indexOf(start);
  if (i < 0) return null;
  const j = hay.indexOf(end, i + start.length);
  if (j < 0) return null;
  return hay.slice(i + start.length, j);
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/// Fetch + parse a channel's RSS feed (same source the desktop app polls).
export async function fetchChannelFeed(channelId: string): Promise<ChannelFeed> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`channel feed returned ${res.status}`);
  const xml = await res.text();

  const channelTitle = between(xml, "<title>", "</title>");
  const entries: FeedEntry[] = [];
  const parts = xml.split("<entry>").slice(1);
  for (const part of parts) {
    const videoId = between(part, "<yt:videoId>", "</yt:videoId>");
    if (!videoId) continue;
    const title = between(part, "<title>", "</title>") ?? videoId;
    const published = between(part, "<published>", "</published>");
    const thumb = part.match(/<media:thumbnail url="([^"]+)"/)?.[1] ?? null;
    const publishedUnix = published
      ? Math.floor(Date.parse(published) / 1000) || null
      : null;
    entries.push({
      videoId,
      title: decodeXml(title),
      url: canonicalWatchUrl(videoId),
      thumbnailUrl: thumb,
      publishedUnix,
    });
  }
  return { channelTitle: channelTitle ? decodeXml(channelTitle) : null, entries };
}
