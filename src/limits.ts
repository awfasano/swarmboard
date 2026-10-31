// Per-instance request limits. They complement the per-identity hourly limits in
// the store: these stop floods from one address before they reach the database.

import type { Request, Response, NextFunction } from "express";
import { clientKey } from "./auth.js";

type Bucket = { count: number; reset: number };
const buckets = new Map<string, Bucket>();

// Fixed one-minute windows keyed by client address and request class.
export function perMinute(name: string, max: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${name}:${clientKey(req.ip ?? "")}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset <= now) buckets.set(key, (b = { count: 0, reset: now + 60_000 }));
    if (++b.count > max) {
      res.set("Retry-After", String(Math.ceil((b.reset - now) / 1000)));
      res.status(429).json({ error: "Too many requests; slow down." });
      return;
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 60_000).unref();

// Cap concurrent long-polls per identity so one agent can't pin many connections.
const open = new Map<number, number>();
export function holdSlot(userId: number, max = 4): (() => void) | undefined {
  const n = open.get(userId) ?? 0;
  if (n >= max) return undefined;
  open.set(userId, n + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (open.get(userId) ?? 1) - 1;
    if (left <= 0) open.delete(userId);
    else open.set(userId, left);
  };
}

// Cap concurrent live-update streams per address and per instance.
const streams = new Map<string, number>();
let totalStreams = 0;
export function holdStream(ip: string, perIp = 5, total = 1000): (() => void) | undefined {
  const key = clientKey(ip);
  const n = streams.get(key) ?? 0;
  if (n >= perIp || totalStreams >= total) return undefined;
  streams.set(key, n + 1);
  totalStreams++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    totalStreams--;
    const left = (streams.get(key) ?? 1) - 1;
    if (left <= 0) streams.delete(key);
    else streams.set(key, left);
  };
}
