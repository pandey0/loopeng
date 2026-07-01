import { spawn } from "node:child_process";

export interface RunClaudeCliInput {
  cwd: string;
  prompt: string;
  appendSystemPrompt?: string;
  permissionMode?: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
  allowedTools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxBudgetUsd?: number;
}

export interface ClaudeCliResult {
  resultText: string;
  isError: boolean;
  sessionId?: string;
  totalCostUsd?: number;
  raw: unknown;
}

// Shells out to the Claude Code CLI in headless/print mode rather than
// building a custom LLM-calling agent loop — the CLI already is a fully
// capable coding agent (read/edit/bash/tests). The orchestrator only owns
// process lifecycle + worktree cwd; the CLI owns the actual coding work.
export function runClaudeCli(input: RunClaudeCliInput): Promise<ClaudeCliResult> {
  const args = ["-p", input.prompt, "--output-format", "json"];
  args.push("--permission-mode", input.permissionMode ?? "acceptEdits");
  if (input.model) args.push("--model", input.model);
  if (input.allowedTools?.length) args.push("--allowedTools", input.allowedTools.join(","));
  if (input.disallowedTools?.length) args.push("--disallowedTools", input.disallowedTools.join(","));
  if (input.maxBudgetUsd) args.push("--max-budget-usd", String(input.maxBudgetUsd));
  if (input.appendSystemPrompt) args.push("--append-system-prompt", input.appendSystemPrompt);

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: input.cwd, env: process.env });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", (err) => reject(new Error(`failed to spawn claude cli: ${err.message}`)));

    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`claude cli exited ${code}: ${stderr || "no output"}`));
        return;
      }
      try {
        const raw = JSON.parse(stdout);
        resolve({
          resultText: typeof raw.result === "string" ? raw.result : stdout,
          isError: Boolean(raw.is_error) || code !== 0,
          sessionId: raw.session_id,
          totalCostUsd: raw.total_cost_usd,
          raw,
        });
      } catch {
        // non-JSON output (e.g. crash before first turn) — surface raw text, mark as error
        resolve({ resultText: stdout || stderr, isError: true, raw: { stdout, stderr, code } });
      }
    });
  });
}
