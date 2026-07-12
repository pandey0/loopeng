import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { apiKeys } from "./schema.js";

export type ActorType = "user" | "agent" | "automation";

export interface VerifiedActor {
  type: ActorType;
  id: string | null;
  apiKeyId: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Raw tokens are never persisted, only their hash -- verifyApiKey below is
// the only thing that can turn a bearer token back into an actor identity,
// and it does so by re-hashing and looking up, never by storing/decrypting.
export async function createApiKey(input: {
  actorType: ActorType;
  actorId?: string | null;
  label: string;
}): Promise<{ id: string; token: string }> {
  const token = `lk_${randomBytes(24).toString("base64url")}`;
  const [row] = await db
    .insert(apiKeys)
    .values({ tokenHash: hashToken(token), actorType: input.actorType, actorId: input.actorId ?? null, label: input.label })
    .returning({ id: apiKeys.id });
  if (!row) throw new Error("failed to insert api_keys row");
  return { id: row.id, token };
}

export async function revokeApiKey(id: string): Promise<void> {
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
}

export async function verifyApiKey(token: string): Promise<VerifiedActor | null> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.tokenHash, hashToken(token)));
  if (!row || row.revokedAt) return null;
  return { type: row.actorType as ActorType, id: row.actorId, apiKeyId: row.id };
}

// Idempotently (re-)registers a fixed, long-lived token as a live api_keys
// row -- used at API boot to turn the WEB_API_KEY env var into a verifiable
// "human" credential without a login system: the web app is the only
// consumer that's ever handed this token (never an agent worktree's env),
// so its presence on a request is what distinguishes a browser-originated
// call from anything else hitting the API. Re-running this (every boot) on
// an already-registered token is a no-op except for un-revoking it, so
// rotating WEB_API_KEY in env naturally retires the old token's row (it's
// simply never looked up again) without needing a migration.
export async function ensureStaticApiKey(token: string, input: { actorType: ActorType; label: string }): Promise<void> {
  const tokenHash = hashToken(token);
  await db
    .insert(apiKeys)
    .values({ tokenHash, actorType: input.actorType, actorId: null, label: input.label })
    .onConflictDoUpdate({
      target: apiKeys.tokenHash,
      set: { revokedAt: null, label: input.label },
    });
}
