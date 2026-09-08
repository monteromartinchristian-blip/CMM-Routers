import { execSync } from "node:child_process";

export function getMachineId(): string {
  const envId = process.env.CMM_MACHINE_ID;
  if (envId) {
    return sanitizeMachineId(envId);
  }

  try {
    const computerName = execSync("scutil --get ComputerName", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return sanitizeMachineId(computerName);
  } catch {
    return "unknown-machine";
  }
}

function sanitizeMachineId(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
