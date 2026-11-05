import { createHash } from "node:crypto";

export function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}
