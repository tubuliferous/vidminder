import { useEffect } from "react";

export type MenuItem =
  | { kind?: "item"; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }
  | { kind: "separator" };

type Props = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

/// A lightweight right-click menu, positioned at screen coords. Mirrors the
/// Sidebar TagContextMenu pattern: closes on any outside click, another
/// right-click, scroll, or Escape. Clicking an item runs it and then closes.
export function ContextMenu({ x, y, items, onClose }: Props) {
  useEffect(() => {
    const close = () => onClose();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{ position: "fixed", left: x, top: y, zIndex: 1000 }}
      className="min-w-[190px] max-h-[80vh] overflow-y-auto rounded-md border border-line bg-surface shadow-xl py-1 text-[12.5px]"
    >
      {items.map((item, i) =>
        "kind" in item && item.kind === "separator" ? (
          <div key={`sep-${i}`} className="my-1 border-t border-line" />
        ) : (
          <button
            key={`item-${i}`}
            disabled={(item as { disabled?: boolean }).disabled}
            onClick={() => {
              (item as { onClick: () => void }).onClick();
              onClose();
            }}
            className={
              "block w-full text-left px-3 py-1.5 transition disabled:opacity-40 disabled:cursor-default " +
              ((item as { danger?: boolean }).danger
                ? "text-ink-dim hover:bg-surface-2 hover:text-danger"
                : "text-ink-dim hover:bg-surface-2 hover:text-ink")
            }
          >
            {(item as { label: string }).label}
          </button>
        )
      )}
    </div>
  );
}
