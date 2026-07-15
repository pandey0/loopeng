import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { agentRuns, boards, cardDocLinks, cards, createApiKey, db, docs, pool } from "@loopeng/db";
import { buildSubAgentMcpConfig, runClaudeCli } from "@loopeng/agents";
import { afterAll, describe, expect, it } from "vitest";
import { authPlugin } from "../plugins/auth.js";
import { errorHandlerPlugin } from "../plugins/error-handler.js";
import { cardRoutes } from "./cards.js";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

// Real (non-mocked) end-to-end integration test for the create_adr_doc MCP
// tool, against a real, listening instance of this API's own
// POST /cards/:id/adr-docs route (requireActor + requireOwnCard). Replaces
// packages/mcp-subagent's old create-adr-doc.test.ts, which drove
// createDoc()/db.insert(cardDocLinks) directly from inside the MCP server
// process -- card 438646e5 removed that raw-DB path (the same class of gap
// this whole card exists to close: an agent-spawned process with its own
// DATABASE_URL access), so the real thing worth exercising end-to-end now is
// the HTTP route, same reasoning as docs.get-doc.e2e.test.ts and
// agent-runs.e2e.test.ts for the sibling tools in this same MCP server.
async function buildApp(): Promise<{ app: FastifyInstance; url: string }> {
  const fastify = Fastify();
  fastify.decorate("db", db);
  await fastify.register(errorHandlerPlugin);
  await fastify.register(authPlugin);
  await fastify.register(cardRoutes);
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = fastify.server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
  return { app: fastify, url: `http://127.0.0.1:${address.port}` };
}

describe("create_adr_doc MCP tool (real end-to-end, over the /cards/:id/adr-docs API)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("lets a real agent draft an ADR that ends up proposed and linked to its own card", async () => {
    const { app, url } = await buildApp();

    const [board] = await db.insert(boards).values({ name: "create-adr-doc-e2e-verify (temporary)" }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");

    const [card] = await db
      .insert(cards)
      .values({ boardId: board.id, title: "e2e: create_adr_doc verification card", touchesArchitecture: true, state: "in_progress" })
      .returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");

    // Scoped to the card, same as a real implementer run's own credential
    // (runApiKeyEnv in @loopeng/agents) -- requireOwnCard checks this run's
    // cardId matches the :id in the URL, exactly what a real agent's
    // CARD_API_KEY is minted against.
    const [run] = await db.insert(agentRuns).values({ cardId: card.id, status: "running" }).returning({ id: agentRuns.id });
    if (!run) throw new Error("agent run insert returned no row");
    const { token: cardApiKey } = await createApiKey({ actorType: "agent", actorId: run.id, label: "test-agent" });

    const slug = `create-adr-doc-e2e-verify-${Date.now()}`;
    const marker = `MARKER-${randomUUID().slice(0, 8)}`;

    const mcpConfig = buildSubAgentMcpConfig({
      parentAgentRunId: run.id,
      cardId: card.id,
      worktreeId: null,
      cwd: process.cwd(),
      depth: 1,
      disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash"],
      cardApiKey,
      cardApiUrl: url,
    });

    const prompt = [
      `Call the create_adr_doc tool exactly once with slug "${slug}", title "e2e ADR", summary`,
      '"Throwaway ADR for the create_adr_doc MCP tool e2e verification test.", content',
      `"## Context\\n${marker}\\n\\n## Decision\\nThrowaway.", and tags [].`,
      "Then reply with exactly: TOOL-SAID: <the tool's exact response text>",
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
      expect(result.resultText).toContain("proposed");

      const [doc] = await db.select().from(docs).where(eq(docs.slug, slug));
      expect(doc, "expected the ADR doc to actually exist in the real docs table").toBeTruthy();
      expect(doc!.docType).toBe("adr");
      expect(doc!.status).toBe("proposed");

      const [link] = await db
        .select()
        .from(cardDocLinks)
        .where(and(eq(cardDocLinks.cardId, card.id), eq(cardDocLinks.docId, doc!.id), eq(cardDocLinks.linkType, "adr")));
      expect(link, "expected an adr-linked card_doc_links row for this card").toBeTruthy();

      await db.delete(docs).where(eq(docs.id, doc!.id));
    } finally {
      // Cascades cards -> card_doc_links, agent_runs.
      await db.delete(boards).where(eq(boards.id, board.id));
      await app.close();
    }
  }, 180_000);

  it("refuses to create an ADR for a card the caller's credential isn't scoped to", async () => {
    const { app, url } = await buildApp();

    const [board] = await db.insert(boards).values({ name: "create-adr-doc-e2e-verify-other-card (temporary)" }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");

    const [ownCard] = await db.insert(cards).values({ boardId: board.id, title: "agent's own card", state: "in_progress" }).returning({ id: cards.id });
    const [otherCard] = await db.insert(cards).values({ boardId: board.id, title: "an unrelated card", state: "in_progress" }).returning({ id: cards.id });
    if (!ownCard || !otherCard) throw new Error("card insert returned no row");

    const [run] = await db.insert(agentRuns).values({ cardId: ownCard.id, status: "running" }).returning({ id: agentRuns.id });
    if (!run) throw new Error("agent run insert returned no row");
    const { token: cardApiKey } = await createApiKey({ actorType: "agent", actorId: run.id, label: "test-agent" });

    const res = await fetch(`${url}/cards/${otherCard.id}/adr-docs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cardApiKey}` },
      body: JSON.stringify({ slug: `should-not-exist-${Date.now()}`, title: "t", summary: "s", content: "c", tags: [] }),
    });

    try {
      expect(res.status).toBe(403);
    } finally {
      await db.delete(boards).where(eq(boards.id, board.id));
      await app.close();
    }
  });
});
