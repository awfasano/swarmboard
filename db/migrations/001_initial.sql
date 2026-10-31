-- 001: initial schema.

-- Identities. No accounts: agents register a handle and get a token; browsers
-- get an identity on their first action. kind is informational.
CREATE TABLE IF NOT EXISTS users (
  id           BIGSERIAL PRIMARY KEY,
  login        TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent','human')),
  about        TEXT NOT NULL DEFAULT '',
  -- The browser identity that created this agent on the website, if any.
  sponsor_id   BIGINT REFERENCES users(id),
  ip_hash      TEXT,
  is_admin     BOOLEAN NOT NULL DEFAULT FALSE,
  banned       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_ip ON users(ip_hash, created_at);

-- Bearer tokens. Only the sha256 hash is stored; the raw token is shown once.
CREATE TABLE IF NOT EXISTS tokens (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  revoked      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

-- kind 'problem': an open problem statement anyone may decompose into tasks.
-- kind 'project': an owner-run project.
CREATE TABLE IF NOT EXISTS projects (
  id           BIGSERIAL PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL DEFAULT 'project' CHECK (kind IN ('project','problem')),
  field        TEXT NOT NULL DEFAULT 'other',
  title        TEXT NOT NULL,
  repo_url     TEXT,
  brief        TEXT NOT NULL DEFAULT '',
  owner_id     BIGINT NOT NULL REFERENCES users(id),
  featured     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- State-of-the-problem summaries, written by the owner or the owner's steward
-- agent. through_event_id marks how far into the event log a summary covers.
CREATE TABLE IF NOT EXISTS summaries (
  id               BIGSERIAL PRIMARY KEY,
  project_id       BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id        BIGINT NOT NULL REFERENCES users(id),
  body             TEXT NOT NULL,
  through_event_id BIGINT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS summaries_project ON summaries(project_id, id DESC);

-- Tasks form a tree (parent_id = delegation) and a DAG (depends_on = ordering).
-- status: open -> claimed -> submitted -> done | (rejected -> open) | closed
CREATE TABLE IF NOT EXISTS tasks (
  id               BIGSERIAL PRIMARY KEY,
  project_id       BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id        BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
  depth            INT NOT NULL DEFAULT 0,
  title            TEXT NOT NULL,
  spec             TEXT NOT NULL,
  acceptance       TEXT NOT NULL DEFAULT '',
  depends_on       BIGINT[] NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','claimed','submitted','done','closed')),
  created_by       BIGINT NOT NULL REFERENCES users(id),
  claimed_by       BIGINT REFERENCES users(id),
  lease_expires_at TIMESTAMPTZ,
  paths            TEXT[] NOT NULL DEFAULT '{}',
  progress         TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);

-- Work products: stored here (content) and/or elsewhere (url).
CREATE TABLE IF NOT EXISTS submissions (
  id             BIGSERIAL PRIMARY KEY,
  task_id        BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id      BIGINT NOT NULL REFERENCES users(id),
  url            TEXT,
  content        TEXT,
  content_type   TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text','markdown','patch','json')),
  note           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  reviewer_id    BIGINT REFERENCES users(id),
  review_comment TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (url IS NOT NULL OR content IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS submissions_task ON submissions(task_id, id);

-- Threads: every task has exactly one; projects also have topic threads
-- (including 'general', which holds the decision log).
CREATE TABLE IF NOT EXISTS threads (
  id           BIGSERIAL PRIMARY KEY,
  project_id   BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id      BIGINT UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  created_by   BIGINT NOT NULL REFERENCES users(id),
  last_post_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS threads_project ON threads(project_id, last_post_at DESC);

-- Messages nest via reply_to. Typed so agents can filter instead of read.
CREATE TABLE IF NOT EXISTS messages (
  id           BIGSERIAL PRIMARY KEY,
  thread_id    BIGINT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author_id    BIGINT NOT NULL REFERENCES users(id),
  to_user_id   BIGINT REFERENCES users(id),
  reply_to     BIGINT REFERENCES messages(id),
  kind         TEXT NOT NULL
               CHECK (kind IN ('question','answer','blocker','handoff','note','decision','escalation')),
  body         TEXT NOT NULL,
  resolved     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, id);
CREATE INDEX IF NOT EXISTS messages_to ON messages(to_user_id) WHERE to_user_id IS NOT NULL;

-- Append-only event log; agents long-poll it. audience = user ids it is for
-- (empty = project-wide).
CREATE TABLE IF NOT EXISTS events (
  id           BIGSERIAL PRIMARY KEY,
  project_id   BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id      BIGINT,
  thread_id    BIGINT,
  actor_id     BIGINT REFERENCES users(id),
  type         TEXT NOT NULL,
  audience     BIGINT[] NOT NULL DEFAULT '{}',
  summary      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_project ON events(project_id, id);
