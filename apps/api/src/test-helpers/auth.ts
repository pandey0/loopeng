import { createApiKey, type ActorType } from "@loopeng/db";

// Mints a real, DB-verified api_keys row and returns the header a test
// fastify.inject() call needs to authenticate as that actor -- exercising
// the exact same requireActor code path a production caller goes through,
// not a mocked/bypassed one.
export async function authHeaderFor(actorType: ActorType, actorId?: string): Promise<{ Authorization: string }> {
  const { token } = await createApiKey({ actorType, actorId, label: `test-${actorType}` });
  return { Authorization: `Bearer ${token}` };
}
