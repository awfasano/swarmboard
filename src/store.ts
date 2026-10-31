import { config } from "./config.js";
import { one, query } from "./db.js";
import { CHANNEL, changed } from "./notify.js";
import type { User } from "./auth.js";

// Errors with a message that is safe and useful to show to the caller.
export class ToolError extends Error {}

export const FIELDS = {
  mathematics: "Mathematics",
  "computer-science": "Computer Science",
  economics: "Economics",
  physics: "Physics",
  biology: "Biology & Medicine",
  climate: "Earth & Climate",
  other: "Other",
} as const;
export type Field = keyof typeof FIELDS;

export interface Project {
  id: number;
  slug: string;
  kind: "project" | "problem";
  field: Field;
  title: string;
  repo_url: string | null;
  brief: string;
  owner_id: number;
  owner: string;
  featured: boolean;
}

export interface Task {
  id: number;
  project_id: number;
  parent_id: number | null;
  depth: number;
  title: string;
  spec: string;
  acceptance: string;
  depends_on: number[];
  status: "open" | "claimed" | "submitted" | "done" | "closed";
  created_by: number;
  creator: string;
  claimed_by: number | null;
  claimer: string | null;
  lease_expires_at: Date | null;
  paths: string[];
  progress: string;
  thread_id: number;
  updated_at: Date;
}

export type BoardTask = Task & { blocked_by: number[]; children_total: number; children_done: number };

export interface Submission {
  id: number;
  task_id: number;
  author_id: number;
  author: string;
  url: string | null;
  content: string | null;
  content_type: "text" | "markdown" | "patch" | "json";
  note: string;
  status: "pending" | "accepted" | "rejected";
  reviewer: string | null;
  review_comment: string | null;
  created_at: Date;
}

export interface Message {
  id: number;
  thread_id: number;
  kind: MessageKind;
  author: string;
  to: string | null;
  reply_to: number | null;
  depth: number;
  body: string;
  resolved: boolean;
  created_at: Date;
}

export const CONTENT_TYPES = ["text", "markdown", "patch", "json"] as const;
export const POST_KINDS = ["note", "question", "answer", "blocker", "handoff"] as const;
export type MessageKind = (typeof POST_KINDS)[number] | "decision" | "escalation";
const ASKING = ["question", "blocker", "handoff", "escalation"];
const MAX_CONTENT = 200_000;

const TASK_COLS = `t.*, cu.login AS creator, ku.login AS claimer, th.id AS thread_id`;
const TASK_FROM = `tasks t JOIN users cu ON cu.id = t.created_by LEFT JOIN users ku ON ku.id = t.claimed_by
                   JOIN threads th ON th.task_id = t.id`;
const ACTIVE = `('open','claimed','submitted')`;

// ---- helpers ----

async function rateLimit(user: User, table: "messages" | "tasks" | "projects", max: number) {
  if (user.is_admin) return;
  const col = table === "messages" ? "author_id" : table === "tasks" ? "created_by" : "owner_id";
  const row = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1 AND created_at > now() - interval '1 hour'`,
    [user.id],
  );
  if (row!.n >= max) throw new ToolError(`Rate limit: at most ${max} ${table} per hour. Try again later.`);
}

function text(value: string | undefined, field: string, max: number): string {
  const v = (value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!v) throw new ToolError(`${field} must not be empty`);
  if (v.length > max) throw new ToolError(`${field} is too long (max ${max} chars)`);
  return v;
}

const ids = (xs: (number | null | undefined)[]) => [...new Set(xs.filter((x): x is number => !!x))];

// An agent created by someone (its sponsor) acts for them, so a problem
// owner's steward agent can summarize, review and decide on their behalf.
export const actsFor = (user: User, ownerId: number) => user.is_admin || user.id === ownerId || user.sponsor_id === ownerId;

async function emit(
  projectId: number,
  type: string,
  summary: string,
  opts: { taskId?: number; threadId?: number; actor?: User; audience?: (number | null | undefined)[] } = {},
) {
  const audience = ids(opts.audience ?? []).filter(x => x !== opts.actor?.id);
  await query(
    `INSERT INTO events (project_id, task_id, thread_id, actor_id, type, audience, summary) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [projectId, opts.taskId ?? null, opts.threadId ?? null, opts.actor?.id ?? null, type, audience, summary],
  );
  await query(`SELECT pg_notify('${CHANNEL}', $1)`, [String(projectId)]);
  projectCache.clear();
}

// Claims are leases: if an agent stops reporting progress, the task reopens.
// A task stays claimed while another agent is actually working one of its
// subtasks; open, unclaimed stubs don't keep a claim alive.
async function expireLeases(projectId: number) {
  // Cheap check first: this runs on reads and long-polls, so avoid writes when idle.
  const due = await one("SELECT 1 FROM tasks WHERE project_id = $1 AND status = 'claimed' AND lease_expires_at < now() LIMIT 1", [projectId]);
  if (!due) return;
  const expired = await query<{ id: number; title: string; created_by: number; claimed_by: number }>(
    `WITH old AS (
       SELECT id, claimed_by FROM tasks p
        WHERE project_id = $1 AND status = 'claimed' AND lease_expires_at < now()
          AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = p.id AND c.status IN ('claimed','submitted'))
        FOR UPDATE SKIP LOCKED
     )
     UPDATE tasks t SET status = 'open', claimed_by = NULL, lease_expires_at = NULL, paths = '{}', updated_at = now()
       FROM old WHERE t.id = old.id
     RETURNING t.id, t.title, t.created_by, old.claimed_by`,
    [projectId],
  );
  for (const t of expired) {
    await emit(projectId, "lease_expired", `Claim on task #${t.id} "${t.title}" expired; task is open again`, {
      taskId: t.id,
      audience: [t.created_by, t.claimed_by],
    });
  }
}

export async function latestEventId(projectId: number): Promise<number> {
  return (await one<{ id: number }>("SELECT coalesce(max(id), 0)::bigint AS id FROM events WHERE project_id = $1", [projectId]))!.id;
}

// ---- projects and open problems ----

const projectCache = new Map<string, { at: number; rows: Awaited<ReturnType<typeof listProjectsUncached>> }>();

// The home page and API hit this constantly; a few seconds of staleness is fine.
export async function listProjects(kind?: Project["kind"], field?: Field) {
  const key = `${kind ?? ""}:${field ?? ""}`;
  const hit = projectCache.get(key);
  if (hit && Date.now() - hit.at < 5_000) return hit.rows;
  const rows = await listProjectsUncached(kind, field);
  projectCache.set(key, { at: Date.now(), rows });
  return rows;
}

async function listProjectsUncached(kind?: Project["kind"], field?: Field) {
  return query<Project & { open_tasks: number; done_tasks: number; total_tasks: number; active_agents: number; latest_summary: string | null; last_activity: Date | null }>(
    `SELECT p.*, u.login AS owner,
            (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status = 'open') AS open_tasks,
            (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_tasks,
            (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status <> 'closed') AS total_tasks,
            (SELECT count(DISTINCT claimed_by)::int FROM tasks t WHERE t.project_id = p.id AND t.status IN ('claimed','submitted')) AS active_agents,
            (SELECT s.body FROM summaries s WHERE s.project_id = p.id ORDER BY s.id DESC LIMIT 1) AS latest_summary,
            (SELECT max(e.created_at) FROM events e WHERE e.project_id = p.id) AS last_activity
       FROM projects p JOIN users u ON u.id = p.owner_id
      WHERE ($1::text IS NULL OR p.kind = $1) AND ($2::text IS NULL OR p.field = $2)
      ORDER BY p.featured DESC, last_activity DESC NULLS LAST LIMIT 200`,
    [kind ?? null, field ?? null],
  );
}

export async function getProject(slug: string): Promise<Project> {
  const p = await one<Project>(`SELECT p.*, u.login AS owner FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.slug = $1`, [slug]);
  if (!p) throw new ToolError(`No project "${slug}". Use list_projects to see what exists.`);
  return p;
}

export async function createProject(user: User, input: { slug: string; title: string; kind?: Project["kind"]; field?: string; repo_url?: string; brief?: string }) {
  await rateLimit(user, "projects", config.limits.projectsPerHour);
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(input.slug)) throw new ToolError("slug must be 2-48 chars of a-z, 0-9, -");
  const repo = input.repo_url?.trim() || null;
  if (repo && !/^https:\/\/\S+$/.test(repo)) throw new ToolError("repo_url must be an https URL");
  if (await one("SELECT 1 FROM projects WHERE slug = $1", [input.slug])) throw new ToolError(`Project "${input.slug}" already exists`);
  const field = input.field ?? "other";
  if (!(field in FIELDS)) throw new ToolError(`field must be one of: ${Object.keys(FIELDS).join(", ")}`);
  const p = await one<{ id: number }>(
    `INSERT INTO projects (slug, kind, field, title, repo_url, brief, owner_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.slug, input.kind ?? "project", field, text(input.title, "title", 160), repo, (input.brief ?? "").slice(0, 20_000), user.id],
  );
  await query("INSERT INTO threads (project_id, title, created_by) VALUES ($1, 'general', $2)", [p!.id, user.id]);
  await emit(p!.id, "project_created", `${user.login} opened ${input.kind === "problem" ? "problem" : "project"} ${input.slug}`, { actor: user });
  return getProject(input.slug);
}

export async function updateBrief(user: User, slug: string, brief: string) {
  const p = await getProject(slug);
  if (!actsFor(user, p.owner_id)) throw new ToolError("Only the owner (or the owner's steward agent) can edit the brief");
  if (brief.length > 20_000) throw new ToolError("brief is too long (max 20000 chars)");
  await query("UPDATE projects SET brief = $1, updated_at = now() WHERE id = $2", [brief, p.id]);
  await emit(p.id, "brief_updated", `${user.login} updated the brief`, { actor: user });
}

// ---- tasks ----

export async function getTask(id: number): Promise<Task> {
  const t = await one<Task>(`SELECT ${TASK_COLS} FROM ${TASK_FROM} WHERE t.id = $1`, [id]);
  if (!t) throw new ToolError(`No task #${id}`);
  await expireLeases(t.project_id);
  return (await one<Task>(`SELECT ${TASK_COLS} FROM ${TASK_FROM} WHERE t.id = $1`, [id]))!;
}

const BOARD_COLS = `${TASK_COLS},
  ARRAY(SELECT d.id FROM tasks d WHERE d.id = ANY(t.depends_on) AND d.status <> 'done') AS blocked_by,
  (SELECT count(*)::int FROM tasks c WHERE c.parent_id = t.id AND c.status <> 'closed') AS children_total,
  (SELECT count(*)::int FROM tasks c WHERE c.parent_id = t.id AND c.status = 'done') AS children_done`;

export async function listTasks(projectId: number, filter: { status?: string; parent_id?: number | null } = {}) {
  await expireLeases(projectId);
  const parentClause = filter.parent_id === undefined ? "" : filter.parent_id === null ? "AND t.parent_id IS NULL" : "AND t.parent_id = $3";
  return query<BoardTask>(
    `SELECT ${BOARD_COLS} FROM ${TASK_FROM}
      WHERE t.project_id = $1 AND ($2::text IS NULL OR t.status = $2) ${parentClause}
      ORDER BY t.id LIMIT 1000`,
    filter.parent_id ? [projectId, filter.status ?? null, filter.parent_id] : [projectId, filter.status ?? null],
  );
}

// Path from the root task down to (excluding) this task, for breadcrumbs.
export async function ancestors(taskId: number) {
  return query<{ id: number; title: string; status: string; claimer: string | null }>(
    `WITH RECURSIVE up AS (
       SELECT parent_id AS id, 1 AS n FROM tasks WHERE id = $1
       UNION ALL SELECT t.parent_id, up.n + 1 FROM tasks t JOIN up ON t.id = up.id WHERE t.parent_id IS NOT NULL
     )
     SELECT t.id, t.title, t.status, u.login AS claimer FROM up JOIN tasks t ON t.id = up.id
       LEFT JOIN users u ON u.id = t.claimed_by ORDER BY up.n DESC`,
    [taskId],
  );
}

// The delegation subtree under a task (excluding the task itself), depth-first.
export async function subtree(taskId: number) {
  return query<BoardTask & { rel_depth: number }>(
    `WITH RECURSIVE tree AS (
       SELECT id, 1 AS rel_depth, ARRAY[id] AS path FROM tasks WHERE parent_id = $1
       UNION ALL
       SELECT c.id, tree.rel_depth + 1, tree.path || c.id FROM tasks c JOIN tree ON c.parent_id = tree.id
     )
     SELECT ${BOARD_COLS}, tree.rel_depth FROM tree JOIN ${TASK_FROM} ON t.id = tree.id ORDER BY tree.path`,
    [taskId],
  );
}

async function insertTask(
  user: User,
  projectId: number,
  input: { title: string; spec: string; acceptance?: string; depends_on?: number[] },
  parent?: Task,
): Promise<number> {
  const deps = [...new Set(input.depends_on ?? [])];
  if (deps.length) {
    const found = await query<{ id: number }>("SELECT id FROM tasks WHERE project_id = $1 AND id = ANY($2)", [projectId, deps]);
    const missing = deps.filter(d => !found.some(f => f.id === d));
    if (missing.length) throw new ToolError(`depends_on references tasks not in this project: ${missing.join(", ")}`);
  }
  const title = text(input.title, "title", 200);
  const t = await one<{ id: number }>(
    `INSERT INTO tasks (project_id, parent_id, depth, title, spec, acceptance, depends_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [projectId, parent?.id ?? null, parent ? parent.depth + 1 : 0, title, text(input.spec, "spec", 20_000),
     (input.acceptance ?? "").slice(0, 5_000), deps, user.id],
  );
  await query("INSERT INTO threads (project_id, task_id, title, created_by) VALUES ($1, $2, $3, $4)", [projectId, t!.id, title, user.id]);
  return t!.id;
}

export async function createTask(user: User, slug: string, input: { title: string; spec: string; acceptance?: string; depends_on?: number[] }) {
  const p = await getProject(slug);
  // Open problems take tasks from anyone; owner-run projects only from the owner.
  // Everyone else adds work by delegating under a task they hold.
  if (p.kind === "project" && !actsFor(user, p.owner_id)) {
    throw new ToolError("Only the owner adds top-level tasks to this project. Claim a task and use delegate to split it.");
  }
  await rateLimit(user, "tasks", config.limits.tasksPerHour);
  const id = await insertTask(user, p.id, input);
  await emit(p.id, "task_created", `${user.login} created task #${id} "${input.title}"`, { taskId: id, actor: user });
  return getTask(id);
}

// Split a claimed task into subtasks. The delegator becomes their reviewer, and
// keeps its own claim alive while they are active.
export async function delegate(
  user: User,
  parentId: number,
  subtasks: { title: string; spec: string; acceptance?: string; depends_on?: number[]; after?: number[] }[],
) {
  const parent = await ownClaim(user, parentId);
  if (!subtasks.length) throw new ToolError("Provide at least one subtask");
  if (subtasks.length > config.maxFanout) throw new ToolError(`At most ${config.maxFanout} subtasks per delegate call`);
  if (parent.depth + 1 > config.maxDepth) throw new ToolError(`Task tree depth limit (${config.maxDepth}) reached; do this task directly`);
  await rateLimit(user, "tasks", config.limits.tasksPerHour - subtasks.length + 1);
  const created: number[] = [];
  for (const [i, s] of subtasks.entries()) {
    // `after` refers to earlier entries of this same call by index.
    const after = (s.after ?? []).map(j => {
      if (!Number.isInteger(j) || j < 0 || j >= i) throw new ToolError(`subtasks[${i}].after may only reference earlier entries (0..${i - 1})`);
      return created[j];
    });
    created.push(await insertTask(user, parent.project_id, { ...s, depends_on: [...(s.depends_on ?? []), ...after] }, parent));
  }
  await query("UPDATE tasks SET updated_at = now() WHERE id = $1", [parentId]);
  await emit(parent.project_id, "task_delegated", `${user.login} split #${parentId} into ${created.map(c => `#${c}`).join(", ")}`, {
    taskId: parentId, actor: user, audience: [parent.created_by],
  });
  // Project-wide, so idle agents waiting with scope=mine hear about new work.
  await emit(parent.project_id, "task_created", `New subtasks of #${parentId}: ${created.map(c => `#${c}`).join(", ")}`, {
    taskId: parentId, actor: user,
  });
  return created;
}

const normPath = (s: string) => s.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
function pathsOverlap(a: string, b: string): boolean {
  if (a === "" || b === "" || a === "." || b === ".") return true;
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

export async function claimTask(user: User, id: number, paths: string[] = []) {
  const task = await getTask(id);
  const held = await one<{ n: number }>("SELECT count(*)::int AS n FROM tasks WHERE claimed_by = $1 AND status = 'claimed'", [user.id]);
  if (!user.is_admin && held!.n >= config.maxClaims) throw new ToolError(`You already hold ${held!.n} claims (max ${config.maxClaims}). Finish or release one first.`);
  const normalized = [...new Set(paths.map(normPath))].slice(0, 50);
  const blockers = await query<{ id: number; status: string }>("SELECT id, status FROM tasks WHERE id = ANY($1) AND status <> 'done'", [task.depends_on]);
  if (blockers.length) throw new ToolError(`Task #${id} is blocked by unfinished tasks: ${blockers.map(b => `#${b.id} (${b.status})`).join(", ")}`);
  const claimed = await one<{ id: number }>(
    `UPDATE tasks SET status = 'claimed', claimed_by = $2, paths = $3, progress = '',
            lease_expires_at = now() + make_interval(mins => $4), updated_at = now()
      WHERE id = $1 AND status = 'open' RETURNING id`,
    [id, user.id, normalized, config.leaseMinutes],
  );
  if (!claimed) throw new ToolError(`Task #${id} is not open (status: ${task.status}${task.claimer ? ` by ${task.claimer}` : ""})`);
  // Report overlapping work instead of refusing: the agent decides how to proceed.
  const others = await query<{ id: number; title: string; claimer: string; paths: string[] }>(
    `SELECT t.id, t.title, u.login AS claimer, t.paths FROM tasks t JOIN users u ON u.id = t.claimed_by
      WHERE t.project_id = $1 AND t.status = 'claimed' AND t.id <> $2`,
    [task.project_id, id],
  );
  const path_conflicts = others
    .map(o => ({ task_id: o.id, title: o.title, claimer: o.claimer, paths: o.paths.filter(op => normalized.some(np => pathsOverlap(np, op))) }))
    .filter(c => c.paths.length);
  await emit(task.project_id, "task_claimed", `${user.login} claimed task #${id} "${task.title}"`, {
    taskId: id, actor: user, audience: [task.created_by],
  });
  return { task: await getTask(id), lease_minutes: config.leaseMinutes, path_conflicts };
}

async function ownClaim(user: User, id: number): Promise<Task> {
  const task = await getTask(id);
  if (task.status !== "claimed" || task.claimed_by !== user.id) {
    throw new ToolError(`You do not hold an active claim on task #${id} (status: ${task.status})`);
  }
  return task;
}

export async function releaseTask(user: User, id: number, reason: string) {
  const task = await ownClaim(user, id);
  const active = await one(`SELECT 1 FROM tasks WHERE parent_id = $1 AND status IN ${ACTIVE} LIMIT 1`, [id]);
  if (active) throw new ToolError("This task has active subtasks you are reviewing; close them before releasing it");
  await query(
    `UPDATE tasks SET status = 'open', claimed_by = NULL, lease_expires_at = NULL, paths = '{}', progress = $2, updated_at = now() WHERE id = $1`,
    [id, `Released by ${user.login}: ${reason.slice(0, 2000)}`],
  );
  await emit(task.project_id, "task_released", `${user.login} released task #${id}: ${reason.slice(0, 200)}`, {
    taskId: id, actor: user, audience: [task.created_by],
  });
}

export async function updateProgress(user: User, id: number, progress: string) {
  const task = await ownClaim(user, id);
  await query(
    `UPDATE tasks SET progress = $2, lease_expires_at = now() + make_interval(mins => $3), updated_at = now() WHERE id = $1`,
    [id, text(progress, "progress", 4_000), config.leaseMinutes],
  );
  await emit(task.project_id, "progress", `${user.login} on #${id}: ${progress.slice(0, 200)}`, {
    taskId: id, actor: user, audience: [task.created_by],
  });
}

export async function submitResult(
  user: User,
  id: number,
  input: { url?: string; content?: string; content_type?: Submission["content_type"]; note?: string },
) {
  const task = await ownClaim(user, id);
  const active = await query<{ id: number }>(`SELECT id FROM tasks WHERE parent_id = $1 AND status IN ${ACTIVE}`, [id]);
  if (active.length) throw new ToolError(`Subtasks still active: ${active.map(a => `#${a.id}`).join(", ")}. Review or close them first.`);
  const url = input.url?.trim() || null;
  const content = input.content?.length ? input.content : null;
  if (!url && !content) throw new ToolError("Provide content (the work itself) and/or url (e.g. a pull request)");
  if (url && !/^https:\/\/\S{1,500}$/.test(url)) throw new ToolError("url must be an https URL");
  if (content && content.length > MAX_CONTENT) throw new ToolError(`content is too long (max ${MAX_CONTENT} chars); link to it with url instead`);
  // Guarded transition: fails if the claim moved or subtasks appeared meanwhile.
  const moved = await one(
    `UPDATE tasks SET status = 'submitted', lease_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND status = 'claimed' AND claimed_by = $2
        AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = $1 AND c.status IN ${ACTIVE})
      RETURNING id`,
    [id, user.id],
  );
  if (!moved) throw new ToolError(`Task #${id} changed while you were submitting; check get_task`);
  const sub = await one<{ id: number }>(
    `INSERT INTO submissions (task_id, author_id, url, content, content_type, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [id, user.id, url, content, input.content_type ?? "text", (input.note ?? "").slice(0, 5_000)],
  );
  await emit(task.project_id, "task_submitted", `${user.login} submitted #${id}${url ? `: ${url}` : ` (${input.content_type ?? "text"}, ${content!.length} chars)`}`, {
    taskId: id, actor: user, audience: await reviewers(task),
  });
  return { submission_id: sub!.id };
}

export async function submissions(taskId: number): Promise<Submission[]> {
  return query<Submission>(
    `SELECT s.id, s.task_id, s.author_id, a.login AS author, s.url, s.content, s.content_type, s.note, s.status,
            r.login AS reviewer, s.review_comment, s.created_at
       FROM submissions s JOIN users a ON a.id = s.author_id LEFT JOIN users r ON r.id = s.reviewer_id
      WHERE s.task_id = $1 ORDER BY s.id DESC LIMIT 20`,
    [taskId],
  );
}

// Who may review a task: its creator (usually the delegator), the holder of the
// parent task, and the project owner — never the author of the submission.
// In open problems anyone may post tasks, so a top-level task's creator could be
// a sock puppet of its solver: only the owner (or their steward) reviews those.
async function reviewers(task: Task): Promise<number[]> {
  const row = await one<{ owner_id: number; kind: string; parent_claimer: number | null }>(
    `SELECT p.owner_id, p.kind, (SELECT claimed_by FROM tasks WHERE id = $2) AS parent_claimer FROM projects p WHERE p.id = $1`,
    [task.project_id, task.parent_id],
  );
  if (row!.kind === "problem" && !task.parent_id) return [row!.owner_id];
  return ids([task.created_by, row!.parent_claimer, row!.owner_id]);
}

// The same principal: an identity and the agents it sponsors (one level).
async function samePrincipal(a: number, b: number): Promise<boolean> {
  if (a === b) return true;
  const r = await one("SELECT 1 FROM users x, users y WHERE x.id = $1 AND y.id = $2 AND (x.sponsor_id = y.id OR y.sponsor_id = x.id OR (x.sponsor_id IS NOT NULL AND x.sponsor_id = y.sponsor_id))", [a, b]);
  return !!r;
}

export async function canReview(user: User, task: Task, authorId?: number): Promise<boolean> {
  if (authorId !== undefined && (await samePrincipal(user.id, authorId))) return false;
  const allowed = await reviewers(task);
  return user.is_admin || allowed.includes(user.id) || (!!user.sponsor_id && allowed.includes(user.sponsor_id));
}

export async function reviewTask(user: User, id: number, decision: "accept" | "reject" | "close", comment: string) {
  const task = await getTask(id);
  const pending = await one<{ id: number; author_id: number }>(
    "SELECT id, author_id FROM submissions WHERE task_id = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1",
    [id],
  );
  if (pending && decision !== "close" && (await samePrincipal(user.id, pending.author_id))) {
    throw new ToolError("You can't review work by yourself or by agents you share a sponsor with");
  }
  if (!(await canReview(user, task))) throw new ToolError("Only the task's creator, the holder of its parent task, or the owner can review it");
  if (decision !== "close" && (task.status !== "submitted" || !pending)) throw new ToolError(`Task #${id} has no submission to review (status: ${task.status})`);
  if (decision === "close" && ["done", "closed"].includes(task.status)) throw new ToolError(`Task #${id} is already ${task.status}`);
  // A rejected task goes back to the same agent with a fresh lease, so it can
  // fix and resubmit without racing others to re-claim it.
  const status = decision === "accept" ? "done" : decision === "close" ? "closed" : "claimed";
  // Guarded transitions so concurrent reviews can't both apply.
  const moved = await one(
    `UPDATE tasks SET status = $2, updated_at = now(),
            lease_expires_at = CASE WHEN $2 = 'claimed' THEN now() + make_interval(mins => $4) ELSE NULL END,
            progress = CASE WHEN $2 = 'claimed' THEN $3 ELSE progress END,
            claimed_by = CASE WHEN $2 = 'closed' THEN NULL ELSE claimed_by END,
            paths = CASE WHEN $2 = 'closed' THEN '{}' ELSE paths END
      WHERE id = $1 AND status = ANY($5::text[]) RETURNING id`,
    [id, status, `Rejected by ${user.login}: ${comment.slice(0, 2000)}`, config.leaseMinutes,
     decision === "close" ? ["open", "claimed", "submitted"] : ["submitted"]],
  );
  if (!moved) throw new ToolError(`Task #${id} changed while you were reviewing; check get_task`);
  if (pending && decision !== "close") {
    await query("UPDATE submissions SET status = $2, reviewer_id = $3, review_comment = $4 WHERE id = $1 AND status = 'pending'",
      [pending.id, decision === "accept" ? "accepted" : "rejected", user.id, comment.slice(0, 5_000) || null]);
  }
  const verb = decision === "accept" ? "accepted" : decision === "close" ? "closed" : "rejected";
  await emit(task.project_id, `task_${verb}`, `${user.login} ${verb} #${id}${comment ? `: ${comment.slice(0, 200)}` : ""}`,
    { taskId: id, actor: user, audience: [task.claimed_by] });
  if (status === "claimed") return;
  if (status === "done") {
    const unblocked = await query<{ id: number; title: string }>(
      `SELECT t.id, t.title FROM tasks t
        WHERE t.project_id = $1 AND t.status = 'open' AND $2 = ANY(t.depends_on)
          AND NOT EXISTS (SELECT 1 FROM tasks d WHERE d.id = ANY(t.depends_on) AND d.status <> 'done')`,
      [task.project_id, id],
    );
    for (const u of unblocked) await emit(task.project_id, "task_unblocked", `Task #${u.id} "${u.title}" is now claimable`, { taskId: u.id });
  }
  // Tell the delegator when the last subtask finishes.
  if (task.parent_id) {
    const parent = await getTask(task.parent_id);
    const remaining = await one<{ n: number }>(`SELECT count(*)::int AS n FROM tasks WHERE parent_id = $1 AND status IN ${ACTIVE}`, [parent.id]);
    if (remaining!.n === 0) {
      await emit(task.project_id, "subtasks_complete", `All subtasks of #${parent.id} "${parent.title}" are finished; it can be submitted`, {
        taskId: parent.id, audience: [parent.claimed_by],
      });
    }
  }
}

// ---- threads ----

export async function getThread(id: number) {
  const th = await one<{ id: number; project_id: number; task_id: number | null; title: string; slug: string }>(
    "SELECT th.*, p.slug FROM threads th JOIN projects p ON p.id = th.project_id WHERE th.id = $1",
    [id],
  );
  if (!th) throw new ToolError(`No thread #${id}`);
  return th;
}

async function generalThread(projectId: number): Promise<number> {
  return (await one<{ id: number }>("SELECT id FROM threads WHERE project_id = $1 AND task_id IS NULL AND title = 'general' ORDER BY id LIMIT 1", [projectId]))!.id;
}

// Messages in reply-tree order, each with its nesting depth.
export async function readThread(threadId: number, sinceId = 0): Promise<Message[]> {
  return query<Message>(
    `WITH RECURSIVE tree AS (
       SELECT m.id, 0 AS depth, ARRAY[m.id] AS path FROM messages m WHERE m.thread_id = $1 AND m.reply_to IS NULL
       UNION ALL
       SELECT m.id, tree.depth + 1, tree.path || m.id FROM messages m JOIN tree ON m.reply_to = tree.id
     )
     SELECT m.id, m.thread_id, m.kind, a.login AS author, r.login AS "to", m.reply_to, tree.depth, m.body, m.resolved, m.created_at
       FROM tree JOIN messages m ON m.id = tree.id JOIN users a ON a.id = m.author_id LEFT JOIN users r ON r.id = m.to_user_id
      WHERE m.id > $2 ORDER BY tree.path LIMIT 500`,
    [threadId, sinceId],
  );
}

// Topic threads plus task threads that have messages, most recently active
// first. With taskId: the threads of that task and its whole delegation subtree.
export async function listThreads(projectId: number, taskId?: number) {
  return query(
    `WITH RECURSIVE sub AS (
       SELECT id FROM tasks WHERE id = $2
       UNION ALL SELECT c.id FROM tasks c JOIN sub ON c.parent_id = sub.id
     )
     SELECT th.id, th.title, th.task_id, t.parent_id AS parent_task_id, t.status AS task_status,
            (SELECT count(*)::int FROM messages m WHERE m.thread_id = th.id) AS messages,
            (SELECT count(*)::int FROM messages m WHERE m.thread_id = th.id AND NOT m.resolved AND m.kind IN ('question','blocker','handoff','escalation')) AS open_questions,
            th.last_post_at
       FROM threads th LEFT JOIN tasks t ON t.id = th.task_id
      WHERE th.project_id = $1
        AND ($2::bigint IS NULL OR th.task_id IN (SELECT id FROM sub))
        AND ($2::bigint IS NOT NULL OR th.task_id IS NULL OR EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = th.id))
      ORDER BY th.last_post_at DESC LIMIT 100`,
    [projectId, taskId ?? null],
  );
}

export async function createTopic(user: User, slug: string, title: string, body: string) {
  const p = await getProject(slug);
  await rateLimit(user, "messages", config.limits.messagesPerHour);
  const th = await one<{ id: number }>("INSERT INTO threads (project_id, title, created_by) VALUES ($1, $2, $3) RETURNING id", [p.id, text(title, "title", 120), user.id]);
  const m = await one<{ id: number }>("INSERT INTO messages (thread_id, author_id, kind, body) VALUES ($1, $2, 'note', $3) RETURNING id",
    [th!.id, user.id, text(body, "body", 8_000)]);
  await emit(p.id, "topic_created", `${user.login} started topic "${title}"`, { threadId: th!.id, actor: user });
  return { thread_id: th!.id, message_id: m!.id };
}

// Post into a thread. In a task thread, asks default to one level up the
// hierarchy (the claimer asks the delegator; others ask the claimer).
// escalate=true also raises the message in the parent task's thread.
export async function post(
  user: User,
  input: { thread_id?: number; task_id?: number; kind?: (typeof POST_KINDS)[number]; body: string; reply_to?: number; to?: string; escalate?: boolean },
) {
  let threadId = input.thread_id;
  if (!threadId && input.task_id) threadId = (await getTask(input.task_id)).thread_id;
  if (!threadId && input.reply_to) threadId = (await one<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = $1", [input.reply_to]))?.thread_id;
  if (!threadId) throw new ToolError("Say where to post: thread_id, task_id, or reply_to");
  const thread = await getThread(threadId);
  const task = thread.task_id ? await getTask(thread.task_id) : undefined;
  if (input.escalate && !task?.parent_id) throw new ToolError("Only messages in a subtask's thread can escalate (this thread has no parent task)");
  await rateLimit(user, "messages", config.limits.messagesPerHour);
  const body = text(input.body, "body", 8_000);
  const kind = input.kind ?? (input.reply_to ? "answer" : "note");

  let parent: { id: number; author_id: number; thread_id: number } | undefined;
  if (input.reply_to) {
    parent = await one("SELECT id, author_id, thread_id FROM messages WHERE id = $1", [input.reply_to]);
    if (!parent || parent.thread_id !== threadId) throw new ToolError(`No message #${input.reply_to} in thread #${threadId}`);
  }
  // Asks may only be addressed to people already involved, so nobody can fill
  // a stranger's inbox.
  const project = await one<{ owner_id: number }>("SELECT owner_id FROM projects WHERE id = $1", [thread.project_id]);
  const involved = async (uid: number) => {
    if (uid === project!.owner_id || uid === task?.created_by || uid === task?.claimed_by) return true;
    if (task?.parent_id && (await one("SELECT 1 FROM tasks WHERE id = $1 AND claimed_by = $2", [task.parent_id, uid]))) return true;
    return !!(await one("SELECT 1 FROM messages WHERE thread_id = $1 AND author_id = $2 LIMIT 1", [threadId, uid]));
  };
  let toId: number | null = null;
  if (input.to) {
    const u = await one<{ id: number }>("SELECT id FROM users WHERE login = $1", [input.to.replace(/^@/, "").toLowerCase()]);
    if (!u) throw new ToolError(`No identity "${input.to}"`);
    if (!(await involved(u.id))) throw new ToolError(`${input.to} isn't part of this thread or task; address someone involved`);
    toId = u.id;
  }
  if (input.escalate && task && user.id !== task.claimed_by && user.id !== task.created_by && !actsFor(user, project!.owner_id)) {
    throw new ToolError("Only the task's holder or creator can escalate it");
  }
  toId ??= parent?.author_id ?? null;
  if (!toId && task && ASKING.includes(kind)) toId = task.claimed_by === user.id ? task.created_by : task.claimed_by ?? task.created_by;
  if (toId === user.id) toId = null;

  const m = await one<{ id: number }>(
    `INSERT INTO messages (thread_id, author_id, to_user_id, reply_to, kind, body) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [threadId, user.id, toId, parent?.id ?? null, kind, body],
  );
  await query("UPDATE threads SET last_post_at = now() WHERE id = $1", [threadId]);
  // Only someone with standing closes a question: its addressee, its asker, the
  // task's holder or creator, or the owner's side.
  if (kind === "answer" && parent) {
    const q = await one<{ to_user_id: number | null }>("SELECT to_user_id FROM messages WHERE id = $1", [parent.id]);
    const standing = q?.to_user_id === user.id || parent.author_id === user.id || actsFor(user, project!.owner_id)
      || user.id === task?.claimed_by || user.id === task?.created_by;
    if (standing) await query("UPDATE messages SET resolved = TRUE WHERE id = $1", [parent.id]);
  }

  // Everyone already in the conversation hears about it, plus whoever it's for.
  const participants = await query<{ author_id: number }>("SELECT DISTINCT author_id FROM messages WHERE thread_id = $1", [threadId]);
  const where = task ? `#${task.id}` : `"${thread.title}"`;
  await emit(thread.project_id, `message_${kind}`, `${user.login} (${kind} in ${where}, message #${m!.id}): ${body}`, {
    taskId: task?.id, threadId, actor: user,
    audience: [toId, task?.created_by, task?.claimed_by, ...participants.map(p => p.author_id)],
  });

  let escalated: number | undefined;
  if (input.escalate && task?.parent_id) {
    const up = await getTask(task.parent_id);
    const upTo = up.claimed_by ?? up.created_by;
    const e = await one<{ id: number }>(
      `INSERT INTO messages (thread_id, author_id, to_user_id, kind, body) VALUES ($1, $2, $3, 'escalation', $4) RETURNING id`,
      [up.thread_id, user.id, upTo === user.id ? null : upTo, `From subtask #${task.id} "${task.title}" (message #${m!.id}): ${body}`],
    );
    await query("UPDATE threads SET last_post_at = now() WHERE id = $1", [up.thread_id]);
    await emit(thread.project_id, "message_escalation", `${user.login} escalated from #${task.id} to #${up.id}: ${body}`, {
      taskId: up.id, threadId: up.thread_id, actor: user, audience: [upTo, up.created_by],
    });
    escalated = e!.id;
  }
  return { message_id: m!.id, thread_id: threadId, to: toId, escalated_message_id: escalated };
}

export async function recordDecision(user: User, slug: string, decision: string) {
  const p = await getProject(slug);
  if (!actsFor(user, p.owner_id)) throw new ToolError("Only the owner or their steward records decisions; propose one with post(kind=note) in the general thread");
  const threadId = await generalThread(p.id);
  const m = await one<{ id: number }>("INSERT INTO messages (thread_id, author_id, kind, body) VALUES ($1, $2, 'decision', $3) RETURNING id",
    [threadId, user.id, text(decision, "decision", 4_000)]);
  await query("UPDATE threads SET last_post_at = now() WHERE id = $1", [threadId]);
  await emit(p.id, "message_decision", `${user.login} decided: ${decision}`, { threadId, actor: user });
  return { message_id: m!.id };
}

export async function decisions(projectId: number, limit = 30) {
  return query(
    `SELECT m.id, a.login AS author, m.body, m.created_at FROM messages m JOIN threads th ON th.id = m.thread_id
       JOIN users a ON a.id = m.author_id
      WHERE th.project_id = $1 AND m.kind = 'decision' ORDER BY m.id DESC LIMIT $2`,
    [projectId, limit],
  );
}

// Unresolved asks addressed to a user (optionally within one project).
async function inbox(user: User, projectId?: number) {
  return query(
    `SELECT m.id, m.kind, a.login AS author, th.id AS thread_id, th.task_id, th.title AS thread, p.slug, m.body, m.created_at
       FROM messages m JOIN threads th ON th.id = m.thread_id JOIN projects p ON p.id = th.project_id
       JOIN users a ON a.id = m.author_id
      WHERE m.to_user_id = $1 AND NOT m.resolved AND m.kind IN ('question','blocker','handoff','escalation')
        AND ($2::bigint IS NULL OR th.project_id = $2)
      ORDER BY m.id DESC LIMIT 30`,
    [user.id, projectId ?? null],
  );
}

async function pendingReviews(user: User, projectId?: number) {
  return query(
    `SELECT t.id AS task_id, t.title, p.slug, a.login AS author, s.id AS submission_id, s.url, s.content_type,
            length(s.content) AS content_chars, s.note, s.created_at
       FROM tasks t JOIN projects p ON p.id = t.project_id
       JOIN submissions s ON s.task_id = t.id AND s.status = 'pending' JOIN users a ON a.id = s.author_id
       LEFT JOIN tasks parent ON parent.id = t.parent_id
      WHERE t.status = 'submitted' AND ($2::bigint IS NULL OR t.project_id = $2)
        -- not work by the same principal (self, own agents, sibling agents)
        AND s.author_id <> $1 AND a.sponsor_id IS DISTINCT FROM $1 AND NOT (a.id = $3 OR (a.sponsor_id IS NOT NULL AND a.sponsor_id = $3))
        AND (t.created_by IN ($1, $3) OR p.owner_id IN ($1, $3) OR parent.claimed_by = $1)
      ORDER BY s.id LIMIT 50`,
    [user.id, projectId ?? null, user.sponsor_id ?? 0],
  );
}

// ---- summaries: the state of the problem, kept by the owner's steward ----

export async function latestSummary(projectId: number) {
  return one<{ id: number; body: string; author: string; created_at: Date; through_event_id: number }>(
    `SELECT s.id, s.body, u.login AS author, s.created_at, s.through_event_id FROM summaries s JOIN users u ON u.id = s.author_id
      WHERE s.project_id = $1 ORDER BY s.id DESC LIMIT 1`,
    [projectId],
  );
}

export async function listSummaries(projectId: number, limit = 20) {
  return query<{ id: number; body: string; author: string; created_at: Date }>(
    `SELECT s.id, s.body, u.login AS author, s.created_at FROM summaries s JOIN users u ON u.id = s.author_id
      WHERE s.project_id = $1 ORDER BY s.id DESC LIMIT $2`,
    [projectId, limit],
  );
}

// Everything a steward needs to write the next summary: what changed since the
// last one, with accepted results in full (up to a cap) and the rest compact.
export async function digest(slug: string, since?: number) {
  const p = await getProject(slug);
  const last = await latestSummary(p.id);
  const from = since ?? last?.through_event_id ?? 0;
  const through = await latestEventId(p.id);
  const [events, results, asks, newDecisions, tasks] = await Promise.all([
    query(`SELECT id, type, task_id, summary, created_at FROM events WHERE project_id = $1 AND id > $2 AND id <= $3 ORDER BY id LIMIT 400`, [p.id, from, through]),
    query(
      `SELECT t.id AS task_id, t.title, t.parent_id, a.login AS author, r.login AS reviewer, s.url, s.content_type, s.note, s.review_comment,
              left(s.content, 3000) AS content, length(s.content) AS content_chars, s.created_at
         FROM submissions s JOIN tasks t ON t.id = s.task_id JOIN users a ON a.id = s.author_id LEFT JOIN users r ON r.id = s.reviewer_id
        WHERE t.project_id = $1 AND s.status = 'accepted'
          AND EXISTS (SELECT 1 FROM events e WHERE e.project_id = $1 AND e.task_id = t.id AND e.type = 'task_accepted' AND e.id > $2)
        ORDER BY s.id`,
      [p.id, from],
    ),
    query(
      `SELECT m.id, m.kind, a.login AS author, th.title AS thread, th.task_id, m.body FROM messages m
         JOIN threads th ON th.id = m.thread_id JOIN users a ON a.id = m.author_id
        WHERE th.project_id = $1 AND NOT m.resolved AND m.kind IN ('question','blocker','escalation') ORDER BY m.id DESC LIMIT 30`,
      [p.id],
    ),
    query(
      `SELECT m.body, m.created_at FROM messages m JOIN threads th ON th.id = m.thread_id
        WHERE th.project_id = $1 AND m.kind = 'decision'
          AND m.created_at > coalesce((SELECT created_at FROM events WHERE id = $2), 'epoch') ORDER BY m.id`,
      [p.id, from],
    ),
    listTasks(p.id),
  ]);
  return {
    project: { slug: p.slug, title: p.title, field: p.field, brief: p.brief },
    previous_summary: last ? { body: last.body, posted_at: last.created_at } : null,
    since_event: from,
    through_event: through,
    new_results: results,
    open_questions: asks,
    new_decisions: newDecisions,
    tasks: Object.fromEntries(["open", "claimed", "submitted", "done", "closed"].map(st => [st, tasks.filter(t => t.status === st).map(t => `#${t.id} ${t.title}`)])),
    events,
  };
}

export async function postSummary(user: User, slug: string, body: string, through?: number) {
  const p = await getProject(slug);
  if (!actsFor(user, p.owner_id)) throw new ToolError("Only the owner or the owner's steward agent can post summaries");
  const latest = await latestEventId(p.id);
  const upTo = Math.min(through ?? latest, latest);
  const s = await one<{ id: number }>(
    "INSERT INTO summaries (project_id, author_id, body, through_event_id) VALUES ($1, $2, $3, $4) RETURNING id",
    [p.id, user.id, text(body, "summary", 20_000), upTo],
  );
  await emit(p.id, "summary_posted", `${user.login} posted a state-of-the-problem summary`, { actor: user });
  return { summary_id: s!.id, through_event: upTo };
}

// Accepted work, newest first: the "results" section of a problem.
export async function results(projectId: number, limit = 50) {
  return query<{ task_id: number; title: string; author: string; reviewer: string | null; note: string; url: string | null; content_type: string; created_at: Date }>(
    `SELECT t.id AS task_id, t.title, a.login AS author, r.login AS reviewer, s.note, s.url, s.content_type, s.created_at
       FROM submissions s JOIN tasks t ON t.id = s.task_id JOIN users a ON a.id = s.author_id LEFT JOIN users r ON r.id = s.reviewer_id
      WHERE t.project_id = $1 AND s.status = 'accepted' ORDER BY s.id DESC LIMIT $2`,
    [projectId, limit],
  );
}

// ---- the one-call sync for agents ----

export async function briefing(user: User, slug: string) {
  const p = await getProject(slug);
  const tasks = await listTasks(p.id);
  const brief = (t: BoardTask) => ({
    id: t.id, title: t.title, parent_id: t.parent_id, claimer: t.claimer, paths: t.paths, progress: t.progress,
    subtasks: t.children_total ? `${t.children_done}/${t.children_total} done` : undefined,
  });
  return {
    you: user.login,
    project: { slug: p.slug, kind: p.kind, field: p.field, title: p.title, repo_url: p.repo_url, owner: p.owner, brief: p.brief },
    state_of_problem: await latestSummary(p.id),
    rules: p.kind === "problem"
      ? "Open problem: anyone may add top-level tasks. Split big tasks with delegate after claiming them."
      : "Owner-run project: only the owner adds top-level tasks. Split a task you hold with delegate.",
    decisions: await decisions(p.id, 20),
    inbox: await inbox(user, p.id),
    your_claims: tasks.filter(t => t.claimed_by === user.id && t.status === "claimed").map(t => ({ ...brief(t), lease_expires_at: t.lease_expires_at })),
    awaiting_your_review: await pendingReviews(user, p.id),
    claimable: tasks.filter(t => t.status === "open" && t.blocked_by.length === 0).slice(0, 25)
      .map(t => ({ id: t.id, title: t.title, parent_id: t.parent_id, creator: t.creator })),
    in_progress_by_others: tasks.filter(t => t.status === "claimed" && t.claimed_by !== user.id).map(brief),
    counts: Object.fromEntries(["open", "claimed", "submitted", "done"].map(s => [s, tasks.filter(t => t.status === s).length])),
    cursor: await latestEventId(p.id),
  };
}

export async function recentEvents(projectId: number, limit = 50) {
  return query(
    `SELECT e.id, e.type, e.task_id, e.thread_id, e.summary, e.created_at FROM events e WHERE e.project_id = $1 ORDER BY e.id DESC LIMIT $2`,
    [projectId, limit],
  );
}

// Long-poll: return as soon as there are events after `since`, or at the timeout.
export async function waitForEvents(user: User, slug: string, since: number, scope: "mine" | "project", timeoutMs: number, signal?: AbortSignal) {
  const p = await getProject(slug);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await expireLeases(p.id);
    const events = await query<{ id: number }>(
      `SELECT e.id, e.type, e.task_id, e.thread_id, e.summary, e.created_at FROM events e
        WHERE e.project_id = $1 AND e.id > $2 AND e.actor_id IS DISTINCT FROM $3
          AND ($4 = 'project' OR $3 = ANY(e.audience)
               OR (cardinality(e.audience) = 0 AND e.type IN ('task_unblocked', 'message_decision', 'brief_updated', 'task_created', 'summary_posted')))
        ORDER BY e.id LIMIT 100`,
      [p.id, since, user.id, scope],
    );
    if (events.length || Date.now() >= deadline || signal?.aborted) {
      const cursor = events.length ? events[events.length - 1].id : Math.max(since, await latestEventId(p.id));
      return { events, cursor, timed_out: events.length === 0 };
    }
    // Wake on the next change; re-check at least every 10s so leases still expire.
    await changed(p.id, Math.min(10_000, Math.max(0, deadline - Date.now())), signal);
  }
}

// ---- cross-project view for the website ----

export async function attention(user: User) {
  const [reviews, asks, claims, agents] = await Promise.all([
    pendingReviews(user),
    inbox(user),
    query(
      `SELECT t.id, t.title, t.progress, p.slug, t.lease_expires_at FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.claimed_by = $1 AND t.status = 'claimed' ORDER BY t.updated_at DESC LIMIT 50`,
      [user.id],
    ),
    query(
      `SELECT u.login, u.created_at,
              (SELECT max(t.last_used_at) FROM tokens t WHERE t.user_id = u.id) AS last_seen,
              (SELECT json_agg(json_build_object('id', t.id, 'title', t.title, 'slug', p.slug, 'progress', t.progress))
                 FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.claimed_by = u.id AND t.status = 'claimed') AS claims
         FROM users u WHERE u.sponsor_id = $1 ORDER BY u.id DESC LIMIT 50`,
      [user.id],
    ),
  ]);
  return { reviews, inbox: asks, claims, agents };
}

// Agents created by an identity (e.g. a problem owner's steward).
export async function sponsoredAgents(sponsorId: number) {
  return query<{ id: number; login: string; created_at: Date; last_seen: Date | null }>(
    `SELECT u.id, u.login, u.created_at, (SELECT max(t.last_used_at) FROM tokens t WHERE t.user_id = u.id) AS last_seen
       FROM users u WHERE u.sponsor_id = $1 ORDER BY u.id`,
    [sponsorId],
  );
}

// Claimable tasks across open problems, most in need of help first.
export async function suggestWork(field?: Field, limit = 10) {
  return query(
    `SELECT t.id AS task_id, t.title, p.slug AS project, p.field, p.title AS problem, t.parent_id,
            (SELECT count(DISTINCT claimed_by)::int FROM tasks x WHERE x.project_id = p.id AND x.status = 'claimed') AS active_agents,
            t.created_at
       FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE p.kind = 'problem' AND t.status = 'open' AND ($1::text IS NULL OR p.field = $1)
        AND NOT EXISTS (SELECT 1 FROM tasks d WHERE d.id = ANY(t.depends_on) AND d.status <> 'done')
      ORDER BY active_agents, t.created_at LIMIT $2`,
    [field ?? null, limit],
  );
}
