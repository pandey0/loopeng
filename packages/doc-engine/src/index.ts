import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { adrs, docVersions, docs, skills } from "@loopeng/db";
import type { DocCreateInput, DocStatus, DocUpdateInput } from "@loopeng/shared";
import { GitDocClient, repoRelativePath } from "./git-client.js";
import { assertValidSummary, parseDoc, stringifyDoc, type DocFrontmatter } from "./frontmatter.js";

export { GitDocClient, repoRelativePath } from "./git-client.js";
export * from "./frontmatter.js";
export * from "./drift.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

const repoRoot = process.env.WIKI_REPO_PATH ?? path.join(process.cwd(), "data", "wiki-repo");
// Constructed lazily, not at module load: simple-git throws synchronously if
// its baseDir doesn't exist yet, and nothing has mkdir'd repoRoot at import
// time (that's ensureRepo()'s job). Any package that merely imports doc-engine
// without ever calling a doc-touching function must not pay for — or crash
// on — a git client it never uses.
let gitClient: GitDocClient | null = null;
let repoReady = false;

async function ensureRepoReady() {
  if (!repoReady) {
    gitClient ??= new GitDocClient(repoRoot);
    await gitClient.ensureRepo();
    repoReady = true;
  }
}

export async function getTemplate(docType: "adr" | "rfc" | "skill"): Promise<string> {
  return readFile(path.join(TEMPLATES_DIR, `${docType}.md`), "utf-8");
}

// The optional `status` override exists for callers that need a doc to start
// somewhere other than "draft" -- e.g. the implementer agent's create_adr_doc
// MCP tool (packages/mcp-subagent/src/server.ts) creates ADRs straight into
// "proposed", since an ADR drafted by an agent is immediately ready for human
// review, not a private work-in-progress. Not exposed on DocCreateInput/the
// public POST /docs route: every other caller (planner spec docs, designer
// specs, project briefs) wants the existing "draft" default unchanged.
export async function createDoc(input: DocCreateInput, options?: { status?: DocStatus }) {
  await ensureRepoReady();
  const status = options?.status ?? "draft";
  const relPath = repoRelativePath(input.docType, input.slug);
  const frontmatter: DocFrontmatter = {
    id: input.slug,
    type: input.docType,
    title: input.title,
    summary: input.summary,
    status,
    tags: input.tags,
    linked_cards: [],
    supersedes: null,
    created: new Date().toISOString().slice(0, 10),
  };
  const fileContent = stringifyDoc(frontmatter, input.content);
  const sha = await gitClient!.writeAndCommit(relPath, fileContent, input.message);

  const [doc] = await db
    .insert(docs)
    .values({
      slug: input.slug,
      title: input.title,
      docType: input.docType,
      repoPath: relPath,
      latestCommitSha: sha,
      summary: input.summary,
      status,
      tags: input.tags,
      createdBy: input.authorId ?? null,
    })
    .returning();
  if (!doc) throw new Error("failed to insert doc row");

  await db.insert(docVersions).values({
    docId: doc.id,
    commitSha: sha,
    authorId: input.authorId ?? null,
    message: input.message,
    createdAt: new Date(),
  });

  if (input.docType === "adr") {
    const existingAdrs = await db.select().from(adrs);
    await db.insert(adrs).values({ docId: doc.id, adrNumber: existingAdrs.length + 1, decisionSummary: null, supersedesDocId: null });
  }
  if (input.docType === "skill") {
    await db.insert(skills).values({ docId: doc.id, applicabilityTags: input.tags, lastVerifiedAt: null, sourceCardId: null });
  }

  return doc;
}

export async function updateDoc(slug: string, input: DocUpdateInput) {
  await ensureRepoReady();
  const [existing] = await db.select().from(docs).where(eq(docs.slug, slug));
  if (!existing) throw new Error(`doc not found: ${slug}`);

  const { frontmatter } = parseDoc(await gitClient!.readAtWorkingTree(existing.repoPath));
  const nextFrontmatter: DocFrontmatter = {
    ...frontmatter,
    summary: input.summary ?? frontmatter.summary,
    status: input.status ?? frontmatter.status,
  };
  // Enforced here (not just at the zod/API boundary) because updateDoc is also
  // called directly by orchestrator/scripts — a doc written without ever going
  // through the HTTP route must not be able to leave its summary empty either.
  assertValidSummary(nextFrontmatter.summary);
  const fileContent = stringifyDoc(nextFrontmatter, input.content);
  const sha = await gitClient!.writeAndCommit(existing.repoPath, fileContent, input.message);

  const [updated] = await db
    .update(docs)
    .set({
      latestCommitSha: sha,
      summary: nextFrontmatter.summary,
      status: nextFrontmatter.status,
      updatedAt: new Date(),
    })
    .where(eq(docs.id, existing.id))
    .returning();

  await db.insert(docVersions).values({
    docId: existing.id,
    commitSha: sha,
    authorId: input.authorId ?? null,
    message: input.message,
    createdAt: new Date(),
  });

  return updated;
}

export async function getDoc(slug: string) {
  const [doc] = await db.select().from(docs).where(eq(docs.slug, slug));
  if (!doc) return null;
  await ensureRepoReady();
  const { body, frontmatter } = parseDoc(await gitClient!.readAtWorkingTree(doc.repoPath));
  return { ...doc, body, frontmatter };
}

export async function getDocVersions(slug: string) {
  const [doc] = await db.select().from(docs).where(eq(docs.slug, slug));
  if (!doc) return [];
  return db.select().from(docVersions).where(eq(docVersions.docId, doc.id));
}

export async function listDocs(filter?: { docType?: string; tag?: string }) {
  if (filter?.docType) {
    return db.select().from(docs).where(eq(docs.docType, filter.docType));
  }
  return db.select().from(docs);
}
