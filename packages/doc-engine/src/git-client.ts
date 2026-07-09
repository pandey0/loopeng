import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { CheckRepoActions, simpleGit, type SimpleGit } from "simple-git";

export interface CommitAuthor {
  name: string;
  email: string;
}

const DOC_TYPE_DIRS: Record<string, string> = {
  wiki: "wiki",
  adr: "adr",
  rfc: "rfc",
  skill: "skills",
};

export function repoRelativePath(docType: string, slug: string): string {
  const dir = DOC_TYPE_DIRS[docType] ?? "wiki";
  return path.join(dir, `${slug}.md`);
}

export class GitDocClient {
  // Built lazily inside ensureRepo(), not the constructor: simple-git validates
  // that baseDir exists synchronously at construction time, and nothing has
  // mkdir'd repoRoot yet when this class is instantiated (that's ensureRepo()'s
  // own first step, immediately below). Every other method on this class
  // assumes ensureRepo() has already run — same contract index.ts already
  // relies on via its ensureRepoReady() gate.
  private git!: SimpleGit;

  constructor(private readonly repoRoot: string) {}

  async ensureRepo(): Promise<void> {
    await mkdir(this.repoRoot, { recursive: true });
    for (const dir of Object.values(DOC_TYPE_DIRS)) {
      await mkdir(path.join(this.repoRoot, dir), { recursive: true });
    }
    this.git ??= simpleGit(this.repoRoot);
    // Deliberately IS_REPO_ROOT, not the default "inside a work tree" check:
    // the latter walks up parent directories and returns true whenever
    // repoRoot sits under an unrelated ancestor repo (e.g. WIKI_REPO_PATH left
    // unset with cwd inside this monorepo checkout) — which then silently
    // skips `git init` here and routes every write/commit into that ancestor
    // repo's own history instead of an isolated one. Checking the root
    // specifically ensures repoRoot always gets its own real .git.
    const isRepo = await this.git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT).catch(() => false);
    if (!isRepo) {
      await this.git.init();
      await this.git.addConfig("user.name", "loopeng-bot");
      await this.git.addConfig("user.email", "loopeng-bot@localhost");
    }
  }

  async writeAndCommit(
    relPath: string,
    content: string,
    message: string,
    author?: CommitAuthor,
  ): Promise<string> {
    const absPath = path.join(this.repoRoot, relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf-8");
    await this.git.add(relPath);
    const commitOpts = author ? { "--author": `${author.name} <${author.email}>` } : undefined;
    const result = await this.git.commit(message, relPath, commitOpts);
    return result.commit;
  }

  async readAtWorkingTree(relPath: string): Promise<string> {
    return readFile(path.join(this.repoRoot, relPath), "utf-8");
  }

  async readAtVersion(relPath: string, sha: string): Promise<string> {
    return this.git.show([`${sha}:${relPath}`]);
  }

  async diff(relPath: string, shaA: string, shaB: string): Promise<string> {
    return this.git.diff([shaA, shaB, "--", relPath]);
  }

  async log(relPath: string): Promise<{ sha: string; message: string; date: string; author: string }[]> {
    const log = await this.git.log({ file: relPath });
    return log.all.map((entry) => ({
      sha: entry.hash,
      message: entry.message,
      date: entry.date,
      author: entry.author_name,
    }));
  }
}
