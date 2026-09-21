import { createHash } from "node:crypto";

export function sessionFingerprint(input: {
  system?: unknown;
  tools?: unknown;
  messages?: unknown;
}): string {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const firstUser = messages.find(
    (message) => (message as { role?: string } | null)?.role === "user",
  );
  const payload = JSON.stringify({
    system: input.system ?? null,
    tools: input.tools ?? null,
    firstUser: firstUser ?? null,
  });
  return createHash("sha1").update(payload).digest("hex").slice(0, 16);
}
