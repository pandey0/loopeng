import { eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { gateDefinitions, gateResults } from "@loopeng/db";
import { loadConnectorRegistry } from "@loopeng/connectors";
import { allGates } from "./registry.js";
import type { CardRow, GateOutcome } from "./types.js";
import "./checks/test-runner.js";
import "./checks/security-scan.js";
import "./checks/doc-linked.js";
import "./checks/adr-required.js";
import "./checks/ci-status.js";

export interface GatePipelineResult {
  allPassed: boolean;
  results: { key: string; name: string; blocking: boolean; outcome: GateOutcome }[];
}

// peer_review and design_review (Phase 2, orchestrator-owned) and deploy_live
// (Phase 4, deploy-engine-owned) are gate_definitions rows but not run from
// here — each phase owns writing its own gate_results.
const PIPELINE_OWNED_KEYS_EXCLUDED = ["peer_review", "design_review", "deploy_live"];

export async function runGatePipeline(card: CardRow, worktreePath: string, baseCommitSha: string): Promise<GatePipelineResult> {
  const definitions = await db.select().from(gateDefinitions).where(eq(gateDefinitions.enabled, true));
  const connectors = await loadConnectorRegistry();
  const checksByKey = new Map(allGates().map((g) => [g.key, g]));

  const results: GatePipelineResult["results"] = [];
  let allPassed = true;

  for (const def of definitions) {
    if (PIPELINE_OWNED_KEYS_EXCLUDED.includes(def.key)) continue;
    const check = checksByKey.get(def.key);
    if (!check) {
      console.warn(`[gates] no registered check for gate_definitions.key="${def.key}", skipping`);
      continue;
    }

    const ctx = { card, worktreePath, baseCommitSha, connectors, config: (def.config as Record<string, unknown>) ?? {} };
    const applies = await check.appliesTo(ctx);
    const outcome: GateOutcome = applies
      ? await check.run(ctx)
      : { status: "skipped", detail: { reason: "appliesTo() returned false" } };

    await db.insert(gateResults).values({
      cardId: card.id,
      gateDefinitionId: def.id,
      status: outcome.status,
      detail: outcome.detail,
    });

    results.push({ key: def.key, name: def.name, blocking: def.blocking, outcome });
    if (def.blocking && outcome.status === "failed") allPassed = false;
  }

  return { allPassed, results };
}

export * from "./types.js";
export * from "./registry.js";
