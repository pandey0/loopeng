import { MAX_INTAKE_IMAGE_SIZE_BYTES } from "@loopeng/shared";
import { describe, expect, it } from "vitest";
import { validateIntakeImageFile } from "./intakeImages";

describe("validateIntakeImageFile", () => {
  it("accepts allowed mime types under the size cap", () => {
    for (const type of ["image/png", "image/jpeg", "image/jpg", "image/webp"]) {
      expect(validateIntakeImageFile({ name: "a.png", type, size: 1024 })).toEqual({ ok: true });
    }
  });

  it("rejects a disallowed mime type", () => {
    const result = validateIntakeImageFile({ name: "bad-file.gif", type: "image/gif", size: 1024 });
    expect(result).toEqual({ ok: false, reason: "bad-file.gif: unsupported type" });
  });

  it("rejects a file over the size cap", () => {
    const result = validateIntakeImageFile({
      name: "huge.png",
      type: "image/png",
      size: MAX_INTAKE_IMAGE_SIZE_BYTES + 1,
    });
    expect(result).toEqual({ ok: false, reason: "huge.png: exceeds 5MB" });
  });

  it("accepts a file exactly at the size cap", () => {
    expect(
      validateIntakeImageFile({ name: "exact.png", type: "image/png", size: MAX_INTAKE_IMAGE_SIZE_BYTES }),
    ).toEqual({ ok: true });
  });
});
