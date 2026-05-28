import { useEffect, useState } from "react";
import type { Channel, Video } from "../types";
import { formatAddedAt, formatDuration, formatUploadDate } from "../utils";
import { kbd } from "../platform";
import * as api from "../api";

type Props = {
  video: Video;
  knownFolders: string[];
  followedChannels: Channel[];
  onAddTag: (video: Video, tag: string) => void;
  onRemoveTag: (video: Video, tag: string) => void;
  onSetFolder: (video: Video, folder: string | null) => void;
  onToggleWatched: (video: Video) => void;
  onToggleFavorite: (video: Video) => void;
  onOpen: (video: Video) => void;
  onRequestDelete: () => void;
  onFollowChannel: (video: Video) => void;
};

export function VideoDetails({
  video,
  knownFolders,
  followedChannels,
  onAddTag,
  onRemoveTag,
  onSetFolder,
  onToggleWatched,
  onToggleFavorite,
  onOpen,
  onRequestDelete,
  onFollowChannel,
}: Props) {
  const [tagInput, setTagInput] = useState("");
  const [folderInput, setFolderInput] = useState(video.folder ?? "");
  const [editingFolder, setEditingFolder] = useState(false);

  useEffect(() => {
    setFolderInput(video.folder ?? "");
    setEditingFolder(false);
    setTagInput("");
  }, [video.id]);

  const isFollowed =
    !!video.channel_url && followedChannels.some((c) => c.url === video.channel_url);
  const canFollow = !!video.channel_url && !isFollowed;

  const submitTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    onAddTag(video, t);
    setTagInput("");
  };

  const saveFolder = () => {
    const next = folderInput.trim() || null;
    onSetFolder(video, next);
    setEditingFolder(false);
  };

  return (
    <div className="h-full overflow-y-auto border-l border-[var(--color-line)] bg-[var(--color-surface)] flex flex-col">
      <div className="aspect-video w-full bg-black relative shrink-0">
        {video.thumbnail_url ? (
          <img
            src={video.thumbnail_url}
            alt=""
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[var(--color-ink-faint)] text-sm">
            no preview
          </div>
        )}
        <button
          onClick={() => onToggleFavorite(video)}
          title={video.favorite ? "Remove from favorites" : "Add to favorites"}
          className={
            "absolute top-2 right-2 w-8 h-8 rounded-full backdrop-blur-md bg-black/45 hover:bg-black/65 flex items-center justify-center transition " +
            (video.favorite ? "text-[#ffd66e]" : "text-white/85")
          }
        >
          <StarIcon filled={video.favorite} />
        </button>
      </div>

      <div className="p-5 space-y-5">
        <div>
          <h2 className="text-[16px] font-semibold leading-snug">{video.title}</h2>
          <div className="mt-1.5 text-[12.5px] text-[var(--color-ink-dim)] flex flex-wrap items-center gap-x-2 gap-y-1">
            {video.uploader && (
              video.channel_url ? (
                <button
                  onClick={() => api.openInBrowser(video.channel_url!)}
                  className="hover:text-[var(--color-accent)] hover:underline transition-colors"
                  title={`Open ${video.uploader} on YouTube`}
                >
                  {video.uploader}
                </button>
              ) : (
                <span>{video.uploader}</span>
              )
            )}
            {video.uploader && <span className="text-[var(--color-ink-faint)]">·</span>}
            <span>{video.source}</span>
            {video.duration ? (
              <>
                <span className="text-[var(--color-ink-faint)]">·</span>
                <span>{formatDuration(video.duration)}</span>
              </>
            ) : null}
          </div>
          <div className="mt-1 text-[11.5px] text-[var(--color-ink-faint)] flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {video.upload_date && (
              <span title={`Uploaded ${formatUploadDate(video.upload_date)}`}>
                Uploaded {formatUploadDate(video.upload_date)}
              </span>
            )}
            {video.upload_date && (
              <span className="text-[var(--color-ink-faint)]/60">·</span>
            )}
            <span
              title={`Added on ${new Date(video.added_at * 1000).toLocaleString()}`}
            >
              Added {formatAddedAt(video.added_at)}
            </span>
          </div>
          {(canFollow || isFollowed) && (
            <div className="mt-2.5">
              {isFollowed ? (
                <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--color-ink-faint)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]" />
                  Following {video.uploader || "channel"}
                </span>
              ) : (
                <button
                  onClick={() => onFollowChannel(video)}
                  className="text-[12px] px-2.5 py-1 rounded-md border border-[var(--color-accent)]/40 text-[var(--color-accent)] hover:bg-[var(--color-accent-dim)]/40 transition"
                >
                  + Follow {video.uploader ?? "this channel"}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onOpen(video)}
            className="flex-1 text-[13px] font-medium py-2 rounded-md bg-[var(--color-accent)] text-black hover:brightness-110 transition"
          >
            Play in browser
          </button>
          <button
            onClick={() => onToggleWatched(video)}
            className={
              "text-[13px] py-2 px-3 rounded-md border transition " +
              (video.watched
                ? "border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink-dim)]"
                : "border-[var(--color-line)] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]")
            }
            title={video.watched ? "Mark unwatched" : "Mark watched"}
          >
            {video.watched ? "Watched ✓" : "Mark watched"}
          </button>
        </div>

        <div>
          <label className="block text-[10px] font-semibold tracking-[0.12em] uppercase text-[var(--color-ink-faint)] mb-1.5">
            Folder
          </label>
          {editingFolder ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={folderInput}
                onChange={(e) => setFolderInput(e.target.value)}
                list="folders-list"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveFolder();
                  if (e.key === "Escape") {
                    setFolderInput(video.folder ?? "");
                    setEditingFolder(false);
                  }
                }}
                placeholder="No folder"
                className="flex-1 text-[13px] px-2 py-1.5 rounded-md bg-[var(--color-canvas)] border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)]"
              />
              <datalist id="folders-list">
                {knownFolders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              <button
                onClick={saveFolder}
                className="text-[12px] px-2.5 rounded-md bg-[var(--color-surface-2)] hover:bg-[var(--color-line)]"
              >
                Save
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditingFolder(true)}
              className="w-full text-left text-[13px] px-2 py-1.5 rounded-md bg-[var(--color-canvas)] border border-[var(--color-line)] hover:border-[var(--color-line-soft)] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
            >
              {video.folder || (
                <span className="text-[var(--color-ink-faint)]">No folder — click to set</span>
              )}
            </button>
          )}
        </div>

        <div>
          <label className="block text-[10px] font-semibold tracking-[0.12em] uppercase text-[var(--color-ink-faint)] mb-1.5">
            Tags
          </label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {video.user_tags.length === 0 && (
              <span className="text-[12px] text-[var(--color-ink-faint)]">No tags yet</span>
            )}
            {video.user_tags.map((t) => (
              <span
                key={t}
                className="group flex items-center gap-1 text-[12px] px-2 py-[2px] rounded bg-[var(--color-accent-dim)]/40 text-[var(--color-accent)]"
              >
                #{t}
                <button
                  onClick={() => onRemoveTag(video, t)}
                  className="text-[var(--color-ink-faint)] hover:text-[var(--color-danger)] opacity-0 group-hover:opacity-100 transition"
                  title="Remove tag"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <input
            id="vidminder-tag-input"
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitTag();
              if (e.key === "Escape") {
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder={`Add a tag and press Enter (${kbd("T")} to focus)`}
            className="w-full text-[13px] px-2 py-1.5 rounded-md bg-[var(--color-canvas)] border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        {video.description && (
          <div>
            <label className="block text-[10px] font-semibold tracking-[0.12em] uppercase text-[var(--color-ink-faint)] mb-1.5">
              Description
            </label>
            <p className="selectable text-[12.5px] leading-relaxed text-[var(--color-ink-dim)] whitespace-pre-wrap line-clamp-[14]">
              {video.description}
            </p>
          </div>
        )}

        {video.category && (
          <div className="text-[12px] text-[var(--color-ink-faint)]">
            <span className="text-[var(--color-ink-faint)]">Category: </span>
            <span className="text-[var(--color-ink-dim)]">{video.category}</span>
          </div>
        )}

        {video.raw_tags.length > 0 && (
          <details className="text-[12px]">
            <summary className="cursor-pointer text-[var(--color-ink-faint)] hover:text-[var(--color-ink-dim)] select-none">
              Source tags ({video.raw_tags.length})
            </summary>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {video.raw_tags.map((t) => (
                <span
                  key={t}
                  className="text-[11px] px-1.5 py-[1px] rounded text-[var(--color-ink-faint)] bg-[var(--color-surface-2)]"
                >
                  {t}
                </span>
              ))}
            </div>
          </details>
        )}

        <div className="pt-2 border-t border-[var(--color-line)]">
          <button
            onClick={onRequestDelete}
            className="text-[12px] text-[var(--color-ink-faint)] hover:text-[var(--color-danger)] transition"
          >
            Remove from library
          </button>
        </div>
      </div>
    </div>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}
