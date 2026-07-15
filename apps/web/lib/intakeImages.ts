import { ALLOWED_INTAKE_IMAGE_MIME_TYPES, MAX_INTAKE_IMAGE_SIZE_BYTES } from "@loopeng/shared";

export function formatMaxIntakeImageSize(): string {
  return `${Math.round(MAX_INTAKE_IMAGE_SIZE_BYTES / (1024 * 1024))}MB`;
}

// Mirrors IntakeImageSchema (packages/shared/src/schemas.ts) client-side, so
// obviously-bad files get rejected before a base64 round trip to the API --
// the server re-validates independently, this is fast-feedback only.
export function validateIntakeImageFile(file: { name: string; type: string; size: number }):
  | { ok: true }
  | { ok: false; reason: string } {
  if (!(ALLOWED_INTAKE_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, reason: `${file.name}: unsupported type` };
  }
  if (file.size > MAX_INTAKE_IMAGE_SIZE_BYTES) {
    return { ok: false, reason: `${file.name}: exceeds ${formatMaxIntakeImageSize()}` };
  }
  return { ok: true };
}
