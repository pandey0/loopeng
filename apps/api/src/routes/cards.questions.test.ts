import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { boards, cardQuestions, cards, db, pool } from "@loopeng/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authPlugin } from "../plugins/auth.js";
import { authHeaderFor } from "../test-helpers/auth.js";
import { cardRoutes } from "./cards.js";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

describe("POST /cards/:id/questions/:questionId/answer", () => {
  let app: FastifyInstance;
  let boardId: string;
  let authHeader: { Authorization: string };

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(authPlugin);
    await app.register(cardRoutes);

    authHeader = await authHeaderFor("user");

    const [board] = await db.insert(boards).values({ name: "card-questions test board" }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    boardId = board.id;
  });

  afterAll(async () => {
    await db.delete(boards).where(eq(boards.id, boardId));
    await app.close();
    await pool.end();
  });

  async function makeBlockedCardWithQuestion(question = "which env should this deploy to?") {
    const [card] = await db
      .insert(cards)
      .values({ boardId, title: "blocked card", state: "blocked" })
      .returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");

    const [q] = await db
      .insert(cardQuestions)
      .values({ cardId: card.id, roleName: "implementer", question, status: "open", routedTo: "product_owner" })
      .returning();
    if (!q) throw new Error("card_questions insert returned no row");

    return { cardId: card.id, questionId: q.id };
  }

  it("answers an open question and auto-resumes the card to ready", async () => {
    const { cardId, questionId } = await makeBlockedCardWithQuestion();

    const response = await app.inject({
      method: "POST",
      url: `/cards/${cardId}/questions/${questionId}/answer`,
      headers: authHeader,
      payload: { answer: "staging", answeredBy: "product-owner@example.com" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; answer: string; answeredBy: string; answeredAt: string | null };
    expect(body.status).toBe("answered");
    expect(body.answer).toBe("staging");
    expect(body.answeredBy).toBe("product-owner@example.com");
    expect(body.answeredAt).not.toBeNull();

    const [card] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(card?.state).toBe("ready");
  });

  it("rejects answering an already-answered question", async () => {
    const { cardId, questionId } = await makeBlockedCardWithQuestion();

    const first = await app.inject({
      method: "POST",
      url: `/cards/${cardId}/questions/${questionId}/answer`,
      headers: authHeader,
      payload: { answer: "staging" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/cards/${cardId}/questions/${questionId}/answer`,
      headers: authHeader,
      payload: { answer: "prod" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("404s for a question that does not belong to the given card", async () => {
    const { questionId } = await makeBlockedCardWithQuestion();
    const { cardId: otherCardId } = await makeBlockedCardWithQuestion("unrelated question");

    const response = await app.inject({
      method: "POST",
      url: `/cards/${otherCardId}/questions/${questionId}/answer`,
      headers: authHeader,
      payload: { answer: "staging" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("includes questions in the card detail response", async () => {
    const { cardId, questionId } = await makeBlockedCardWithQuestion("what auth provider?");

    const response = await app.inject({ method: "GET", url: `/cards/${cardId}/detail` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { questions: { id: string; question: string; status: string }[] };
    expect(body.questions.find((q) => q.id === questionId)).toMatchObject({
      question: "what auth provider?",
      status: "open",
    });
  });
});
