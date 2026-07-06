import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, docs, pool } from "@loopeng/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createDoc as CreateDoc, getDoc as GetDoc, updateDoc as UpdateDoc } from "./index.js";

// Point this test run at a throwaway git repo instead of the real dev
// data/wiki-repo. Deliberately NOT a top-level `process.env.WIKI_REPO_PATH =`
// assignment mixed in among this file's static imports: ESM hoists every
// static import to run (in source order, among themselves) before any of
// this module's own non-import statements — so an env write placed between
// import lines still runs *after* "./index.js" (and its module-level
// `repoRoot` constant) has already been evaluated. Setting the env var and
// only then dynamically importing index.js is what actually makes the
// override take effect.
let createDoc: typeof CreateDoc;
let getDoc: typeof GetDoc;
let updateDoc: typeof UpdateDoc;

beforeAll(async () => {
  process.env.WIKI_REPO_PATH = path.join(os.tmpdir(), `doc-engine-test-${randomUUID()}`);
  ({ createDoc, getDoc, updateDoc } = await import("./index.js"));
});

afterAll(async () => {
  await pool.end();
});

describe("mandatory doc summary (create/update)", () => {
  it("persists the summary to both the frontmatter and the docs row", async () => {
    const slug = `test-doc-${randomUUID()}`;
    const doc = await createDoc({
      slug,
      title: "Test Doc",
      docType: "wiki",
      content: "Body text.",
      summary: "One-line summary of the test doc.",
      tags: [],
      message: "create doc",
    });

    expect(doc.summary).toBe("One-line summary of the test doc.");

    const full = await getDoc(slug);
    expect(full?.frontmatter.summary).toBe("One-line summary of the test doc.");

    await db.delete(docs).where(eq(docs.id, doc.id));
  });

  it("rejects an empty summary on create", async () => {
    const slug = `test-doc-${randomUUID()}`;
    await expect(
      createDoc({
        slug,
        title: "Test Doc",
        docType: "wiki",
        content: "Body text.",
        summary: "",
        tags: [],
        message: "create doc",
      }),
    ).rejects.toThrow(/summary/i);
  });

  it("rejects a multi-line summary on create", async () => {
    const slug = `test-doc-${randomUUID()}`;
    await expect(
      createDoc({
        slug,
        title: "Test Doc",
        docType: "wiki",
        content: "Body text.",
        summary: "line one\nline two",
        tags: [],
        message: "create doc",
      }),
    ).rejects.toThrow(/single line/i);
  });

  it("keeps the existing summary on update when none is provided", async () => {
    const slug = `test-doc-${randomUUID()}`;
    const doc = await createDoc({
      slug,
      title: "Test Doc",
      docType: "wiki",
      content: "Body v1.",
      summary: "Original summary.",
      tags: [],
      message: "create doc",
    });

    const updated = await updateDoc(slug, { content: "Body v2.", message: "update doc" });
    expect(updated?.summary).toBe("Original summary.");

    await db.delete(docs).where(eq(docs.id, doc.id));
  });

  it("overrides the summary on update when a new one is provided", async () => {
    const slug = `test-doc-${randomUUID()}`;
    const doc = await createDoc({
      slug,
      title: "Test Doc",
      docType: "wiki",
      content: "Body v1.",
      summary: "Original summary.",
      tags: [],
      message: "create doc",
    });

    const updated = await updateDoc(slug, {
      content: "Body v2.",
      summary: "Revised summary.",
      message: "update doc",
    });
    expect(updated?.summary).toBe("Revised summary.");

    const full = await getDoc(slug);
    expect(full?.frontmatter.summary).toBe("Revised summary.");

    await db.delete(docs).where(eq(docs.id, doc.id));
  });
});

// Automated, deterministic proof (runs in CI, isolated tmp vault — not
// dependent on the real dev data/wiki-repo) that the vault produces valid
// Obsidian frontmatter and connected [[wikilinks]] between docs, for the
// "data/wiki-repo opens as a valid Obsidian vault with working wikilinks"
// acceptance criterion on rfc/2026-07-obsidian-vault-token-efficiency.
describe("Obsidian vault: frontmatter + wikilinks", () => {
  it("round-trips a [[wikilink]] between two docs through real YAML frontmatter parsing", async () => {
    const slugA = `wikilink-target-${randomUUID()}`;
    const slugB = `wikilink-source-${randomUUID()}`;

    const target = await createDoc({
      slug: slugA,
      title: "Wikilink target doc",
      docType: "wiki",
      content: "## Body\nThe doc other docs link to.",
      summary: "Target doc for the wikilink round-trip test.",
      tags: [],
      message: "create target doc",
    });

    const source = await createDoc({
      slug: slugB,
      title: "Wikilink source doc",
      docType: "wiki",
      content: `## Related\n- [[${slugA}]] — the doc this one links to.`,
      summary: "Source doc for the wikilink round-trip test.",
      tags: [],
      message: "create source doc",
    });

    const full = await getDoc(slugB);
    // Proves the body — including the [[wikilink]] — survives a real
    // gray-matter stringify/parse round trip through the git-backed vault,
    // exactly as Obsidian itself would read the file off disk.
    expect(full?.body).toContain(`[[${slugA}]]`);
    expect(full?.frontmatter.summary).toBe("Source doc for the wikilink round-trip test.");

    const linkedDoc = await getDoc(slugA);
    expect(linkedDoc).not.toBeNull();
    expect(linkedDoc?.title).toBe("Wikilink target doc");

    await db.delete(docs).where(eq(docs.id, target.id));
    await db.delete(docs).where(eq(docs.id, source.id));
  });
});
