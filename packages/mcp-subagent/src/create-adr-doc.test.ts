import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { boards, cardDocLinks, cards, db, docs, pool } from "@loopeng/db";
import { buildSubAgentMcpConfig, runClaudeCli } from "@loopeng/agents";
import { afterAll, describe, expect, it } from "vitest";

// Real (non-mocked) end-to-end integration test for the create_adr_doc MCP
// tool -- the mechanism buildImplementerPrompt now points a touchesArchitecture
// card's implementer run at (see packages/agents/src/prompts.ts's
// ADR_DRAFT_INSTRUCTIONS). Drives a real claude CLI run, with a real card
// row so the tool has something to link against, exactly like get-doc.test.ts
// and server.test.ts do for the sibling tools in this same MCP server.
describe("create_adr_doc MCP tool (real end-to-end)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("lets a real agent draft an ADR that ends up proposed and linked to the card", async () => {
    const [board] = await db
      .insert(boards)
      .values({ name: "create-adr-doc-e2e-verify (temporary)", description: "Deleted at end of test run" })
      .returning();
    if (!board) throw new Error("failed to insert board");

    const [card] = await db
      .insert(cards)
      .values({
        boardId: board.id,
        title: "e2e: create_adr_doc verification card",
        touchesArchitecture: true,
        state: "in_progress",
      })
      .returning();
    if (!card) throw new Error("failed to insert card");

    const slug = `create-adr-doc-e2e-verify-${Date.now()}`;
    const marker = `MARKER-${randomUUID().slice(0, 8)}`;

    const mcpConfig = buildSubAgentMcpConfig({
      parentAgentRunId: randomUUID(),
      cardId: card.id,
      worktreeId: null,
      cwd: process.cwd(),
      depth: 1,
      disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash"],
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
      // Cascades cards -> card_doc_links.
      await db.delete(boards).where(eq(boards.id, board.id));
    }
  }, 180_000);
});
