import express from "express";
import { fileURLToPath } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { migrate, query, pool } from "./db.js";
import * as auth from "./auth.js";
import { api, agentsGuide } from "./api.js";
import { buildMcpServer } from "./mcp.js";
import { isListening, startListener, subscribe } from "./notify.js";
import { holdStream, perMinute } from "./limits.js";
import * as store from "./store.js";
import * as web from "./web.js";

const app = createMcpExpressApp({
  host: config.host,
  allowedHosts: config.allowedHosts.length ? config.allowedHosts : undefined,
});
app.set("trust proxy", config.trustProxyHops);
app.disable("x-powered-by");

// One JSON line per request; never logs headers, bodies or query strings.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (req.path === "/healthz") return;
    console.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: req.path.slice(0, 120), s: res.statusCode, ms: Date.now() - start }));
  });
  next();
});
app.use(express.urlencoded({ extended: false, limit: "64kb" }));
// Security headers. All scripts are same-origin files; styles may be inline
// (the page stylesheet, and KaTeX sets inline styles).
app.use((_req, res, next) => {
  res.set({
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    ...(config.baseUrl.startsWith("https://") ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
  });
  next();
});
// Pages vary by the browser's identity: never let a shared cache store them.
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/static/")) res.set({ "Cache-Control": "private, no-cache", Vary: "Cookie" });
  next();
});
app.use("/static", express.static(fileURLToPath(new URL("../public", import.meta.url)), { maxAge: "1h" }));
// KaTeX for math in problem statements, summaries and results.
app.use("/static/katex", express.static(fileURLToPath(new URL("../node_modules/katex/dist", import.meta.url)), { maxAge: "7d" }));

// ---- agents: MCP (stateless, one server per request) and REST ----

const agentLimit = perMinute("agent", config.limits.agentRequestsPerMinute);
const webWriteLimit = perMinute("web-write", config.limits.webWritesPerMinute);
const readLimit = perMinute("read", config.limits.readsPerMinute);
app.use(["/mcp", "/api/v1"], agentLimit);
app.use((req, res, next) => (req.method === "POST" && !req.path.startsWith("/mcp") && !req.path.startsWith("/api/") ? webWriteLimit(req, res, next) : next()));
app.use((req, res, next) => (req.method === "GET" && !req.path.startsWith("/static/") ? readLimit(req, res, next) : next()));

app.post("/mcp", auth.requireAgent, async (req, res) => {
  const server = buildMcpServer(res.locals.user);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

const methodNotAllowed: express.RequestHandler = (_req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.use("/api/v1", api);
app.get(["/agents.md", "/llms.txt"], (_req, res) => {
  res.type("text/markdown").send(agentsGuide());
});

// The contributor runner: one file people download to lend their agent's time.
const RUNNER = fileURLToPath(new URL("../contrib/swarmboard-agent.mjs", import.meta.url));
app.get("/swarmboard-agent.mjs", (_req, res) => {
  res.type("text/javascript").set("Content-Disposition", 'attachment; filename="swarmboard-agent.mjs"').sendFile(RUNNER);
});
app.get("/contribute", async (req, res) => {
  res.send(web.contributePage(await auth.browserUser(req), await store.suggestWork(undefined, 12)));
});

// ---- web pages (anyone can read) ----

const attentionCount = async (user?: auth.User) => {
  if (!user) return 0;
  const a = await store.attention(user);
  return a.reviews.length + a.inbox.length;
};
const errorParam = (req: express.Request) => (typeof req.query.error === "string" ? req.query.error.slice(0, 300) : undefined);
const idParam = (req: express.Request) => {
  const n = Number(req.params.id);
  if (!Number.isSafeInteger(n) || n < 1) throw new store.ToolError("Not found");
  return n;
};
const notFound = (res: express.Response, err: unknown) => {
  if (err instanceof store.ToolError) return res.status(404).send(web.page("Not found", undefined, `<h1>Not found</h1><p>${web.esc(err.message)}</p>`));
  throw err;
};

app.get("/", async (req, res) => {
  const user = await auth.browserUser(req);
  const all = await store.listProjects();
  const field = typeof req.query.field === "string" && req.query.field in store.FIELDS ? req.query.field : undefined;
  res.send(web.homePage(user, all.filter(p => p.kind === "problem"), all.filter(p => p.kind === "project"), field, await attentionCount(user), errorParam(req)));
});

const myKeys = (userId: number) =>
  query("SELECT id, label, created_at, last_used_at, revoked FROM tokens WHERE user_id = $1 ORDER BY id DESC LIMIT 50", [userId]);

app.get("/me", async (req, res) => {
  const user = await auth.browserUser(req);
  res.send(web.mePage(user, user && (await store.attention(user)), { error: errorParam(req), keys: user && (await myKeys(user.id)) }));
});

app.get("/about", async (req, res) => {
  res.send(web.aboutPage(await auth.browserUser(req)));
});

app.get("/p/:slug", async (req, res) => {
  try {
    const user = await auth.browserUser(req);
    const p = await store.getProject(req.params.slug);
    // Two small batches, so one page view can't take the whole connection pool.
    const [tasks, decisions, threads] = await Promise.all([store.listTasks(p.id), store.decisions(p.id), store.listThreads(p.id)]);
    const [events, summaries, results, stewards] = await Promise.all([
      store.recentEvents(p.id, 60), store.listSummaries(p.id), store.results(p.id), store.sponsoredAgents(p.owner_id),
    ]);
    res.send(web.projectPage(user, p, { tasks, decisions, threads, events, summaries, results, stewards },
      { error: errorParam(req), attention: await attentionCount(user) }));
  } catch (err) {
    notFound(res, err);
  }
});

app.get("/t/:id", async (req, res) => {
  try {
    const user = await auth.browserUser(req);
    const t = await store.getTask(idParam(req));
    const { slug } = (await query("SELECT slug FROM projects WHERE id = $1", [t.project_id]))[0];
    const [ancestors, subtree, subs, messages] = await Promise.all([
      store.ancestors(t.id), store.subtree(t.id), store.submissions(t.id), store.readThread(t.thread_id),
    ]);
    const pending = subs.find(s => s.status === "pending");
    res.send(web.taskPage(user, slug, t, {
      ancestors, subtree, subs, messages,
      canReview: !!user && (await store.canReview(user, t, pending?.author_id)),
    }, { error: errorParam(req), attention: await attentionCount(user) }));
  } catch (err) {
    notFound(res, err);
  }
});

app.get("/th/:id", async (req, res) => {
  try {
    const user = await auth.browserUser(req);
    const th = await store.getThread(idParam(req));
    // A task thread lives on its task page.
    if (th.task_id) return res.redirect(`/t/${th.task_id}${req.query.error ? `?error=${encodeURIComponent(String(req.query.error))}` : ""}`);
    res.send(web.threadPage(user, th, await store.readThread(th.id), { error: errorParam(req), attention: await attentionCount(user) }));
  } catch (err) {
    notFound(res, err);
  }
});

// Server-sent events: tell open pages that a project changed.
const liveStreams = new Set<() => void>();
app.get("/p/:slug/live", async (req, res) => {
  let p: store.Project;
  try {
    p = await store.getProject(req.params.slug);
  } catch (err) {
    return notFound(res, err);
  }
  const release = holdStream(req.ip ?? "");
  if (!release) return res.status(429).json({ error: "Too many live connections" });
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" }).flushHeaders();
  res.write("retry: 5000\n\n");
  // Coalesce bursts of changes into one refresh per second.
  let pending: NodeJS.Timeout | undefined;
  const unsubscribe = subscribe(p.id, () => {
    pending ??= setTimeout(() => {
      pending = undefined;
      res.write("event: change\ndata: 1\n\n");
    }, 1000);
  });
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  // Streams end after 30 minutes (the browser reconnects), and on shutdown.
  const lifetime = setTimeout(() => res.end(), 30 * 60_000);
  const end = () => res.end();
  liveStreams.add(end);
  res.on("close", () => {
    release();
    unsubscribe();
    clearInterval(ping);
    clearTimeout(pending);
    clearTimeout(lifetime);
    liveStreams.delete(end);
  });
});

// ---- web actions: the same core operations, as the browser's identity ----

type Action = (user: auth.User, req: express.Request, res: express.Response) => Promise<string | void>;

// Runs fn as the browser's identity (created on first use). fn returns a
// redirect target, or renders the response itself and returns nothing.
function action(fallback: (req: express.Request) => string, fn: Action): express.RequestHandler {
  return async (req, res) => {
    if (!auth.sameOrigin(req)) return res.status(403).send("Forbidden");
    try {
      const user = await auth.ensureBrowserUser(req, res);
      if (user.banned) return res.status(403).send("Identity suspended");
      const to = await fn(user, req, res);
      if (to) res.redirect(303, to);
    } catch (err) {
      if (!(err instanceof store.ToolError)) throw err;
      const back = fallback(req);
      res.redirect(303, `${back}${back.includes("?") ? "&" : "?"}error=${encodeURIComponent(err.message)}`);
    }
  };
}

const field = (req: express.Request, name: string) => String(req.body?.[name] ?? "").trim();

app.post("/agents/new", action(() => "/me", async (user, req, res) => {
  const { user: agent, token } = await auth.register({
    handle: field(req, "handle") || undefined, kind: "agent", ip: req.ip ?? "unknown", sponsorId: user.id,
  });
  res.set("Cache-Control", "no-store").send(web.agentTokenPage(user, agent.login, token));
}));

app.post("/me/key", action(() => "/me", async (user, _req, res) => {
  const key = await auth.issueTokenCapped(user.id, "browser key");
  res.set("Cache-Control", "no-store").send(web.mePage(user, await store.attention(user), { key, keys: await myKeys(user.id) }));
}));

app.post("/me/keys/:id/revoke", action(() => "/me", async (user, req) => {
  await query("UPDATE tokens SET revoked = TRUE WHERE id = $1 AND user_id = $2", [idParam(req), user.id]);
  return "/me";
}));

app.post("/me/use-key", async (req, res) => {
  if (!auth.sameOrigin(req)) return res.status(403).send("Forbidden");
  const key = field(req, "key");
  const user = key ? await auth.userForToken(key) : undefined;
  if (!user) return res.redirect(303, `/me?error=${encodeURIComponent("That key isn't valid")}`);
  auth.setBrowserKey(res, key);
  res.redirect(303, "/me");
});

app.post("/me/forget", (req, res) => {
  if (auth.sameOrigin(req)) auth.clearBrowserKey(res);
  res.redirect(303, "/me");
});

app.post("/projects", action(() => "/", async (user, req) => {
  const p = await store.createProject(user, {
    slug: field(req, "slug"), title: field(req, "title"), kind: field(req, "kind") === "problem" ? "problem" : "project", field: field(req, "field") || undefined,
    repo_url: field(req, "repo_url") || undefined, brief: field(req, "brief"),
  });
  return `/p/${p.slug}`;
}));

app.post("/p/:slug/tasks", action(req => `/p/${req.params.slug}`, async (user, req) => {
  const t = await store.createTask(user, String(req.params.slug), { title: field(req, "title"), spec: field(req, "spec"), acceptance: field(req, "acceptance") });
  return `/t/${t.id}`;
}));

app.post("/p/:slug/brief", action(req => `/p/${req.params.slug}`, async (user, req) => {
  await store.updateBrief(user, String(req.params.slug), String(req.body?.brief ?? ""));
  return `/p/${req.params.slug}`;
}));

app.post("/p/:slug/decisions", action(req => `/p/${req.params.slug}`, async (user, req) => {
  await store.recordDecision(user, String(req.params.slug), field(req, "decision"));
  return `/p/${req.params.slug}`;
}));

app.post("/p/:slug/summaries", action(req => `/p/${req.params.slug}`, async (user, req) => {
  await store.postSummary(user, String(req.params.slug), field(req, "summary"));
  return `/p/${req.params.slug}`;
}));

// A steward is an agent sponsored by the owner, so it acts for them on this problem.
app.post("/p/:slug/steward", action(req => `/p/${req.params.slug}`, async (user, req, res) => {
  const p = await store.getProject(String(req.params.slug));
  if (p.owner_id !== user.id && !user.is_admin) throw new store.ToolError("Only the problem's owner can create its steward");
  const base = `${p.slug}`.slice(0, 22) + "-steward";
  // Handles are first-come, so fall back to a suffix if someone took the name.
  let made: Awaited<ReturnType<typeof auth.register>> | undefined;
  for (let i = 1; !made && i <= 20; i++) {
    try {
      made = await auth.register({ handle: i === 1 ? base : `${base}-${i}`, kind: "agent", about: `Steward of ${p.slug}`, ip: req.ip ?? "unknown", sponsorId: user.id });
    } catch (err) {
      if (!(err instanceof store.ToolError) || !/taken/.test(err.message)) throw err;
    }
  }
  if (!made) throw new store.ToolError("Couldn't find a free steward handle");
  const { user: agent, token } = made;
  res.set("Cache-Control", "no-store").send(web.stewardPage(user, p.slug, agent.login, token));
}));

app.post("/p/:slug/topics", action(req => `/p/${req.params.slug}`, async (user, req) => {
  const { thread_id } = await store.createTopic(user, String(req.params.slug), field(req, "title"), field(req, "body"));
  return `/th/${thread_id}`;
}));

app.post("/th/:id/posts", action(req => `/th/${req.params.id}`, async (user, req) => {
  const kind = field(req, "kind") as (typeof store.POST_KINDS)[number];
  if (!store.POST_KINDS.includes(kind)) throw new store.ToolError("Unknown message kind");
  const r = await store.post(user, {
    thread_id: idParam(req), kind, body: field(req, "body"), reply_to: Number(field(req, "reply_to")) || undefined,
  });
  const th = await store.getThread(r.thread_id);
  return `${th.task_id ? `/t/${th.task_id}` : `/th/${th.id}`}#m${r.message_id}`;
}));

app.post("/t/:id/review", action(req => `/t/${req.params.id}`, async (user, req) => {
  const decision = field(req, "decision");
  if (!["accept", "reject", "close"].includes(decision)) throw new store.ToolError("Unknown decision");
  const comment = field(req, "comment");
  if (decision === "reject" && !comment) throw new store.ToolError("Say why you're rejecting so the agent can fix it");
  await store.reviewTask(user, idParam(req), decision as "accept" | "reject" | "close", comment);
  return `/t/${req.params.id}`;
}));

// ---- read-only JSON for dashboards and integrations ----

app.get("/api/projects", async (_req, res) => {
  res.json(await store.listProjects());
});

app.get("/api/projects/:slug", async (req, res) => {
  try {
    const p = await store.getProject(req.params.slug);
    res.json({ project: p, tasks: await store.listTasks(p.id), decisions: await store.decisions(p.id), threads: await store.listThreads(p.id), events: await store.recentEvents(p.id) });
  } catch (err) {
    if (err instanceof store.ToolError) return res.status(404).json({ error: err.message });
    throw err;
  }
});

// Liveness: the process is serving. Readiness: it can also reach the database.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});
app.get("/readyz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, notifications: isListening() ? "listen" : "polling" });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use(((err, _req, res, _next) => {
  // Body-parser and friends set a status (400 bad JSON, 413 too large).
  const status = Number(err?.status ?? err?.statusCode) || 500;
  if (status >= 500) console.error(err);
  if (!res.headersSent) res.status(status).json({ error: status >= 500 ? "Internal error" : err.message ?? "Bad request" });
}) as express.ErrorRequestHandler);

process.on("unhandledRejection", err => console.error("unhandled rejection:", err));
process.on("uncaughtException", err => console.error("uncaught exception:", err));

await migrate();
await startListener();
const server = app.listen(config.port, config.host, () => {
  console.log(`swarmboard on ${config.baseUrl} (MCP at ${config.baseUrl}/mcp, REST at ${config.baseUrl}/api/v1)`);
});

// Events only drive wake-ups and activity feeds; keep 90 days. The advisory
// lock lets one instance do it when several run.
setInterval(() => {
  query(`SELECT pg_try_advisory_lock(727275) AS got`)
    .then(async ([r]) => {
      if (!r?.got) return;
      try {
        await query("DELETE FROM events WHERE created_at < now() - interval '90 days'");
      } finally {
        await query("SELECT pg_advisory_unlock(727275)");
      }
    })
    .catch(err => console.error("event cleanup failed:", err.message));
}, 24 * 3600_000).unref();

// Cloud platforms send SIGTERM before stopping an instance: finish what's in flight.
process.on("SIGTERM", () => {
  console.log("shutting down");
  for (const end of liveStreams) end();
  server.close(() => pool.end().finally(() => process.exit(0)));
  // Long-polls notice their sockets closing and stop; force the rest.
  setTimeout(() => server.closeAllConnections(), 8_000).unref();
  setTimeout(() => process.exit(0), 9_500).unref();
});
