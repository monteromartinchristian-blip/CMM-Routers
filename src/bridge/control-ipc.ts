import { createServer, connect, type Server, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Router-facing bridge-control IPC.
 *
 * This is NOT the MCP protocol. MCP stdio is provider-facing (the external
 * bridge process speaks it to Claude/Antigravity). This control channel is how
 * that external process parks a Qoder-owned tool request with the Router and
 * later receives the already-produced result. The bridge performs transport
 * only; it never executes the requested side effect.
 *
 * Security model:
 *  - Unix domain socket inside a per-session directory (mode 0700).
 *  - Socket file mode 0600 (current user only).
 *  - Per-session unguessable token required on the first frame.
 *  - No TCP/Internet binding; Unix socket only, never a wildcard-address listener.
 *  - Directory + socket removed on close (session death).
 *  - Arguments and results are never logged.
 */

/** A parked request as delivered to the Router. */
export interface BridgeToolRequest {
  id: string;
  name: string;
  input: unknown;
}

export interface BridgeControlServerOptions {
  /** Invoked for each authenticated tool request from the bridge process. */
  onToolCall: (request: BridgeToolRequest) => void;
  /** Optional fixed token (tests). Defaults to a fresh 32-byte random token. */
  token?: string;
}

interface PendingFrame {
  socket: Socket;
  id: string;
}

const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Server side of the control channel: created by the Router, connected to by
 * the external MCP bridge process.
 */
export class BridgeControlServer {
  private readonly server: Server;
  private readonly dir: string;
  readonly socketPath: string;
  readonly token: string;
  private readonly pending = new Map<string, PendingFrame>();
  private closed = false;

  private constructor(
    server: Server,
    dir: string,
    socketPath: string,
    token: string,
    onToolCall: (request: BridgeToolRequest) => void,
  ) {
    this.server = server;
    this.dir = dir;
    this.socketPath = socketPath;
    this.token = token;
    this.server.on("connection", (socket) => this.handleConnection(socket, onToolCall));
  }

  static async listen(options: BridgeControlServerOptions): Promise<BridgeControlServer> {
    const dir = mkdtempSync(join(tmpdir(), "cmm-bridge-"));
    chmodSync(dir, 0o700);
    const socketPath = join(dir, "bridge.sock");
    const token = options.token ?? randomBytes(32).toString("hex");
    const server = createServer();
    const instance = new BridgeControlServer(server, dir, socketPath, token, options.onToolCall);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);
    return instance;
  }

  private handleConnection(
    socket: Socket,
    onToolCall: (request: BridgeToolRequest) => void,
  ): void {
    let buffer = "";
    let authenticated = false;
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_CONTROL_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (!isRecord(frame)) {
          socket.destroy();
          return;
        }
        if (!authenticated) {
          if (frame.token !== this.token) {
            socket.destroy();
            return;
          }
          authenticated = true;
        }
        const id = typeof frame.id === "string" ? frame.id : undefined;
        const name = typeof frame.name === "string" ? frame.name : undefined;
        if (id === undefined || name === undefined) {
          socket.destroy();
          return;
        }
        if (this.pending.has(id)) {
          socket.destroy();
          return;
        }
        this.pending.set(id, { socket, id });
        onToolCall({ id, name, input: frame.input ?? {} });
      }
    });
    socket.on("error", () => {
      // A dead bridge socket releases its parked frames so a later resolve
      // cannot write into a destroyed stream.
      for (const [id, frame] of this.pending) {
        if (frame.socket === socket) this.pending.delete(id);
      }
    });
  }

  /** Release a parked request with Qoder's already-produced result text. */
  resolve(id: string, text: string): boolean {
    const frame = this.pending.get(id);
    if (!frame) return false;
    this.pending.delete(id);
    if (!frame.socket.destroyed) {
      frame.socket.write(`${JSON.stringify({ id, result: text })}\n`);
    }
    return true;
  }

  /** Release a parked request with a transport-level failure. */
  reject(id: string, message: string): boolean {
    const frame = this.pending.get(id);
    if (!frame) return false;
    this.pending.delete(id);
    if (!frame.socket.destroyed) {
      frame.socket.write(`${JSON.stringify({ id, error: message })}\n`);
    }
    return true;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [, frame] of this.pending) {
      if (!frame.socket.destroyed) frame.socket.destroy();
    }
    this.pending.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * Client side used by the external bridge process. Sends one tool request and
 * awaits the Router's already-produced result.
 */
export class BridgeControlClient {
  constructor(
    private readonly socketPath: string,
    private readonly token: string,
  ) {}

  request(
    id: string,
    name: string,
    input: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = connect(this.socketPath);
      let buffer = "";
      let settled = false;
      const cleanup = (): void => {
        socket.removeAllListeners();
        socket.destroy();
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      if (options.signal) {
        if (options.signal.aborted) {
          fail(new Error("bridge control request aborted"));
          return;
        }
        options.signal.addEventListener("abort", () => fail(new Error("bridge control request aborted")), {
          once: true,
        });
      }
      socket.setEncoding("utf-8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ token: this.token, id, name, input })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let frame: unknown;
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          if (!isRecord(frame) || frame.id !== id) continue;
          if (typeof frame.error === "string") {
            fail(new Error(frame.error));
            return;
          }
          settled = true;
          cleanup();
          resolve(typeof frame.result === "string" ? frame.result : "");
          return;
        }
      });
      socket.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
      socket.on("close", () => fail(new Error("bridge control socket closed")));
    });
  }
}
