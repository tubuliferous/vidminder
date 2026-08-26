// Password hashing + session management on Web Crypto (no native argon2/bcrypt
// in Workers). PBKDF2-SHA256 with per-user random salts. Iterations are kept
// modest because Workers Free caps CPU time per invocation (~10ms) — this is a
// personal watch-later list, and signup is invite-gated, so the threat model
// is a leaked DB dump, not a nation state.
const PBKDF2_ITERATIONS = 50_000;
const SESSION_DAYS = 90;

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf.buffer);
}

export async function hashPassword(
  password: string,
  saltHex?: string
): Promise<{ hash: string; salt: string }> {
  const salt = saltHex ?? randomHex(16);
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: enc.encode(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    256
  );
  return { hash: toHex(bits), salt };
}

export async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string
): Promise<boolean> {
  const { hash } = await hashPassword(password, salt);
  // Constant-time-ish comparison (both are fixed-length hex of equal size).
  if (hash.length !== expectedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) {
    diff |= hash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  }
  return diff === 0;
}

export function newSessionToken(): string {
  return randomHex(32);
}

export function sessionExpiry(now: number): number {
  return now + SESSION_DAYS * 86400;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `vm_session=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export function readSessionToken(req: Request): string | null {
  const cookie = req.headers.get("Cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)vm_session=([a-f0-9]+)/);
  return m ? m[1] : null;
}
