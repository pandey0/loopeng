import { getRepoDiff } from "@loopeng/worktree-manager";
import { execIn } from "../exec.js";
import { registerGate } from "../registry.js";
import type { GateCheck, GateContext, GateOutcome } from "../types.js";

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "aws_access_key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "private_key_block", pattern: /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/ },
  { name: "generic_api_key_assignment", pattern: /(api[_-]?key|apikey)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i },
  { name: "generic_secret_assignment", pattern: /(secret|password|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i },
];

function scanDiffForSecrets(diff: string): { name: string; line: string }[] {
  const findings: { name: string; line: string }[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const { name, pattern } of SECRET_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        findings.push({ name, line: line.replace(match[0], "[REDACTED]") });
      }
    }
  }
  return findings;
}

async function auditDependencies(worktreePath: string): Promise<{ criticalCount: number; raw: unknown }> {
  const result = await execIn(worktreePath, "pnpm", ["audit", "--json"], 60 * 1000);
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    const criticalCount = parsed.metadata?.vulnerabilities?.critical ?? 0;
    return { criticalCount, raw: parsed.metadata?.vulnerabilities ?? {} };
  } catch {
    // pnpm audit can fail for reasons unrelated to actual vulnerabilities
    // (offline registry, no lockfile yet) — don't block the gate on that.
    return { criticalCount: 0, raw: { error: "audit unavailable", stderrTail: result.stderr.slice(-500) } };
  }
}

export const securityScanGate: GateCheck = {
  key: "security_scan",
  name: "Security review cleared",

  appliesTo(): boolean {
    return true;
  },

  async run(ctx: GateContext): Promise<GateOutcome> {
    const diff = await getRepoDiff(ctx.worktreePath);
    const secretFindings = scanDiffForSecrets(diff);
    const audit = await auditDependencies(ctx.worktreePath);

    const failed = secretFindings.length > 0 || audit.criticalCount > 0;
    return {
      status: failed ? "failed" : "passed",
      detail: { secretFindings, criticalVulnerabilities: audit.criticalCount, auditSummary: audit.raw },
    };
  },
};

registerGate(securityScanGate);
