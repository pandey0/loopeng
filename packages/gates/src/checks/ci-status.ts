import { simpleGit } from "simple-git";
import { registerGate } from "../registry.js";
import type { GateCheck, GateContext, GateOutcome } from "../types.js";

// Skips (not fails) when GITHUB_TOKEN/GITHUB_REPO aren't configured — same
// opt-in pattern as GithubConnector. Real when a repo pushes to GitHub and
// wires Actions; a no-op elsewhere rather than fake-passing everyone.
export const ciStatusGate: GateCheck = {
  key: "ci_status",
  name: "CI checks",

  appliesTo(): boolean {
    return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
  },

  async run(ctx: GateContext): Promise<GateOutcome> {
    const token = process.env.GITHUB_TOKEN!;
    const repo = process.env.GITHUB_REPO!;
    const git = simpleGit(ctx.worktreePath);
    const sha = (await git.revparse(["HEAD"])).trim();

    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/check-runs`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      return { status: "failed", detail: { reason: `GitHub API error ${res.status}`, sha } };
    }
    const body = (await res.json()) as { check_runs: { status: string; conclusion: string | null }[] };
    if (body.check_runs.length === 0) {
      return { status: "skipped", detail: { reason: "no check runs found for this commit yet", sha } };
    }
    const allComplete = body.check_runs.every((c) => c.status === "completed");
    const allSuccess = body.check_runs.every((c) => c.conclusion === "success" || c.conclusion === "neutral");

    if (!allComplete) return { status: "failed", detail: { reason: "checks still running", sha } };
    return { status: allSuccess ? "passed" : "failed", detail: { sha, checkRuns: body.check_runs } };
  },
};

registerGate(ciStatusGate);
