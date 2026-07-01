import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execIn } from "../exec.js";
import { registerGate } from "../registry.js";
import type { GateCheck, GateContext, GateOutcome } from "../types.js";

async function hasTestScript(worktreePath: string): Promise<boolean> {
  const pkgPath = path.join(worktreePath, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    return typeof pkg.scripts?.test === "string";
  } catch {
    return false;
  }
}

export const testRunnerGate: GateCheck = {
  key: "tests_ci",
  name: "Tests pass + CI green",

  async appliesTo(ctx: GateContext): Promise<boolean> {
    return hasTestScript(ctx.worktreePath);
  },

  async run(ctx: GateContext): Promise<GateOutcome> {
    if (!existsSync(path.join(ctx.worktreePath, "node_modules"))) {
      const install = await execIn(ctx.worktreePath, "pnpm", ["install", "--prefer-offline"], 5 * 60 * 1000);
      if (install.code !== 0) {
        return { status: "failed", detail: { step: "install", code: install.code, stderr: install.stderr.slice(-2000) } };
      }
    }

    const test = await execIn(ctx.worktreePath, "pnpm", ["test"], 5 * 60 * 1000);
    if (test.timedOut) {
      return { status: "failed", detail: { step: "test", reason: "timed out" } };
    }
    // turbo prints this warning to stderr (not stdout) when no package
    // implements the "test" script yet — exit 0 but nothing actually ran,
    // so don't count it as a real pass.
    if (test.code === 0 && /No tasks were executed/i.test(test.stdout + test.stderr)) {
      return { status: "skipped", detail: { reason: "no test tasks defined in any workspace package yet" } };
    }
    return {
      status: test.code === 0 ? "passed" : "failed",
      detail: { code: test.code, stdoutTail: test.stdout.slice(-2000), stderrTail: test.stderr.slice(-2000) },
    };
  },
};

registerGate(testRunnerGate);
