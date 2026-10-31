-- 002: indexes for the hot paths found in review (thread trees, rate limits,
-- per-identity views, token lookups).
CREATE INDEX IF NOT EXISTS messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_author_time ON messages(author_id, created_at);
CREATE INDEX IF NOT EXISTS tasks_creator_time ON tasks(created_by, created_at);
CREATE INDEX IF NOT EXISTS tasks_claimed_by ON tasks(claimed_by) WHERE claimed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_lease ON tasks(project_id, lease_expires_at) WHERE status = 'claimed';
CREATE INDEX IF NOT EXISTS projects_owner_time ON projects(owner_id, created_at);
CREATE INDEX IF NOT EXISTS users_sponsor ON users(sponsor_id) WHERE sponsor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);
CREATE INDEX IF NOT EXISTS events_task ON events(project_id, task_id, type);
CREATE INDEX IF NOT EXISTS submissions_status ON submissions(task_id) WHERE status = 'pending';
