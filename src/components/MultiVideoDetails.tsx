import { useEffect, useMemo, useState } from "react";
import type { Playlist, Video } from "../types";
import { kbdClick, shiftClick } from "../platform";

type Props = {
  videos: Video[];
  knownFolders: string[];
  playlists: Playlist[];
  onSetWatched: (videos: Video[], watched: boolean) => void;
  onSetFavorite: (videos: Video[], favorite: boolean) => void;
  onSetFolder: (videos: Video[], folder: string | null) => void;
  onAddTag: (videos: Video[], tag: string) => void;
  onRemoveTag: (videos: Video[], tag: string) => void;
  onAddToPlaylist: (videos: Video[], playlistId: number) => void;
  onRemoveFromPlaylist: (videos: Video[], playlistId: number) => void;
  onCreatePlaylist: (name: string) => Promise<Playlist | null>;
  onDeleteAll: (videos: Video[]) => void;
  onClearSelection: () => void;
};

export function MultiVideoDetails({
  videos,
  knownFolders,
  playlists,
  onSetWatched,
  onSetFavorite,
  onSetFolder,
  onAddTag,
  onRemoveTag,
  onAddToPlaylist,
  onRemoveFromPlaylist,
  onCreatePlaylist,
  onDeleteAll,
  onClearSelection,
}: Props) {
  const [playlistMenuOpen, setPlaylistMenuOpen] = useState(false);
  const [playlistFilter, setPlaylistFilter] = useState("");
  const n = videos.length;
  const [tagInput, setTagInput] = useState("");
  const [folderInput, setFolderInput] = useState("");
  const [editingFolder, setEditingFolder] = useState(false);

  // Derive group-level state for the buttons.
  const watchedAll = videos.every((v) => v.watched);
  const watchedNone = videos.every((v) => !v.watched);
  const watchedMixed = !watchedAll && !watchedNone;

  const favoritedAll = videos.every((v) => v.favorite);
  const favoritedNone = videos.every((v) => !v.favorite);
  const favoritedMixed = !favoritedAll && !favoritedNone;

  // Folder consensus
  const folderSet = useMemo(() => {
    const s = new Set<string>();
    let hasNull = false;
    for (const v of videos) {
      if (v.folder) s.add(v.folder);
      else hasNull = true;
    }
    return { set: s, hasNull };
  }, [videos]);
  const folderConsensus: string | null | "mixed" = useMemo(() => {
    if (folderSet.set.size === 0 && folderSet.hasNull) return null;
    if (folderSet.set.size === 1 && !folderSet.hasNull) {
      return [...folderSet.set][0];
    }
    return "mixed";
  }, [folderSet]);

  // Tag breakdown: shared vs partial vs all-distinct
  const { sharedTags, partialTags } = useMemo(() => {
    const counts = new Map<string, { display: string; count: number }>();
    for (const v of videos) {
      const seen = new Set<string>();
      for (const t of v.user_tags) {
        const k = t.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        const existing = counts.get(k);
        if (existing) existing.count += 1;
        else counts.set(k, { display: t, count: 1 });
      }
    }
    const shared: string[] = [];
    const partial: { tag: string; count: number }[] = [];
    for (const [, info] of counts) {
      if (info.count === n) shared.push(info.display);
      else partial.push({ tag: info.display, count: info.count });
    }
    shared.sort((a, b) => a.localeCompare(b));
    partial.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    return { sharedTags: shared, partialTags: partial };
  }, [videos, n]);

  useEffect(() => {
    setTagInput("");
    setEditingFolder(false);
    setFolderInput(
      folderConsensus && folderConsensus !== "mixed" ? folderConsensus : ""
    );
  }, [videos.map((v) => v.id).join(","), folderConsensus]);

  const submitTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    onAddTag(videos, t);
    setTagInput("");
  };

  const saveFolder = () => {
    const next = folderInput.trim() || null;
    onSetFolder(videos, next);
    setEditingFolder(false);
  };

  // Playlists present on ALL selected (shared) vs SOME (partial).
  const { sharedPlaylists, partialPlaylists } = useMemo(() => {
    const counts = new Map<number, number>();
    for (const v of videos) {
      for (const pid of v.playlist_ids) {
        counts.set(pid, (counts.get(pid) ?? 0) + 1);
      }
    }
    const shared: Playlist[] = [];
    const partial: { pl: Playlist; count: number }[] = [];
    for (const [pid, count] of counts) {
      const pl = playlists.find((p) => p.id === pid);
      if (!pl) continue;
      if (count === n) shared.push(pl);
      else partial.push({ pl, count });
    }
    shared.sort((a, b) => a.name.localeCompare(b.name));
    partial.sort((a, b) => b.count - a.count || a.pl.name.localeCompare(b.pl.name));
    return { sharedPlaylists: shared, partialPlaylists: partial };
  }, [videos, playlists, n]);

  // Watched / favorite labels & next states
  const watchedLabel = watchedAll
    ? "Unmark all watched"
    : "Mark all watched"; // mixed → mark all watched as default
  const onClickWatched = () => onSetWatched(videos, !watchedAll);

  const favLabel = favoritedAll ? "Unstar all" : "Star all";
  const onClickFavorite = () => onSetFavorite(videos, !favoritedAll);

  return (
    <div className="h-full overflow-y-auto border-l border-[var(--color-line)] bg-[var(--color-surface)] flex flex-col">
      <div className="px-5 pt-5 pb-3 border-b border-[var(--color-line)]">
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="text-[15px] font-semibold leading-none">
              {n} videos selected
            </h2>
            <div className="text-[11.5px] text-[var(--color-ink-faint)] mt-1">
              Esc to clear · {kbdClick()} to toggle · {shiftClick} to extend
            </div>
          </div>
          <button
            onClick={onClearSelection}
            className="text-[11.5px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)] transition"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="p-5 space-y-5">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onClickWatched}
            className={
              "text-[12.5px] py-2 px-3 rounded-md border transition inline-flex items-center justify-center gap-1.5 " +
              (watchedAll
                ? "border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink-dim)]"
                : "border-[var(--color-line)] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]")
            }
            title={
              watchedMixed
                ? "Selection has a mix of watched and unwatched — marking all as watched"
                : ""
            }
          >
            {watchedMixed && (
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]/70" />
            )}
            <span>{watchedLabel}</span>
          </button>
          <button
            onClick={onClickFavorite}
            className={
              "text-[12.5px] py-2 px-3 rounded-md border transition inline-flex items-center justify-center gap-1.5 " +
              (favoritedAll
                ? "border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink-dim)]"
                : "border-[var(--color-line)] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]")
            }
            title={
              favoritedMixed
                ? "Selection has a mix of favorited and not — starring all"
                : ""
            }
          >
            {favoritedMixed && (
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]/70" />
            )}
            <span>{favLabel}</span>
          </button>
        </div>

        <div>
          <label className="block text-[10px] font-semibold tracking-[0.12em] uppercase text-[var(--color-ink-faint)] mb-1.5">
            Folder
            {folderConsensus === "mixed" && (
              <span className="ml-2 text-[10px] normal-case tracking-normal text-[var(--color-accent)]/85">
                mixed
              </span>
            )}
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
                  if (e.key === "Escape") setEditingFolder(false);
                }}
                placeholder={
                  folderConsensus === "mixed"
                    ? "Type to set all selected to one folder"
                    : "Folder name (blank to clear)"
                }
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
                Apply
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditingFolder(true)}
              className="w-full text-left text-[13px] px-2 py-1.5 rounded-md bg-[var(--color-canvas)] border border-[var(--color-line)] hover:border-[var(--color-line-soft)] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
            >
              {folderConsensus === "mixed" ? (
                <span className="text-[var(--color-ink-faint)]">
                  Mixed — click to set all
                </span>
              ) : folderConsensus ? (
                folderConsensus
              ) : (
                <span className="text-[var(--color-ink-faint)]">
                  No folder — click to set
                </span>
              )}
            </button>
          )}
        </div>

        <div>
          <label className="block text-[10px] font-semibold tracking-[0.12em] uppercase text-[var(--color-ink-faint)] mb-1.5">
            Tags
            <span className="ml-2 text-[10px] normal-case tracking-normal text-[var(--color-ink-faint)]">
              shared · partial
            </span>
          </label>
          {sharedTags.length === 0 && partialTags.length === 0 && (
            <div className="text-[12px] text-[var(--color-ink-faint)] mb-2">
              None of the selected videos are tagged.
            </div>
          )}
          {sharedTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {sharedTags.map((t) => (
                <span
                  key={"s-" + t}
                  className="group flex items-center gap-1 text-[12px] px-2 py-[2px] rounded bg-[var(--color-accent-dim)]/40 text-[var(--color-accent)]"
                  title="Present on all selected videos"
                >
                  #{t}
                  <button
                    onClick={() => onRemoveTag(videos, t)}
                    className="text-[var(--color-ink-faint)] hover:text-[var(--color-danger)] opacity-0 group-hover:opacity-100 transition"
                    title={`Remove #${t} from all`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {partialTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {partialTags.map(({ tag, count }) => (
                <span
                  key={"p-" + tag}
                  className="group flex items-center gap-1 text-[12px] px-2 py-[2px] rounded bg-[var(--color-surface-2)] text-[var(--color-ink-dim)] border border-dashed border-[var(--color-line)]"
                  title={`Present on ${count} of ${n} — click + to add to remaining, × to remove from those that have it`}
                >
                  #{tag}
                  <span className="text-[10px] text-[var(--color-ink-faint)] tabular-nums">
                    {count}/{n}
                  </span>
                  <button
                    onClick={() => onAddTag(videos, tag)}
                    className="text-[var(--color-ink-faint)] hover:text-[var(--color-accent)] opacity-0 group-hover:opacity-100 transition"
                    title={`Add #${tag} to remaining ${n - count}`}
                  >
                    +
                  </button>
                  <button
                    onClick={() => onRemoveTag(videos, tag)}
                    className="text-[var(--color-ink-faint)] hover:text-[var(--color-danger)] opacity-0 group-hover:opacity-100 transition"
                    title={`Remove #${tag} from ${count} that have it`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            id="vidminder-tag-input"
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitTag();
              if (e.key === "Escape") (e.target as HTMLInputElement).blur();
            }}
            placeholder={`Add a tag to all ${n} (Enter to apply)`}
            className="w-full text-[13px] px-2 py-1.5 rounded-md bg-[var(--color-canvas)] border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        <div>
          <label className="block text-[10px] font-semibold tracking-[0.12em] uppercase text-[var(--color-ink-faint)] mb-1.5">
            Playlists
            <span className="ml-2 text-[10px] normal-case tracking-normal text-[var(--color-ink-faint)]">
              shared · partial
            </span>
          </label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {sharedPlaylists.length === 0 && partialPlaylists.length === 0 && (
              <span className="text-[12px] text-[var(--color-ink-faint)]">
                None of the selected are in a playlist.
              </span>
            )}
            {sharedPlaylists.map((pl) => (
              <span
                key={"s" + pl.id}
                className="group flex items-center gap-1 text-[12px] px-2 py-[2px] rounded bg-[var(--color-surface-2)] text-[var(--color-ink-dim)] border border-[var(--color-line)]"
                title="In all selected"
              >
                {pl.name}
                <button
                  onClick={() => onRemoveFromPlaylist(videos, pl.id)}
                  className="text-[var(--color-ink-faint)] hover:text-[var(--color-danger)] opacity-0 group-hover:opacity-100 transition"
                  title={`Remove all from ${pl.name}`}
                >
                  ×
                </button>
              </span>
            ))}
            {partialPlaylists.map(({ pl, count }) => (
              <span
                key={"p" + pl.id}
                className="group flex items-center gap-1 text-[12px] px-2 py-[2px] rounded bg-[var(--color-surface-2)] text-[var(--color-ink-dim)] border border-dashed border-[var(--color-line)]"
                title={`In ${count} of ${n}`}
              >
                {pl.name}
                <span className="text-[10px] text-[var(--color-ink-faint)] tabular-nums">
                  {count}/{n}
                </span>
                <button
                  onClick={() => onAddToPlaylist(videos, pl.id)}
                  className="text-[var(--color-ink-faint)] hover:text-[var(--color-accent)] opacity-0 group-hover:opacity-100 transition"
                  title={`Add remaining ${n - count} to ${pl.name}`}
                >
                  +
                </button>
                <button
                  onClick={() => onRemoveFromPlaylist(videos, pl.id)}
                  className="text-[var(--color-ink-faint)] hover:text-[var(--color-danger)] opacity-0 group-hover:opacity-100 transition"
                  title={`Remove from the ${count} that have it`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="relative">
            <button
              onClick={() => {
                setPlaylistMenuOpen((x) => !x);
                setPlaylistFilter("");
              }}
              className="text-[12px] px-2.5 py-1 rounded-md border border-[var(--color-line)] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface-2)] transition"
            >
              + Add all to playlist
            </button>
            {playlistMenuOpen && (
              <div className="absolute z-20 mt-1 w-full max-w-[260px] rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] shadow-xl p-1.5">
                <input
                  autoFocus
                  value={playlistFilter}
                  onChange={(e) => setPlaylistFilter(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === "Escape") setPlaylistMenuOpen(false);
                    if (e.key === "Enter") {
                      const name = playlistFilter.trim();
                      const existing = playlists.find(
                        (p) => p.name.toLowerCase() === name.toLowerCase()
                      );
                      if (existing) onAddToPlaylist(videos, existing.id);
                      else if (name) {
                        const pl = await onCreatePlaylist(name);
                        if (pl) onAddToPlaylist(videos, pl.id);
                      }
                      setPlaylistMenuOpen(false);
                    }
                  }}
                  placeholder="Filter or type a new name…"
                  className="w-full text-[12.5px] px-2 py-1 rounded bg-[var(--color-canvas)] border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)] mb-1"
                />
                <div className="max-h-40 overflow-y-auto">
                  {playlists
                    .filter((p) =>
                      p.name.toLowerCase().includes(playlistFilter.trim().toLowerCase())
                    )
                    .map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          onAddToPlaylist(videos, p.id);
                          setPlaylistMenuOpen(false);
                        }}
                        className="w-full text-left text-[12.5px] px-2 py-1 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
                      >
                        {p.name}
                      </button>
                    ))}
                  {playlistFilter.trim() &&
                    !playlists.some(
                      (p) => p.name.toLowerCase() === playlistFilter.trim().toLowerCase()
                    ) && (
                      <button
                        onClick={async () => {
                          const pl = await onCreatePlaylist(playlistFilter.trim());
                          if (pl) onAddToPlaylist(videos, pl.id);
                          setPlaylistMenuOpen(false);
                        }}
                        className="w-full text-left text-[12.5px] px-2 py-1 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-accent)]"
                      >
                        + Create “{playlistFilter.trim()}”
                      </button>
                    )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="pt-2 border-t border-[var(--color-line)]">
          <button
            onClick={() => {
              if (
                !confirm(
                  `Remove ${n} ${n === 1 ? "video" : "videos"} from your library?`
                )
              )
                return;
              onDeleteAll(videos);
            }}
            className="text-[12px] text-[var(--color-ink-faint)] hover:text-[var(--color-danger)] transition"
          >
            Remove {n} from library
          </button>
        </div>
      </div>
    </div>
  );
}
