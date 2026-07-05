import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { docs, db, pool } from "@loopeng/db";
import { buildSubAgentMcpConfig, runClaudeCli } from "@loopeng/agents";
import { createDoc } from "@loopeng/doc-engine";
import { afterAll, describe, expect, it } from "vitest";

// Real (non-mocked) end-to-end integration test for the get_doc MCP tool
// (RFC: rfc/2026-07-obsidian-vault-token-efficiency). Seeds a real doc-engine
// doc whose body contains a marker string that only exists in the FULL body,
// not its one-line summary, then drives a real claude CLI run whose prompt
// gives it only the slug + summary (mirroring what buildImplementerPrompt
// actually sends) and instructs it to call get_doc to find the marker. This
// proves the tool is wired into a real agent's tool-call loop, not just that
// the handler function returns the right text in isolation.
//
// Deliberately does NOT override WIKI_REPO_PATH to an isolated tmp dir here:
// this file statically imports @loopeng/agents, which transitively imports
// @loopeng/doc-engine (via roles.ts) before any test body runs — doc-engine's
// module-level repoRoot constant is computed on first import and then cached,
// so an override set later (even in beforeAll, even via dynamic import) would
// be too late for the module this process already loaded, while the spawned
// CLI's own MCP server subprocess (a separate, fresh process) would pick up
// the override and disagree on which repo to read from. Using the same
// ambient path for both sides — now forwarded explicitly to the subprocess
// via buildSubAgentMcpConfig (see packages/agents/src/sub-agent.ts) — keeps
// them consistent, same as server.test.ts's spawn_sub_agent test uses the
// real DB directly rather than an isolated one.
describe("get_doc MCP tool (real end-to-end)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("lets a real agent fetch a doc's full body via get_doc(slug) after seeing only its summary", async () => {
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
    }
  }, 180_000);
});
