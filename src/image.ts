// Image helpers. Reference images are sent to the platform by https URL only ({url}, at most 10 per
// product); the API does not accept uploaded or base64 image data.

import { createHash } from "node:crypto";

export const MAX_IMAGES = 10;

export const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

/** File extension for downloaded images whose URL has none. */
export const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
