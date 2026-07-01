import { eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { agentRoles } from "@loopeng/db";
import type { Card } from "@loopeng/shared";

export async function pickImplementerRole(card: Card) {
  const roles = await db.select().from(agentRoles).where(eq(agentRoles.enabled, true));
  const byCapability = roles.find((r) => r.capabilities.includes(card.cardType));
  return byCapability ?? roles.find((r) => r.name === "implementer") ?? null;
}
