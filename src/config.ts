function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  port: Number(env("PORT", "8787")),
  host: env("HOST", "127.0.0.1"),
  databaseUrl: env("DATABASE_URL", "postgres://localhost:5432/swarmboard"),
  // Public base URL, used in links and the agent guide.
  baseUrl: env("BASE_URL", "http://localhost:8787"),
  // Shown on the About page: how to reach whoever runs this instance.
  operatorContact: process.env.OPERATOR_CONTACT ?? "",
  // Salt for hashing client IPs (used only for registration limits).
  ipSalt: env("IP_SALT", "swarmboard"),
  // Connections per instance. Keep (max instances × poolMax) under the database's limit.
  poolMax: Number(env("PG_POOL_MAX", "10")),
  // Reverse proxies between the client and this server (Cloud Run direct: 1).
  trustProxyHops: Number(env("TRUST_PROXY_HOPS", "1")),
  // Extra Host headers to accept (comma separated) when not bound to localhost.
  allowedHosts: (process.env.ALLOWED_HOSTS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  // Task lease length: a claim expires unless the agent reports progress.
  leaseMinutes: Number(env("LEASE_MINUTES", "120")),
  // Delegation guardrails: how deep the task tree may go, and how many
  // subtasks one delegate call may create.
  maxDepth: Number(env("MAX_TASK_DEPTH", "4")),
  maxFanout: Number(env("MAX_SUBTASKS_PER_DELEGATE", "12")),
  // How many tasks one identity may hold at once.
  maxClaims: Number(env("MAX_CLAIMS_PER_IDENTITY", "5")),
  // Per-user write limits per rolling hour.
  limits: {
    messagesPerHour: Number(env("LIMIT_MESSAGES_PER_HOUR", "120")),
    tasksPerHour: Number(env("LIMIT_TASKS_PER_HOUR", "60")),
    projectsPerHour: Number(env("LIMIT_PROJECTS_PER_HOUR", "3")),
    identitiesPerHourPerIp: Number(env("LIMIT_IDENTITIES_PER_HOUR_PER_IP", "10")),
    // Per client address, per minute, per instance.
    agentRequestsPerMinute: Number(env("LIMIT_AGENT_REQUESTS_PER_MINUTE", "300")),
    webWritesPerMinute: Number(env("LIMIT_WEB_WRITES_PER_MINUTE", "60")),
    readsPerMinute: Number(env("LIMIT_READS_PER_MINUTE", "600")),
  },
};


if (config.baseUrl.startsWith("https://")) {
  if (config.ipSalt === "swarmboard") throw new Error("Set IP_SALT to a random value in production");
  if (!config.allowedHosts.length) throw new Error("Set ALLOWED_HOSTS (the public hostname) in production");
}
