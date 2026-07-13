import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createApiKey, ensureStaticApiKey, revokeApiKey, verifyApiKey } from "./api-keys.js";
import { apiKeys } from "./schema.js";
import { db, pool } from "./client.js";

const createdKeyIds: string[] = [];

afterAll(async () => {
  for (const id of createdKeyIds.splice(0)) {
    await db.delete(apiKeys).where(eq(apiKeys.id, id));
  }
  await pool.end();
});

describe("createApiKey / verifyApiKey", () => {
  it("verifies a freshly-minted token back to its actor identity", async () => {
    const { id, token } = await createApiKey({ actorType: "agent", actorId: "00000000-0000-0000-0000-0000000000aa", label: "test" });
    createdKeyIds.push(id);

    const actor = await verifyApiKey(token);
    expect(actor).toMatchObject({ type: "agent", id: "00000000-0000-0000-0000-0000000000aa", apiKeyId: id });
  });

  it("rejects a token that was never issued", async () => {
    expect(await verifyApiKey("lk_this-was-never-minted")).toBeNull();
  });

  it("rejects a revoked token", async () => {
    const { id, token } = await createApiKey({ actorType: "user", label: "test-revoked" });
    createdKeyIds.push(id);

    await revokeApiKey(id);

    expect(await verifyApiKey(token)).toBeNull();
  });

  it("never lets a caller choose its own actorType by guessing another key's token", async () => {
    // Two keys scoped to two different agent runs -- verifying one must
    // never resolve to the other's identity, which is the whole point of
    // deriving actorType/actorId server-side instead of trusting the caller.
    const first = await createApiKey({ actorType: "agent", actorId: "00000000-0000-0000-0000-0000000000bb", label: "agent-a" });
    const second = await createApiKey({ actorType: "agent", actorId: "00000000-0000-0000-0000-0000000000cc", label: "agent-b" });
    createdKeyIds.push(first.id, second.id);

    expect((await verifyApiKey(first.token))?.id).toBe("00000000-0000-0000-0000-0000000000bb");
    expect((await verifyApiKey(second.token))?.id).toBe("00000000-0000-0000-0000-0000000000cc");
  });
});

describe("ensureStaticApiKey", () => {
  it("is idempotent and un-revokes a previously-revoked static token", async () => {
    // Not a real credential -- a fresh random value stands in for whatever
    // WEB_API_KEY is at boot, only fixed within this test to prove
    // re-registering the same value is idempotent.
    const token = `test-static-token-${randomUUID()}`;
    await ensureStaticApiKey(token, { actorType: "user", label: "web-ui-test" });
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.label, "web-ui-test"));
    if (!row) throw new Error("expected api_keys row");
    createdKeyIds.push(row.id);

    let actor = await verifyApiKey(token);
    expect(actor).toMatchObject({ type: "user", id: null });

    await revokeApiKey(row.id);
    expect(await verifyApiKey(token)).toBeNull();

    // Re-registering (e.g. the API restarting) un-revokes it rather than
    // erroring or creating a duplicate row.
    await ensureStaticApiKey(token, { actorType: "user", label: "web-ui-test" });
    actor = await verifyApiKey(token);
    expect(actor).toMatchObject({ type: "user", id: null });
  });
});
