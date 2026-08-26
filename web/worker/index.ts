// VidMinder web API. The frontend is the DESKTOP app's src/ compiled with
// Tauri shims: `invoke("cmd", args)` becomes `POST /api/invoke/<cmd>`, so this
// Worker implements the same command contract as src-tauri/src/lib.rs against
// D1. Response bodies are the bare command results (what invoke resolves to);
// errors are non-2xx with {error} (what invoke rejects with).

import {
  hashPassword,
  verifyPassword,
  newSessionToken,
  sessionExpiry,
  sessionCookie,
  readSessionToken,
} from "./auth";
import {
  extractVideoId,
  canonicalWatchUrl,
  fetchOEmbed,
  resolveChannel,
  fetchChannelFeed,
} from "./youtube";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SIGNUP_CODE?: string;
}

type Ctx = { env: Env; uid: number; now: number };

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data ?? null), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

const err = (status: number, message: string) => json({ error: message }, { status });

class CmdError extends Error {}

// ---------------------------------------------------------------------------
// Shapes — must serialize exactly like the desktop's types.ts expects.
// ---------------------------------------------------------------------------

async function tagsByVideo(ctx: Ctx): Promise<Map<number, string[]>> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT vt.video_id AS vid, t.name AS name
     FROM video_tags vt
     JOIN tags t ON t.id = vt.tag_id
     JOIN videos v ON v.id = vt.video_id
     WHERE v.user_id = ?1
     ORDER BY t.name COLLATE NOCASE`
  )
    .bind(ctx.uid)
    .all<{ vid: number; name: string }>();
  const m = new Map<number, string[]>();
  for (const r of results) {
    if (!m.has(r.vid)) m.set(r.vid, []);
    m.get(r.vid)!.push(r.name);
  }
  return m;
}

function videoShape(r: Record<string, unknown>, tags: string[]) {
  return {
    id: r.id,
    url: r.url,
    source: r.source ?? "youtube",
    video_id: r.video_id ?? null,
    title: r.title,
    description: r.description ?? null,
    thumbnail_url: r.thumbnail_url ?? null,
    uploader: r.uploader ?? null,
    duration: r.duration ?? null,
    upload_date: r.upload_date ?? null,
    category: r.category ?? null,
    raw_tags: JSON.parse((r.raw_tags as string) || "[]"),
    user_tags: tags,
    watched: !!r.watched,
    favorite: !!r.favorite,
    added_at: r.added_at,
    channel_url: r.channel_url ?? null,
    channel_id: r.channel_id ?? null,
    // No offline downloads on the web — permanently 'none' keeps the shared
    // frontend's Video shape intact.
    offline_status: "none",
    offline_path: null,
    offline_quality: null,
    offline_size: null,
    offline_downloaded_at: null,
    is_short: !!r.is_short,
  };
}

async function getVideo(ctx: Ctx, id: number) {
  const row = await ctx.env.DB.prepare(
    `SELECT * FROM videos WHERE id = ?1 AND user_id = ?2`
  )
    .bind(id, ctx.uid)
    .first<Record<string, unknown>>();
  if (!row) throw new CmdError("video not found");
  const { results } = await ctx.env.DB.prepare(
    `SELECT t.name FROM video_tags vt JOIN tags t ON t.id = vt.tag_id
     WHERE vt.video_id = ?1 ORDER BY t.name COLLATE NOCASE`
  )
    .bind(id)
    .all<{ name: string }>();
  return videoShape(row, results.map((r) => r.name));
}

// The desktop matches library membership by URL or YouTube video id (URLs
// drift: /shorts/, youtu.be, tracking params) — mirror that everywhere.
const IN_LIBRARY = `(cv.url IN (SELECT url FROM videos WHERE user_id = ?1)
  OR cv.video_external_id IN
     (SELECT video_id FROM videos WHERE user_id = ?1 AND video_id IS NOT NULL))`;

function channelVideoShape(r: Record<string, unknown>) {
  return {
    id: r.id,
    channel_id: r.channel_id,
    channel_name: r.channel_name,
    channel_url: r.channel_url,
    video_external_id: r.video_external_id,
    url: r.url,
    title: r.title,
    thumbnail_url: r.thumbnail_url ?? null,
    duration: r.duration ?? null,
    upload_date: r.upload_date ?? null,
    upload_timestamp: r.upload_timestamp ?? null,
    first_seen_at: r.first_seen_at,
    seen_at: r.seen_at ?? null,
    dismissed: !!r.dismissed,
    in_library: !!r.in_library,
    is_short: !!r.is_short,
  };
}

// ---------------------------------------------------------------------------
// Tag helpers (desktop semantics: dotted names, NOCASE unique, orphans pruned)
// ---------------------------------------------------------------------------

function normalizeTag(raw: string): string {
  return raw
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(".");
}

async function linkTag(ctx: Ctx, videoId: number, tag: string): Promise<void> {
  const name = normalizeTag(tag);
  if (!name) return;
  await ctx.env.DB.prepare(
    `INSERT OR IGNORE INTO tags (user_id, name) VALUES (?1, ?2)`
  )
    .bind(ctx.uid, name)
    .run();
  const t = await ctx.env.DB.prepare(
    `SELECT id FROM tags WHERE user_id = ?1 AND name = ?2`
  )
    .bind(ctx.uid, name)
    .first<{ id: number }>();
  await ctx.env.DB.prepare(
    `INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?1, ?2)`
  )
    .bind(videoId, t!.id)
    .run();
}

async function pruneOrphanTags(ctx: Ctx): Promise<void> {
  await ctx.env.DB.prepare(
    `DELETE FROM tags WHERE user_id = ?1
       AND id NOT IN (SELECT tag_id FROM video_tags)`
  )
    .bind(ctx.uid)
    .run();
}

async function videoTags(ctx: Ctx, videoId: number): Promise<string[]> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT t.name FROM video_tags vt JOIN tags t ON t.id = vt.tag_id
     WHERE vt.video_id = ?1 ORDER BY t.name COLLATE NOCASE`
  )
    .bind(videoId)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

async function requireOwnVideo(ctx: Ctx, id: number): Promise<void> {
  const row = await ctx.env.DB.prepare(
    `SELECT id FROM videos WHERE id = ?1 AND user_id = ?2`
  )
    .bind(id, ctx.uid)
    .first();
  if (!row) throw new CmdError("video not found");
}

// ---------------------------------------------------------------------------
// Channel refresh / follow
// ---------------------------------------------------------------------------

async function refreshChannelRows(
  ctx: Ctx,
  channelDbId: number,
  channelExternalId: string,
  dismissOlderThanUnix: number | null
): Promise<number> {
  const feed = await fetchChannelFeed(channelExternalId);
  let added = 0;
  for (const e of feed.entries) {
    const preDismiss =
      dismissOlderThanUnix !== null &&
      (e.publishedUnix === null || e.publishedUnix < dismissOlderThanUnix);
    const existing = await ctx.env.DB.prepare(
      `SELECT id FROM channel_videos WHERE channel_id = ?1 AND video_external_id = ?2`
    )
      .bind(channelDbId, e.videoId)
      .first();
    if (existing) {
      await ctx.env.DB.prepare(
        `UPDATE channel_videos SET title = ?1,
           thumbnail_url = COALESCE(?2, thumbnail_url),
           upload_timestamp = COALESCE(?3, upload_timestamp)
         WHERE channel_id = ?4 AND video_external_id = ?5`
      )
        .bind(e.title, e.thumbnailUrl, e.publishedUnix, channelDbId, e.videoId)
        .run();
    } else {
      await ctx.env.DB.prepare(
        `INSERT INTO channel_videos
           (channel_id, video_external_id, url, title, thumbnail_url,
            upload_timestamp, first_seen_at, dismissed, auto_dismissed_at_follow)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`
      )
        .bind(
          channelDbId,
          e.videoId,
          e.url,
          e.title,
          e.thumbnailUrl,
          e.publishedUnix,
          ctx.now,
          preDismiss ? 1 : 0
        )
        .run();
      added++;
    }
  }
  await ctx.env.DB.prepare(`UPDATE channels SET last_checked_at = ?1 WHERE id = ?2`)
    .bind(ctx.now, channelDbId)
    .run();
  return added;
}

async function lookbackDays(ctx: Ctx): Promise<number> {
  const row = await ctx.env.DB.prepare(`SELECT lookback_days FROM users WHERE id = ?1`)
    .bind(ctx.uid)
    .first<{ lookback_days: number }>();
  return row?.lookback_days ?? 14;
}

async function followChannel(ctx: Ctx, url: string) {
  const resolved = await resolveChannel(url);
  const dupe = await ctx.env.DB.prepare(
    `SELECT id FROM channels WHERE user_id = ?1 AND channel_id = ?2`
  )
    .bind(ctx.uid, resolved.channelId)
    .first();
  if (dupe) throw new CmdError("already following that channel");

  const ins = await ctx.env.DB.prepare(
    `INSERT INTO channels (user_id, url, channel_id, name, thumbnail_url, followed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(ctx.uid, resolved.url, resolved.channelId, resolved.name, resolved.thumbnailUrl, ctx.now)
    .run();
  const dbId = ins.meta.last_row_id as number;

  const days = await lookbackDays(ctx);
  await refreshChannelRows(ctx, dbId, resolved.channelId, ctx.now - days * 86400).catch(
    () => {}
  );

  const row = await ctx.env.DB.prepare(`SELECT * FROM channels WHERE id = ?1`)
    .bind(dbId)
    .first<Record<string, unknown>>();
  return { ...row, inbox_count: 0 };
}

// ---------------------------------------------------------------------------
// The command dispatcher
// ---------------------------------------------------------------------------

async function runCommand(ctx: Ctx, cmd: string, a: Record<string, any>): Promise<unknown> {
  const { env, uid, now } = ctx;
  switch (cmd) {
    // ---- library ----------------------------------------------------------
    case "list_videos": {
      const [{ results }, tagMap] = await Promise.all([
        env.DB.prepare(
          `SELECT * FROM videos WHERE user_id = ?1 ORDER BY added_at DESC, id DESC`
        )
          .bind(uid)
          .all<Record<string, unknown>>(),
        tagsByVideo(ctx),
      ]);
      return results.map((r) => videoShape(r, tagMap.get(r.id as number) ?? []));
    }

    case "add_video": {
      const vid = extractVideoId(a.url ?? "");
      if (!vid) throw new CmdError("that doesn't look like a YouTube video URL");
      const canonical = canonicalWatchUrl(vid);
      const dupe = await env.DB.prepare(
        `SELECT id FROM videos WHERE user_id = ?1 AND (url = ?2 OR video_id = ?3)`
      )
        .bind(uid, canonical, vid)
        .first<{ id: number }>();
      if (dupe) return getVideo(ctx, dupe.id);
      const info = await fetchOEmbed(canonical);
      const isShort = /\/shorts\//.test(a.url ?? "");
      // oEmbed's author_url is an @handle URL, but followed channels store the
      // canonical UC… form — the frontend's channel-membership check would only
      // match by name. If the video appears in one of this user's channel
      // feeds, bind it to that channel precisely.
      const owner = await env.DB.prepare(
        `SELECT c.url AS url, c.channel_id AS ext
         FROM channel_videos cv JOIN channels c ON c.id = cv.channel_id
         WHERE c.user_id = ?1 AND cv.video_external_id = ?2 LIMIT 1`
      )
        .bind(uid, vid)
        .first<{ url: string; ext: string }>();
      const ins = await env.DB.prepare(
        `INSERT INTO videos (user_id, url, video_id, title, thumbnail_url, uploader,
                             channel_url, channel_id, is_short, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      )
        .bind(uid, canonical, vid, info.title, info.thumbnail_url, info.author_name,
              owner?.url ?? info.author_url, owner?.ext ?? null, isShort ? 1 : 0, now)
        .run();
      return getVideo(ctx, ins.meta.last_row_id as number);
    }

    case "ingest_url": {
      const vid = extractVideoId(a.url ?? "");
      if (vid) {
        return { kind: "video", value: await runCommand(ctx, "add_video", a) };
      }
      return { kind: "channel", value: await followChannel(ctx, a.url ?? "") };
    }

    case "restore_video": {
      const v = a.video ?? {};
      const ins = await env.DB.prepare(
        `INSERT INTO videos (user_id, url, source, video_id, title, description,
                             thumbnail_url, uploader, duration, upload_date, category,
                             raw_tags, watched, favorite, is_short, added_at,
                             channel_url, channel_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT (user_id, url) DO UPDATE SET title = excluded.title`
      )
        .bind(
          uid, v.url, v.source ?? "youtube", v.video_id ?? null, v.title ?? "?",
          v.description ?? null, v.thumbnail_url ?? null, v.uploader ?? null,
          v.duration ?? null, v.upload_date ?? null, v.category ?? null,
          JSON.stringify(v.raw_tags ?? []), v.watched ? 1 : 0, v.favorite ? 1 : 0,
          v.is_short ? 1 : 0, v.added_at ?? now, v.channel_url ?? null, v.channel_id ?? null
        )
        .run();
      const id = (ins.meta.last_row_id as number) ||
        ((await env.DB.prepare(`SELECT id FROM videos WHERE user_id = ?1 AND url = ?2`)
          .bind(uid, v.url).first<{ id: number }>())!.id);
      for (const t of v.user_tags ?? []) await linkTag(ctx, id, t);
      return getVideo(ctx, id);
    }

    case "delete_video": {
      await requireOwnVideo(ctx, a.id);
      // A removed library video should reappear as a normal row in its
      // channel feed — un-dismiss any matching feed row (it may carry
      // dismissed=1 from before the add). Same rule as the desktop backend.
      await env.DB.prepare(
        `UPDATE channel_videos SET dismissed = 0, auto_dismissed_at_follow = 0
         WHERE channel_id IN (SELECT id FROM channels WHERE user_id = ?2)
           AND (url IN (SELECT url FROM videos WHERE id = ?1)
                OR video_external_id IN
                   (SELECT video_id FROM videos WHERE id = ?1 AND video_id IS NOT NULL))`
      )
        .bind(a.id, uid)
        .run();
      await env.DB.prepare(`DELETE FROM videos WHERE id = ?1 AND user_id = ?2`)
        .bind(a.id, uid)
        .run();
      await pruneOrphanTags(ctx);
      return null;
    }

    case "set_watched":
      await env.DB.prepare(
        `UPDATE videos SET watched = ?1 WHERE id = ?2 AND user_id = ?3`
      )
        .bind(a.watched ? 1 : 0, a.id, uid)
        .run();
      return null;

    case "set_favorite":
      await env.DB.prepare(
        `UPDATE videos SET favorite = ?1 WHERE id = ?2 AND user_id = ?3`
      )
        .bind(a.favorite ? 1 : 0, a.id, uid)
        .run();
      return null;

    // ---- tags --------------------------------------------------------------
    case "add_tag":
      await requireOwnVideo(ctx, a.id);
      await linkTag(ctx, a.id, a.tag);
      return videoTags(ctx, a.id);

    case "remove_tag": {
      await requireOwnVideo(ctx, a.id);
      await env.DB.prepare(
        `DELETE FROM video_tags WHERE video_id = ?1
           AND tag_id IN (SELECT id FROM tags WHERE user_id = ?2 AND name = ?3)`
      )
        .bind(a.id, uid, normalizeTag(a.tag))
        .run();
      await pruneOrphanTags(ctx);
      return videoTags(ctx, a.id);
    }

    case "set_video_tags": {
      await requireOwnVideo(ctx, a.id);
      await env.DB.prepare(`DELETE FROM video_tags WHERE video_id = ?1`).bind(a.id).run();
      for (const t of a.tags ?? []) await linkTag(ctx, a.id, t);
      await pruneOrphanTags(ctx);
      return videoTags(ctx, a.id);
    }

    case "add_tag_to_videos":
      for (const id of a.videoIds ?? []) {
        await requireOwnVideo(ctx, id);
        await linkTag(ctx, id, a.tag);
      }
      return null;

    case "list_tag_counts": {
      const { results } = await env.DB.prepare(
        `SELECT t.name AS tag, COUNT(DISTINCT vt.video_id) AS count
         FROM tags t JOIN video_tags vt ON vt.tag_id = t.id
         WHERE t.user_id = ?1
         GROUP BY t.id ORDER BY t.name COLLATE NOCASE`
      )
        .bind(uid)
        .all();
      return results;
    }

    case "rename_tag": {
      const oldName = normalizeTag(a.old);
      const newName = normalizeTag(a.new);
      if (!newName) throw new CmdError("empty tag name");
      // Desktop renames the tag and every dotted descendant.
      const { results } = await env.DB.prepare(
        `SELECT id, name FROM tags WHERE user_id = ?1
           AND (name = ?2 COLLATE NOCASE OR name LIKE ?3)`
      )
        .bind(uid, oldName, `${oldName}.%`)
        .all<{ id: number; name: string }>();
      for (const t of results) {
        const renamed = newName + t.name.slice(oldName.length);
        const clash = await env.DB.prepare(
          `SELECT id FROM tags WHERE user_id = ?1 AND name = ?2 AND id != ?3`
        )
          .bind(uid, renamed, t.id)
          .first<{ id: number }>();
        if (clash) {
          // Merge: repoint links then drop the old tag.
          await env.DB.prepare(
            `INSERT OR IGNORE INTO video_tags (video_id, tag_id)
             SELECT video_id, ?1 FROM video_tags WHERE tag_id = ?2`
          )
            .bind(clash.id, t.id)
            .run();
          await env.DB.prepare(`DELETE FROM tags WHERE id = ?1`).bind(t.id).run();
        } else {
          await env.DB.prepare(`UPDATE tags SET name = ?1 WHERE id = ?2`)
            .bind(renamed, t.id)
            .run();
        }
      }
      return null;
    }

    case "delete_tag": {
      const name = normalizeTag(a.tag);
      await env.DB.prepare(
        `DELETE FROM tags WHERE user_id = ?1
           AND (name = ?2 COLLATE NOCASE OR name LIKE ?3)`
      )
        .bind(uid, name, `${name}.%`)
        .run();
      return null;
    }

    // ---- channels ----------------------------------------------------------
    case "list_channels": {
      const { results } = await env.DB.prepare(
        `SELECT c.*,
                (SELECT COUNT(*) FROM channel_videos cv
                 WHERE cv.channel_id = c.id
                   AND cv.dismissed = 0
                   AND cv.seen_at IS NULL
                   AND cv.is_short = 0
                   AND cv.upload_timestamp IS NOT NULL
                   AND cv.upload_timestamp >= ?2
                   AND NOT ${IN_LIBRARY}) AS inbox_count
         FROM channels c WHERE c.user_id = ?1 ORDER BY c.name COLLATE NOCASE`
      )
        .bind(uid, now - 14 * 86400)
        .all();
      return results;
    }

    case "follow_channel":
      return followChannel(ctx, a.url ?? "");

    case "unfollow_channel":
      await env.DB.prepare(`DELETE FROM channels WHERE id = ?1 AND user_id = ?2`)
        .bind(a.id, uid)
        .run();
      return null;

    case "set_channel_category":
      await env.DB.prepare(
        `UPDATE channels SET category = ?1 WHERE id = ?2 AND user_id = ?3`
      )
        .bind(a.category ?? null, a.id, uid)
        .run();
      return null;

    case "refresh_channels": {
      const { results } = await env.DB.prepare(
        `SELECT id, channel_id FROM channels WHERE user_id = ?1
         ORDER BY COALESCE(last_checked_at, 0) ASC LIMIT 40`
      )
        .bind(uid)
        .all<{ id: number; channel_id: string }>();
      let newVideos = 0;
      const errors: string[] = [];
      for (const c of results) {
        try {
          newVideos += await refreshChannelRows(ctx, c.id, c.channel_id, null);
        } catch (e) {
          errors.push(String(e instanceof Error ? e.message : e));
        }
      }
      return { checked: results.length, new_videos: newVideos, errors };
    }

    case "catch_up_channel": {
      const days = await lookbackDays(ctx);
      const cutoff = now - days * 86400;
      const own = await env.DB.prepare(
        `SELECT id, channel_id FROM channels WHERE id = ?1 AND user_id = ?2`
      )
        .bind(a.channelId, uid)
        .first<{ id: number; channel_id: string }>();
      if (!own) throw new CmdError("channel not found");
      await refreshChannelRows(ctx, own.id, own.channel_id, null).catch(() => {});
      const res = await env.DB.prepare(
        `UPDATE channel_videos AS cv
         SET dismissed = 0, auto_dismissed_at_follow = 0, seen_at = NULL
         WHERE channel_id = ?2
           AND upload_timestamp IS NOT NULL
           AND upload_timestamp >= ?3
           AND NOT ${IN_LIBRARY}`
      )
        .bind(uid, own.id, cutoff)
        .run();
      return { surfaced: res.meta.changes ?? 0 };
    }

    case "set_channel_lookback_days":
      await env.DB.prepare(`UPDATE users SET lookback_days = ?1 WHERE id = ?2`)
        .bind(a.days, uid)
        .run();
      return null;

    // Desktop-only preference (yt-dlp cookies); accept and ignore.
    case "set_cookies_browser":
      return null;

    // ---- inbox --------------------------------------------------------------
    case "list_inbox": {
      // Dismissed rows still surface when in-library (channel-feed
      // intercalation) — same rule as the desktop's list_inbox.
      const { results } = await env.DB.prepare(
        `SELECT cv.*, c.name AS channel_name, c.url AS channel_url,
                ${IN_LIBRARY} AS in_library
         FROM channel_videos cv
         JOIN channels c ON c.id = cv.channel_id
         WHERE c.user_id = ?1
           AND (cv.dismissed = 0 OR ${IN_LIBRARY})
         ORDER BY COALESCE(cv.upload_timestamp, cv.first_seen_at) DESC, cv.id DESC`
      )
        .bind(uid)
        .all<Record<string, unknown>>();
      return results.map(channelVideoShape);
    }

    case "dismiss_inbox":
    case "undismiss_inbox":
      await env.DB.prepare(
        `UPDATE channel_videos SET dismissed = ?1, auto_dismissed_at_follow = 0
         WHERE id = ?2 AND channel_id IN (SELECT id FROM channels WHERE user_id = ?3)`
      )
        .bind(cmd === "dismiss_inbox" ? 1 : 0, a.id, uid)
        .run();
      return null;

    case "mark_inbox_seen":
    case "mark_inbox_unseen":
      await env.DB.prepare(
        `UPDATE channel_videos SET seen_at = ?1
         WHERE id = ?2 AND channel_id IN (SELECT id FROM channels WHERE user_id = ?3)`
      )
        .bind(cmd === "mark_inbox_seen" ? now : null, a.id, uid)
        .run();
      return null;

    case "dismiss_all_inbox":
      await env.DB.prepare(
        `UPDATE channel_videos AS cv SET dismissed = 1
         WHERE cv.channel_id = ?2
           AND cv.channel_id IN (SELECT id FROM channels WHERE user_id = ?1)
           AND cv.dismissed = 0
           AND NOT ${IN_LIBRARY}`
      )
        .bind(uid, a.channelId)
        .run();
      return null;

    case "add_inbox_to_library": {
      const cv = await env.DB.prepare(
        `SELECT cv.*, c.user_id AS owner, c.url AS channel_url, c.channel_id AS channel_ext,
                c.name AS channel_name
         FROM channel_videos cv JOIN channels c ON c.id = cv.channel_id
         WHERE cv.id = ?1`
      )
        .bind(a.id)
        .first<Record<string, any>>();
      if (!cv || cv.owner !== uid) throw new CmdError("inbox item not found");
      const dupe = await env.DB.prepare(
        `SELECT id FROM videos WHERE user_id = ?1 AND (url = ?2 OR video_id = ?3)`
      )
        .bind(uid, cv.url, cv.video_external_id)
        .first<{ id: number }>();
      if (dupe) return getVideo(ctx, dupe.id);
      const ins = await env.DB.prepare(
        `INSERT INTO videos (user_id, url, video_id, title, thumbnail_url, uploader,
                             duration, upload_date, is_short, channel_url, channel_id, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
      )
        .bind(
          uid, cv.url, cv.video_external_id, cv.title, cv.thumbnail_url,
          cv.channel_name, cv.duration ?? null, cv.upload_date ?? null,
          cv.is_short ? 1 : 0, cv.channel_url, cv.channel_ext, now
        )
        .run();
      return getVideo(ctx, ins.meta.last_row_id as number);
    }

    default:
      throw new CmdError(`"${cmd}" isn't available in the web app`);
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing (auth REST endpoints + the invoke dispatcher)
// ---------------------------------------------------------------------------

async function getSession(req: Request, env: Env): Promise<{ userId: number; email: string } | null> {
  const token = readSessionToken(req);
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  return (
    (await env.DB.prepare(
      `SELECT s.user_id AS userId, u.email AS email
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?1 AND s.expires_at > ?2`
    )
      .bind(token, now)
      .first<{ userId: number; email: string }>()) ?? null
  );
}

async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "");
  const method = req.method;
  const now = Math.floor(Date.now() / 1000);

  if (path === "/signup" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    const email = (body.email ?? "").trim().toLowerCase();
    const password = body.password ?? "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(400, "invalid email");
    if (password.length < 8) return err(400, "password must be at least 8 characters");
    if (env.SIGNUP_CODE && body.invite !== env.SIGNUP_CODE)
      return err(403, "invalid invite code");
    const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ?1`)
      .bind(email)
      .first();
    if (existing) return err(409, "an account with that email already exists");
    const { hash, salt } = await hashPassword(password);
    const ins = await env.DB.prepare(
      `INSERT INTO users (email, password_hash, password_salt, created_at) VALUES (?1, ?2, ?3, ?4)`
    )
      .bind(email, hash, salt, now)
      .run();
    const token = newSessionToken();
    const expires = sessionExpiry(now);
    await env.DB.prepare(
      `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)`
    )
      .bind(token, ins.meta.last_row_id, now, expires)
      .run();
    return json(
      { id: ins.meta.last_row_id, email },
      { headers: { "Set-Cookie": sessionCookie(token, expires - now) } }
    );
  }

  if (path === "/login" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    const email = (body.email ?? "").trim().toLowerCase();
    const row = await env.DB.prepare(
      `SELECT id, password_hash, password_salt FROM users WHERE email = ?1`
    )
      .bind(email)
      .first<{ id: number; password_hash: string; password_salt: string }>();
    if (!row) return err(401, "wrong email or password");
    const ok = await verifyPassword(body.password ?? "", row.password_salt, row.password_hash);
    if (!ok) return err(401, "wrong email or password");
    const token = newSessionToken();
    const expires = sessionExpiry(now);
    await env.DB.prepare(
      `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)`
    )
      .bind(token, row.id, now, expires)
      .run();
    return json(
      { id: row.id, email },
      { headers: { "Set-Cookie": sessionCookie(token, expires - now) } }
    );
  }

  if (path === "/logout" && method === "POST") {
    const token = readSessionToken(req);
    if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token = ?1`).bind(token).run();
    return json({ ok: true }, { headers: { "Set-Cookie": sessionCookie("", 0) } });
  }

  const session = await getSession(req, env);
  if (path === "/me" && method === "GET") {
    return session ? json({ id: session.userId, email: session.email }) : err(401, "not logged in");
  }
  if (!session) return err(401, "not logged in");

  const m = path.match(/^\/invoke\/([a-z_]+)$/);
  if (m && method === "POST") {
    const args = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const ctx: Ctx = { env, uid: session.userId, now };
    try {
      return json(await runCommand(ctx, m[1], args));
    } catch (e) {
      if (e instanceof CmdError) return err(400, e.message);
      throw e;
    }
  }

  return err(404, "no such endpoint");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env);
      } catch (e) {
        return err(500, String(e instanceof Error ? e.message : e));
      }
    }
    return env.ASSETS.fetch(req);
  },

  // Cron: refresh the stalest channels across all users (free-plan Workers
  // allow 50 subrequests per invocation; 40 leaves headroom).
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const { results } = await env.DB.prepare(
      `SELECT id, channel_id, user_id FROM channels
       ORDER BY COALESCE(last_checked_at, 0) ASC LIMIT 40`
    ).all<{ id: number; channel_id: string; user_id: number }>();
    for (const c of results) {
      const ctx: Ctx = { env, uid: c.user_id, now };
      try {
        await refreshChannelRows(ctx, c.id, c.channel_id, null);
      } catch {
        // Transient feed errors are fine — the next tick retries the stalest.
      }
    }
  },
} satisfies ExportedHandler<Env>;
