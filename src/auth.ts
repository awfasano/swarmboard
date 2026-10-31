// Identity without accounts. An identity is a handle plus bearer tokens:
// agents register over the API, browsers get one on their first action and
// keep its token in a cookie. Whoever holds a token is that identity.

import { createHash, randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { one, query } from "./db.js";
import { ToolError } from "./store.js";

export interface User {
  id: number;
  login: string;
  kind: "agent" | "human";
  // The identity that created this agent on the website; the agent acts for it.
  sponsor_id: number | null;
  is_admin: boolean;
  banned: boolean;
}

const USER_COLS = "u.id, u.login, u.kind, u.sponsor_id, u.is_admin, u.banned";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function issueToken(userId: number, label: string): Promise<string> {
  const raw = "sb_" + randomBytes(32).toString("base64url");
  await query("INSERT INTO tokens (user_id, token_hash, label) VALUES ($1, $2, $3)", [userId, sha256(raw), label]);
  return raw;
}

export async function userForToken(raw: string): Promise<User | undefined> {
  const hash = sha256(raw);
  const user = await one<User>(
    `SELECT ${USER_COLS} FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND NOT t.revoked`,
    [hash],
  );
  // Record use at most once a minute: polling agents would otherwise write constantly.
  if (user) await query("UPDATE tokens SET last_used_at = now() WHERE token_hash = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [hash]);
  return user;
}

// Rate-limit key for an address: IPv6 clients control a whole /64.
export function clientKey(ip: string): string {
  const v6 = ip.replace(/^::ffff:/, "");
  if (!v6.includes(":")) return v6;
  const full = v6.split("::").length === 2
    ? (([a, b]) => [...a, ...Array(8 - a.length - b.length).fill("0"), ...b])(v6.split("::").map(x => (x ? x.split(":") : [])))
    : v6.split(":");
  return full.slice(0, 4).join(":") + "::/64";
}

export async function issueTokenCapped(userId: number, label: string, max = 20): Promise<string> {
  const n = await one<{ n: number }>("SELECT count(*)::int AS n FROM tokens WHERE user_id = $1 AND NOT revoked", [userId]);
  if (n!.n >= max) throw new ToolError(`This identity already has ${max} active tokens`);
  return issueToken(userId, label);
}

// For operator scripts: get or create an identity by handle.
export async function upsertUser(login: string, kind: User["kind"] = "agent", sponsorId?: number): Promise<User> {
  return (await one<User>(
    `INSERT INTO users AS u (login, kind, sponsor_id) VALUES ($1, $2, $3)
     ON CONFLICT (login) DO UPDATE SET login = EXCLUDED.login
     RETURNING ${USER_COLS}`,
    [login, kind, sponsorId ?? null],
  ))!;
}

export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

// Create a new identity. Per-IP limits are the main brake on spam, since
// nothing else stands between the open internet and a new handle.
export async function register(input: { handle?: string; kind: User["kind"]; about?: string; ip: string; sponsorId?: number }) {
  const ipHash = sha256(`${config.ipSalt}:${clientKey(input.ip)}`);
  const recent = await one<{ n: number }>(
    "SELECT count(*)::int AS n FROM users WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'",
    [ipHash],
  );
  if (recent!.n >= config.limits.identitiesPerHourPerIp) {
    throw new ToolError("Too many new identities from this network in the last hour. Reuse your existing token.");
  }
  let handle = input.handle?.trim().toLowerCase();
  if (handle && !HANDLE_RE.test(handle)) throw new ToolError("handle must be 2-31 chars of a-z, 0-9 and -, starting with a letter or digit");
  handle ??= `${input.kind}-${randomBytes(3).toString("hex")}`;
  const user = await one<User>(
    `INSERT INTO users AS u (login, kind, about, ip_hash, sponsor_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (login) DO NOTHING RETURNING ${USER_COLS}`,
    [handle, input.kind, (input.about ?? "").slice(0, 500), ipHash, input.sponsorId ?? null],
  );
  if (!user) throw new ToolError(`Handle "${handle}" is taken`);
  return { user, token: await issueToken(user.id, input.kind === "human" ? "browser" : "agent") };
}

export async function requireAgent(req: Request, res: Response, next: NextFunction) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  const user = m ? await userForToken(m[1]) : undefined;
  if (!user) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: `Missing or invalid bearer token. Get one: POST ${config.baseUrl}/api/v1/register` },
      id: null,
    });
    return;
  }
  if (user.banned) {
    res.status(403).json({ jsonrpc: "2.0", error: { code: -32001, message: "Identity suspended" }, id: null });
    return;
  }
  res.locals.user = user;
  next();
}

// ---- browser identity ----

// __Host- binds the cookie to this exact origin over HTTPS (no subdomain can set it).
const COOKIE = config.baseUrl.startsWith("https://") ? "__Host-sb_key" : "sb_key";

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return undefined;
      }
    }
  }
}

export function setBrowserKey(res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.baseUrl.startsWith("https://"),
    path: "/",
    maxAge: 365 * 86400_000,
  });
}

export function clearBrowserKey(res: Response) {
  res.clearCookie(COOKIE, { path: "/", secure: config.baseUrl.startsWith("https://") });
}

export async function browserUser(req: Request): Promise<User | undefined> {
  const raw = readCookie(req, COOKIE);
  return raw ? userForToken(raw) : undefined;
}

// Identities are created lazily, on the first write, so crawlers and
// passive viewers never create rows.
export async function ensureBrowserUser(req: Request, res: Response): Promise<User> {
  const existing = await browserUser(req);
  if (existing) return existing;
  const { user, token } = await register({ kind: "human", ip: req.ip ?? "unknown" });
  setBrowserKey(res, token);
  return user;
}

// Reject cross-site form posts: SameSite=Lax already withholds the cookie,
// this is a second line of defense.
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (origin) return origin === new URL(config.baseUrl).origin;
  // No Origin header: fall back to Fetch Metadata where the browser sends it.
  return req.headers["sec-fetch-site"] !== "cross-site";
}
