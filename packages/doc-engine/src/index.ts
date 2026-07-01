import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { adrs, docVersions, docs, skills } from "@loopeng/db";
import type { DocCreateInput, DocUpdateInput } from "@loopeng/shared";
import { GitDocClient, repoRelativePath } from "./git-client.js";
import { parseDoc, stringifyDoc, type DocFrontmatter } from "./frontmatter.js";

export { GitDocClient, repoRelativePath } from "./git-client.js";
export * from "./frontmatter.js";
export * from "./drift.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

const repoRoot = process.env.WIKI_REPO_PATH ?? path.join(process.cwd(), "data", "wiki-repo");
const gitClient = new GitDocClient(repoRoot);
let repoReady = false;

async function ensureRepoReady() {
  if (!repoReady) {
    await gitClient.ensureRepo();
    repoReady = true;
  }
}

export async function getTemplate(docType: "adr" | "rfc" | "skill"): Promise<string> {
  return readFile(path.join(TEMPLATES_DIR, `${docType}.md`), "utf-8");
}

export async function createDoc(input: DocCreateInput) {
  await ensureRepoReady();
  const relPath = repoRelativePath(input.docType, input.slug);
  const frontmatter: DocFrontmatter = {
    id: input.slug,
    type: input.docType,
    title: input.title,
    status: "draft",
    tags: input.tags,
    linked_cards: [],
    supersedes: null,
    created: new Date().toISOString().slice(0, 10),
  };
  const fileContent = stringifyDoc(frontmatter, input.content);
  const sha = await gitClient.writeAndCommit(relPath, fileContent, input.message);

  const [doc] = await db
    .insert(docs)
    .values({
      slug: input.slug,
      title: input.title,
      docType: input.docType,
      repoPath: relPath,
      latestCommitSha: sha,
      status: "draft",
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

  const { frontmatter } = parseDoc(await gitClient.readAtWorkingTree(existing.repoPath));
  const nextFrontmatter: DocFrontmatter = {
    ...frontmatter,
    status: input.status ?? frontmatter.status,
  };
  const fileContent = stringifyDoc(nextFrontmatter, input.content);
  const sha = await gitClient.writeAndCommit(existing.repoPath, fileContent, input.message);

  const [updated] = await db
    .update(docs)
    .set({ latestCommitSha: sha, status: nextFrontmatter.status, updatedAt: new Date() })
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
  const { body, frontmatter } = parseDoc(await gitClient.readAtWorkingTree(doc.repoPath));
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
