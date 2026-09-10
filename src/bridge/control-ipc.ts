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
  /**
   * Maximum simultaneously parked tool requests. A provider-side MCP server
   * must not be able to enqueue past the upstream broker's bound merely by
   * waiting one layer earlier.
   */
  maxPending?: number;
  /** Lifetime of one parked request whose result never arrives. */
  pendingTtlMs?: number;
  /**
   * Invoked when a bridge connection that still owned parked frames drops.
   * Lets the adapter fail closed immediately instead of waiting for the TTL.
   */
  onDisconnect?: (() => void) | undefined;
}

interface PendingFrame {
  socket: Socket;
  id: string;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;

/** Default per-session bound on parked control frames. */
export const BRIDGE_CONTROL_MAX_PENDING = 16;
/** Default lifetime of one parked control frame. */
export const BRIDGE_CONTROL_PENDING_TTL_MS = 120_000;

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
  readonly maxPending: number;
  private readonly pendingTtlMs: number;
  private readonly pending = new Map<string, PendingFrame>();
  private closed = false;

  constructor(
    server: Server,
    dir: string,
    socketPath: string,
    token: string,
    onToolCall: (request: BridgeToolRequest) => void,
    maxPending: number,
    pendingTtlMs: number,
    onDisconnect?: (() => void) | undefined,
  ) {
    this.server = server;
    this.dir = dir;
    this.socketPath = socketPath;
    this.token = token;
    this.maxPending = maxPending;
    this.pendingTtlMs = pendingTtlMs;
    this.server.on("connection", (socket) =>
      this.handleConnection(socket, onToolCall, onDisconnect),
    );
  }

  static async listen(options: BridgeControlServerOptions): Promise<BridgeControlServer> {
    const dir = mkdtempSync(join(tmpdir(), "cmm-bridge-"));
    chmodSync(dir, 0o700);
    const socketPath = join(dir, "bridge.sock");
    const token = options.token ?? randomBytes(32).toString("hex");
    const maxPending = options.maxPending ?? BRIDGE_CONTROL_MAX_PENDING;
    const pendingTtlMs = options.pendingTtlMs ?? BRIDGE_CONTROL_PENDING_TTL_MS;
    const server = createServer();
    const instance = new BridgeControlServer(
      server,
      dir,
      socketPath,
      token,
      options.onToolCall,
      maxPending,
      pendingTtlMs,
      options.onDisconnect,
    );
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
    onDisconnect?: (() => void) | undefined,
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
        if (this.pending.size >= this.maxPending) {
          // Bounded pending state: refuse deterministically. The caller sees a
          // transport error and the frame is never surfaced to the Router.
          if (!socket.destroyed) {
            socket.write(
              `${JSON.stringify({ id, error: "bridge control pending state bounded" })}\n`,
            );
          }
          continue;
        }
        const timer = setTimeout(() => {
          this.expire(id);
        }, this.pendingTtlMs);
        if (typeof timer.unref === "function") timer.unref();
        this.pending.set(id, { socket, id, timer });
        onToolCall({ id, name, input: frame.input ?? {} });
      }
    });
    const releaseSocketFrames = (): void => {
      let owned = false;
      for (const [id, frame] of this.pending) {
        if (frame.socket === socket) {
          clearTimeout(frame.timer);
          this.pending.delete(id);
          owned = true;
        }
      }
      // A bridge that dies while the provider waits must fail the parked
      // session closed immediately, not at TTL.
      if (owned) onDisconnect?.();
    };
    socket.on("error", releaseSocketFrames);
    socket.on("close", releaseSocketFrames);
  }

  /** Expire one parked frame whose result never arrived. */
  private expire(id: string): void {
    const frame = this.pending.get(id);
    if (!frame) return;
    this.pending.delete(id);
    if (!frame.socket.destroyed) {
      frame.socket.write(`${JSON.stringify({ id, error: "bridge control request expired" })}\n`);
    }
  }

  /** Release a parked request with Qoder's already-produced result text. */
  resolve(id: string, text: string): boolean {
    const frame = this.pending.get(id);
    if (!frame) return false;
    clearTimeout(frame.timer);
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
    clearTimeout(frame.timer);
    this.pending.delete(id);
    if (!frame.socket.destroyed) {
      frame.socket.write(`${JSON.stringify({ id, error: message })}\n`);
    }
    return true;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  atCapacity(): boolean {
    return this.pending.size >= this.maxPending;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [, frame] of this.pending) {
      clearTimeout(frame.timer);
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
