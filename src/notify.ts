// Wake long-polls and live pages when a project changes. Each instance keeps one
// connection LISTENing on a channel that store.emit NOTIFYs, so waiting costs no
// queries. If the listener is down, waiters fall back to short polling.

import { EventEmitter } from "node:events";
import pg from "pg";
import { config } from "./config.js";
import { pool } from "./db.js";

export const CHANNEL = "swarmboard_events";
const bus = new EventEmitter();
bus.setMaxListeners(0);
let listening = false;

let retrying = false;

export async function startListener(): Promise<void> {
  const client = new pg.Client({ connectionString: config.databaseUrl, keepAlive: true });
  let ping: NodeJS.Timeout | undefined;
  // One retry loop at a time, however many ways the connection fails.
  const retry = (delayMs = 5_000) => {
    listening = false;
    clearInterval(ping);
    client.end().catch(() => {});
    if (retrying) return;
    retrying = true;
    setTimeout(() => {
      retrying = false;
      startListener().catch(() => {});
    }, delayMs);
  };
  try {
    await client.connect();
    client.on("notification", msg => bus.emit(`p:${msg.payload}`));
    client.on("error", err => {
      console.error("listener error:", err.message);
      retry();
    });
    await client.query(`LISTEN ${CHANNEL}`);
    // Prove delivery works end to end (some Postgres-compatible servers accept
    // LISTEN but never deliver); otherwise poll, and try again later.
    const probe = `probe-${process.pid}-${Date.now()}`;
    const delivered = new Promise<boolean>(resolve => {
      const t = setTimeout(() => resolve(false), 3_000);
      bus.once(`p:${probe}`, () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    await pool.query(`SELECT pg_notify('${CHANNEL}', $1)`, [probe]).catch(() => {});
    listening = await delivered;
    console.log(listening ? "change notifications: LISTEN/NOTIFY" : "change notifications: polling (NOTIFY not delivered)");
    if (!listening) return retry(60_000);
    // A half-open socket would otherwise look healthy forever.
    ping = setInterval(() => client.query("SELECT 1").catch(() => retry()), 30_000);
  } catch (err) {
    console.error("listener unavailable, polling meanwhile:", (err as Error).message);
    retry();
  }
}

export const isListening = () => listening;

// Resolve when the project changes, the timeout passes, or the signal aborts.
export function changed(projectId: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const wait = listening ? timeoutMs : Math.min(timeoutMs, 1_000);
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      bus.off(`p:${projectId}`, done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, wait);
    bus.on(`p:${projectId}`, done);
    signal?.addEventListener("abort", done);
  });
}

export function subscribe(projectId: number, fn: () => void): () => void {
  bus.on(`p:${projectId}`, fn);
  return () => bus.off(`p:${projectId}`, fn);
}
