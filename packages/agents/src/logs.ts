import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function logsDir(): string {
  return process.env.AGENT_LOGS_PATH ?? path.join(process.cwd(), "data", "agent-logs");
}

export async function writeAgentLog(runId: string, payload: unknown): Promise<string> {
  const dir = logsDir();
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${runId}.json`);
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
  return filePath;
}
