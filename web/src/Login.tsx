import { useState } from "react";

export type WebUser = { id: number; email: string };

async function authCall(path: string, body: Record<string, string>): Promise<WebUser> {
  const res = await fetch(`/api/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      /* keep the status */
    }
    throw new Error(message);
  }
  return res.json() as Promise<WebUser>;
}

export function Login({ onLoggedIn }: { onLoggedIn: (u: WebUser) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const u =
        mode === "login"
          ? await authCall("login", { email, password })
          : await authCall("signup", { email, password, invite });
      onLoggedIn(u);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-canvas text-ink">
      <div className="w-full max-w-sm">
        <h1 className="text-[22px] font-bold tracking-tight text-center">VidMinder</h1>
        <p className="mt-1 text-[12.5px] text-ink-faint text-center">
          Your watch-later list, anywhere.
        </p>

        <div className="mt-6 space-y-3">
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full text-[14px] px-3 py-2.5 rounded-md bg-surface border border-line focus:outline-none focus:border-accent"
          />
          <input
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={mode === "login" ? "Password" : "Password (8+ characters)"}
            className="w-full text-[14px] px-3 py-2.5 rounded-md bg-surface border border-line focus:outline-none focus:border-accent"
          />
          {mode === "signup" && (
            <input
              type="text"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="Invite code"
              className="w-full text-[14px] px-3 py-2.5 rounded-md bg-surface border border-line focus:outline-none focus:border-accent"
            />
          )}
          {error && (
            <div className="text-[12px] text-danger bg-danger/10 border border-danger/40 rounded-md px-3 py-2">
              {error}
            </div>
          )}
          <button
            onClick={submit}
            disabled={busy || !email || !password}
            className="w-full text-[14px] font-medium py-2.5 rounded-md bg-accent text-black disabled:opacity-50"
          >
            {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
          </button>
          <button
            onClick={() => {
              setMode(mode === "login" ? "signup" : "login");
              setError(null);
            }}
            className="w-full text-[12.5px] text-ink-faint hover:text-ink transition"
          >
            {mode === "login"
              ? "No account? Sign up with an invite code"
              : "Already have an account? Log in"}
          </button>
        </div>
      </div>
    </div>
  );
}
