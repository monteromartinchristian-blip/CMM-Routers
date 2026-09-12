export interface SanitizationEvent {
  rule: string;
  count: number;
}

export interface ScanFinding {
  severity: "BLOCK" | "REVIEW";
  rule: string;
  path: string;
  line: number;
  valueSha256?: string;
}

export const SANITIZATION_POLICY_VERSION: string;

export function isProbablyText(buffer: Uint8Array): boolean;

export function sanitizeText(input: string): {
  text: string;
  events: SanitizationEvent[];
};

export function scanText(path: string, input: string): ScanFinding[];

export function classifySecretLikeLiteral(
  path: string,
  value: string,
  context: string,
): "BLOCK" | "REVIEW_TEST_FIXTURE" | "SAFE_TEST_FIXTURE";
