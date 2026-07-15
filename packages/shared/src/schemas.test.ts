import { describe, expect, it } from "vitest";
import {
  CardCreateInputSchema,
  CardSchema,
  CardUpdateInputSchema,
  IntakeInputSchema,
  MAX_INTAKE_IMAGE_SIZE_BYTES,
} from "./schemas";

describe("CardSchema", () => {
  it("defaults acceptanceCriteria to an empty array", () => {
    const card = CardSchema.parse({
      id: "11111111-1111-1111-1111-111111111111",
      boardId: "22222222-2222-2222-2222-222222222222",
      title: "Some card",
      description: null,
      assigneeId: null,
      agentRoleId: null,
      worktreeId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(card.acceptanceCriteria).toEqual([]);
  });

  it("accepts a list of acceptance criteria strings", () => {
    const card = CardSchema.parse({
      id: "11111111-1111-1111-1111-111111111111",
      boardId: "22222222-2222-2222-2222-222222222222",
      title: "Some card",
      description: null,
      assigneeId: null,
      agentRoleId: null,
      worktreeId: null,
      acceptanceCriteria: ["shows the title", "shows acceptance criteria"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(card.acceptanceCriteria).toEqual(["shows the title", "shows acceptance criteria"]);
  });
});

describe("CardCreateInputSchema", () => {
  it("accepts acceptanceCriteria on create", () => {
    const input = CardCreateInputSchema.parse({
      boardId: "22222222-2222-2222-2222-222222222222",
      title: "Some card",
      acceptanceCriteria: ["criterion 1"],
      specDocId: "33333333-3333-3333-3333-333333333333",
    });
    expect(input.acceptanceCriteria).toEqual(["criterion 1"]);
  });

  it("rejects card creation with no spec doc linked", () => {
    expect(() =>
      CardCreateInputSchema.parse({
        boardId: "22222222-2222-2222-2222-222222222222",
        title: "Some card",
      }),
    ).toThrow();
  });
});

describe("IntakeInputSchema", () => {
  const boardId = "22222222-2222-2222-2222-222222222222";
  const base64Of = (sizeBytes: number) => Buffer.alloc(sizeBytes, "a").toString("base64");

  it("accepts a requestText-only payload with no images field", () => {
    const input = IntakeInputSchema.parse({ boardId, requestText: "do the thing" });
    expect(input.images).toEqual([]);
  });

  it("accepts a payload with valid image attachments", () => {
    const data = base64Of(1024);
    const input = IntakeInputSchema.parse({
      boardId,
      requestText: "see attached screenshot",
      images: [{ mimeType: "image/png", sizeBytes: 1024, data }],
    });
    expect(input.images).toHaveLength(1);
    expect(input.images[0]?.mimeType).toBe("image/png");
  });

  it("accepts all allowlisted mime types", () => {
    for (const mimeType of ["image/png", "image/jpeg", "image/jpg", "image/webp"] as const) {
      const input = IntakeInputSchema.parse({
        boardId,
        requestText: "x",
        images: [{ mimeType, sizeBytes: 10, data: base64Of(10) }],
      });
      expect(input.images[0]?.mimeType).toBe(mimeType);
    }
  });

  it("rejects a mime type outside the allowlist", () => {
    expect(() =>
      IntakeInputSchema.parse({
        boardId,
        requestText: "x",
        images: [{ mimeType: "image/gif", sizeBytes: 10, data: base64Of(10) }],
      }),
    ).toThrow();
  });

  it("rejects an image over the declared size cap", () => {
    expect(() =>
      IntakeInputSchema.parse({
        boardId,
        requestText: "x",
        images: [
          {
            mimeType: "image/png",
            sizeBytes: MAX_INTAKE_IMAGE_SIZE_BYTES + 1,
            data: base64Of(10),
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects when the actual base64 data exceeds the size cap, even if sizeBytes lies under it", () => {
    expect(() =>
      IntakeInputSchema.parse({
        boardId,
        requestText: "x",
        images: [
          {
            mimeType: "image/png",
            sizeBytes: 10,
            data: base64Of(MAX_INTAKE_IMAGE_SIZE_BYTES + 1),
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects an empty data string", () => {
    expect(() =>
      IntakeInputSchema.parse({
        boardId,
        requestText: "x",
        images: [{ mimeType: "image/png", sizeBytes: 10, data: "" }],
      }),
    ).toThrow();
  });
});

describe("CardUpdateInputSchema", () => {
  it("accepts a partial update with only acceptanceCriteria", () => {
    const input = CardUpdateInputSchema.parse({ acceptanceCriteria: ["a", "b"] });
    expect(input).toEqual({ acceptanceCriteria: ["a", "b"] });
  });

  it("accepts a partial update with only title", () => {
    const input = CardUpdateInputSchema.parse({ title: "Renamed" });
    expect(input).toEqual({ title: "Renamed" });
  });

  it("rejects an empty update", () => {
    expect(() => CardUpdateInputSchema.parse({})).toThrow();
  });

  it("rejects an unknown card type", () => {
    expect(() => CardUpdateInputSchema.parse({ cardType: "not-a-real-type" })).toThrow();
  });
});
