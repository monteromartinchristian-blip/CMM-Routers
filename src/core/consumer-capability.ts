export const CONSUMER_QODER = "qoder";
export const CONSUMER_CMMCHAT = "cmmchat";

export type ConsumerId = typeof CONSUMER_QODER | typeof CONSUMER_CMMCHAT;

export const QODER_TOKEN_ENV = "CMM_QODER_TOKEN";

/**
 * Effective tool gate = consumer policy AND provider capability.
 *
 * CMMChat is intentionally CHAT_ONLY on every provider: it must never
 * implicitly gain shell, filesystem, edit, or arbitrary tool execution.
 * Qoder may use tools only when the resolved provider model reports a proven
 * structured upstream round-trip (CHAT_AND_TOOLS). The provider capability
 * alone never grants tools to an unprivileged consumer, and the consumer
 * alone never grants tools on a CHAT_ONLY provider.
 */
export function effectiveToolCapability(
  consumer: ConsumerId,
  providerCapability: string | undefined,
): "CHAT_AND_TOOLS" | "CHAT_ONLY" {
  if (consumer !== CONSUMER_QODER) return "CHAT_ONLY";
  return providerCapability === "CHAT_AND_TOOLS" ? "CHAT_AND_TOOLS" : "CHAT_ONLY";
}
