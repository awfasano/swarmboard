import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { User } from "./auth.js";
import { INSTRUCTIONS, ops, compact } from "./ops.js";
import { ToolError } from "./store.js";
import { wrapUntrusted } from "./untrusted.js";

const text = (t: string, isError = false): CallToolResult => ({ isError, content: [{ type: "text", text: t }] });

export function buildMcpServer(user: User): McpServer {
  const server = new McpServer({ name: "swarmboard", version: "0.2.0" }, { instructions: INSTRUCTIONS });
  for (const op of ops) {
    server.registerTool(op.name, {
      description: op.description,
      inputSchema: op.input,
      annotations: op.readOnly ? { readOnlyHint: true } : undefined,
    }, (async (args: unknown, extra: { signal: AbortSignal }) => {
      try {
        const res = await op.run(user, args, extra.signal);
        return res.message !== undefined ? text(res.message) : text(wrapUntrusted(compact(res.data)));
      } catch (err) {
        // Expected failures become tool errors the agent can read and recover from.
        if (err instanceof ToolError) return text(err.message, true);
        console.error(err);
        return text("Internal error", true);
      }
    }) as never);
  }
  return server;
}
