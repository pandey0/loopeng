import matter from "gray-matter";
import type { DocStatus, DocType } from "@loopeng/shared";

export interface DocFrontmatter {
  id: string;
  type: DocType;
  title: string;
  status: DocStatus;
  tags: string[];
  linked_cards: string[];
  supersedes: string | null;
  created: string;
}

export function stringifyDoc(frontmatter: DocFrontmatter, body: string): string {
  return matter.stringify(body, frontmatter);
}

export function parseDoc(raw: string): { frontmatter: DocFrontmatter; body: string } {
  const parsed = matter(raw);
  return { frontmatter: parsed.data as DocFrontmatter, body: parsed.content };
}
