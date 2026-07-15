import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { docs, db, pool } from "@loopeng/db";
import { buildSubAgentMcpConfig, runClaudeCli } from "@loopeng/agents";
import { createDoc } from "@loopeng/doc-engine";
import { afterAll, describe, expect, it } from "vitest";
import { authPlugin } from "../plugins/auth.js";
import { errorHandlerPlugin } from "../plugins/error-handler.js";
import { docRoutes } from "./docs.js";

// Real (non-mocked) end-to-end integration test for the get_doc MCP tool
// (RFC: rfc/2026-07-obsidian-vault-token-efficiency), against a real,
// listening instance of this API's own /docs routes. Seeds a real doc-engine
// doc whose body contains a marker string that only exists in the FULL body,
// not its one-line summary, then drives a real claude CLI run whose prompt
// gives it only the slug + summary (mirroring what buildImplementerPrompt
// actually sends) and instructs it to call get_doc to find the marker. This
// proves the tool is wired into a real agent's tool-call loop, not just that
// the handler function returns the right text in isolation. Replaces
// packages/mcp-subagent's old get-doc.test.ts, which drove doc-engine's
// getDoc() (and a direct-DB read) from inside the MCP server process --
// card 438646e5 replaced that with an HTTP call to this route, which is why
// the real thing worth exercising end-to-end now lives here.
async function buildApp(): Promise<{ app: FastifyInstance; url: string }> {
  const fastify = Fastify();
  await fastify.register(errorHandlerPlugin);
  await fastify.register(authPlugin);
  await fastify.register(docRoutes);
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = fastify.server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
  return { app: fastify, url: `http://127.0.0.1:${address.port}` };
}

describe("get_doc MCP tool (real end-to-end, over the /docs API)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("lets a real agent fetch a doc's full body via get_doc(slug) after seeing only its summary", async () => {
    const { app, url } = await buildApp();
    const marker = `MARKER-${randomUUID().slice(0, 8)}`;
    const slug = `get-doc-e2e-verify-${Date.now()}`;

    const doc = await createDoc({
      slug,
      title: "get_doc e2e verify doc",
      docType: "wiki",
      content: `## Body\n\nThis sentence only exists in the full doc body: ${marker}`,
      summary: "Throwaway doc for the get_doc MCP tool e2e verification test.",
      tags: [],
      message: "get_doc e2e verification doc",
    });

    const mcpConfig = buildSubAgentMcpConfig({
      parentAgentRunId: randomUUID(),
      cardId: null,
      worktreeId: null,
      cwd: process.cwd(),
      depth: 1,
      disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash"],
      cardApiKey: "lk_unused",
      cardApiUrl: url,
    });

    const prompt = [
      `There is a doc available with slug "${slug}" and summary "Throwaway doc for the get_doc MCP`,
      'tool e2e verification test." — that summary is all you know about it so far.',
      `Call the get_doc tool with { "slug": "${slug}" } to fetch its full text, find the sentence`,
      'that starts with "This sentence only exists in the full doc body:", and reply with exactly:',
      "MARKER-FOUND: <the marker text after the colon, trimmed>",
      "Do not add any other words.",
    ].join(" ");

    const result = await runClaudeCli({
      cwd: process.cwd(),
      prompt,
      permissionMode: "bypassPermissions",
      disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash"],
      mcpConfig,
    });

    try {
      expect(result.isError).toBeFalsy();
      // Proves the agent actually called get_doc and read the real body text —
      // the marker never appears anywhere in the prompt itself, only inside
      // the doc body that get_doc alone can return.
      expect(result.resultText).toContain(marker);
    } finally {
      await db.delete(docs).where(eq(docs.id, doc.id));
      await app.close();
    }
  }, 180_000);
});
