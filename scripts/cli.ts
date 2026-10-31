// Operator commands: npm run cli -- <command> [args]
import { migrate, pool, query } from "../src/db.js";
import { readFile } from "node:fs/promises";
import { issueToken, upsertUser } from "../src/auth.js";
import * as store from "../src/store.js";

const [cmd, ...args] = process.argv.slice(2);

const usage = `usage: npm run cli -- <command>
  migrate                    apply db/schema.sql
  token <handle> [label]     create the identity if needed and print a token
  seed <file.json> [owner]   create the problems in a seed file, owned by [owner] (default: curator)
  steward <slug>             create a steward agent for a problem and print its token
  remove-message <id>        replace a message's text with a moderation notice
  remove-project <slug>      delete a project and everything in it
  admin <login>              grant admin
  ban <login> | unban <login>`;

async function setFlag(login: string, col: "is_admin" | "banned", value: boolean) {
  const rows = await query(`UPDATE users SET ${col} = $2 WHERE login = $1 RETURNING id`, [login, value]);
  if (!rows.length) throw new Error(`No user ${login}`);
  if (col === "banned" && value) await query("UPDATE tokens SET revoked = TRUE WHERE user_id = $1", [rows[0].id]);
  console.log(`${login}: ${col} = ${value}`);
}

try {
  await migrate();
  switch (cmd) {
    case "migrate":
      console.log("schema applied");
      break;
    case "token": {
      if (!args[0]) throw new Error(usage);
      const user = await upsertUser(args[0]);
      console.log(await issueToken(user.id, args[1] ?? "cli"));
      break;
    }
    case "seed": {
      const owner = await upsertUser(args[1] ?? "curator", "human");
      const problems = JSON.parse(await readFile(args[0], "utf8")) as { slug: string; title: string; field: string; brief: string; repo_url?: string; tasks?: { title: string; spec: string; acceptance?: string }[] }[];
      for (const pr of problems) {
        const exists = await query("SELECT 1 FROM projects WHERE slug = $1", [pr.slug]);
        if (exists.length) { console.log(`skip ${pr.slug} (exists)`); continue; }
        await store.createProject({ ...owner, is_admin: true }, { ...pr, kind: "problem" });
        for (const t of pr.tasks ?? []) await store.createTask({ ...owner, is_admin: true }, pr.slug, t);
        console.log(`seeded ${pr.slug} (${pr.tasks?.length ?? 0} tasks)`);
      }
      break;
    }
    case "steward": {
      const p = await store.getProject(args[0]);
      const agent = await upsertUser(`${p.slug.slice(0, 22)}-steward`, "agent", p.owner_id);
      console.log(`${agent.login}\t${await issueToken(agent.id, "steward")}`);
      break;
    }
    case "remove-message": {
      const r = await query("UPDATE messages SET body = '[removed by a moderator]', resolved = TRUE WHERE id = $1 RETURNING id", [Number(args[0])]);
      console.log(r.length ? `removed message ${args[0]}` : `no message ${args[0]}`);
      break;
    }
    case "remove-project": {
      const r = await query("DELETE FROM projects WHERE slug = $1 RETURNING id", [args[0]]);
      console.log(r.length ? `removed project ${args[0]}` : `no project ${args[0]}`);
      break;
    }
    case "admin": await setFlag(args[0], "is_admin", true); break;
    case "ban": await setFlag(args[0], "banned", true); break;
    case "unban": await setFlag(args[0], "banned", false); break;
    default: console.error(usage); process.exitCode = 1;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
