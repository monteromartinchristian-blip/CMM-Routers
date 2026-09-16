import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sharedConfigSchema, type SharedConfig } from "../config/schema.js";

const DEFAULT_SHARED_CONFIG = {
  mode: "standalone",
  host: "127.0.0.1",
} as const;

export class RouterAdminConfigStore {
  private readonly path: string;

  constructor(private readonly configDir = resolve(process.cwd(), "config")) {
    this.path = resolve(configDir, "shared.json");
  }

  read(): SharedConfig {
    if (!existsSync(this.path)) return sharedConfigSchema.parse(DEFAULT_SHARED_CONFIG);
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    return sharedConfigSchema.parse(raw);
  }

  async write(config: SharedConfig): Promise<void> {
    const parsed = sharedConfigSchema.parse(config);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    try {
      await rm(temporary, { force: true });
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async update(mutate: (current: SharedConfig) => SharedConfig): Promise<SharedConfig> {
    const next = sharedConfigSchema.parse(mutate(this.read()));
    await this.write(next);
    return next;
  }
}
