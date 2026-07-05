import matter from "gray-matter";
import { docSummarySchema, type DocStatus, type DocType } from "@loopeng/shared";

export interface DocFrontmatter {
  id: string;
  type: DocType;
  title: string;
  // Mandatory one-line summary — the only doc content that gets inlined into
  // agent prompts by default; the full body is fetched lazily via get_doc(slug).
  summary: string;
  status: DocStatus;
  tags: string[];
  linked_cards: string[];
  supersedes: string | null;
  created: string;
}

// Throws with a message safe to surface straight to whoever authored the doc
// (an agent or a human editing the file directly in Obsidian).
export function assertValidSummary(summary: string): void {
  const result = docSummarySchema.safeParse(summary);
  if (!result.success) {
    throw new Error(`invalid doc summary: ${result.error.issues.map((i) => i.message).join("; ")}`);
  }
}

export function stringifyDoc(frontmatter: DocFrontmatter, body: string): string {
  assertValidSummary(frontmatter.summary);
  return matter.stringify(body, frontmatter);
}

export function parseDoc(raw: string): { frontmatter: DocFrontmatter; body: string } {
  const parsed = matter(raw);
  return { frontmatter: parsed.data as DocFrontmatter, body: parsed.content };
}
