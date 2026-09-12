export interface SanitizeTreeResult {
  files: number;
  transformedFiles: number;
  events: Record<string, number>;
}

export interface TreeProof {
  sameFileSet: boolean;
  binaryDifferences: number;
  canonicalTextDifferences: number;
  unexplainedDifferences: string[];
}

export function hashFile(path: string): Promise<string>;

export function listTreeFiles(root: string): Promise<string[]>;

export function sanitizeCandidateTree(
  rawRoot: string,
  candidateRoot: string,
): Promise<SanitizeTreeResult>;

export function proveAllowedDifferences(
  rawRoot: string,
  candidateRoot: string,
): Promise<TreeProof>;
