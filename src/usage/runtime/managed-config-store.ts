import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  loadUsageRuntimeConfig,
  parseUsageRuntimeConfig,
  type LoadedUsageRuntimeConfig,
} from "./config.js";

export class ManagedConfigStore {
  private readonly path: string;

  constructor(private readonly configDir = resolve(process.cwd(), "config")) {
    this.path = resolve(configDir, "usage.json");
  }

  async read(): Promise<LoadedUsageRuntimeConfig> {
    return loadUsageRuntimeConfig(this.configDir);
  }

  async write(value: LoadedUsageRuntimeConfig): Promise<void> {
    const parsed = parseUsageRuntimeConfig(value);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }

  async update(
    mutate: (current: LoadedUsageRuntimeConfig) => LoadedUsageRuntimeConfig,
  ): Promise<LoadedUsageRuntimeConfig> {
    const next = parseUsageRuntimeConfig(mutate(await this.read()));
    await this.write(next);
    return next;
  }
}
