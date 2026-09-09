import { Duplex } from "node:stream";

/**
 * FakeCodexTransport provides a deterministic, synchronous transport for testing
 * the CodexAppServerClient without spawning real processes or dealing with async
 * timing issues in duplex stream mocks.
 */
export class FakeCodexTransport extends Duplex {
  private outgoingMessages: string[] = [];
  private errorMode = false;

  constructor() {
    super({
      read: () => {},
      write: (chunk: Buffer, encoding: string, callback: () => void) => {
        this.outgoingMessages.push(chunk.toString());
        callback();
      },
    });
  }

  /**
   * Get all messages sent by the client (newline-delimited JSON)
   */
  getOutgoingMessages(): string[] {
    return [...this.outgoingMessages];
  }

  /**
   * Clear the message history
   */
  clearMessages(): void {
    this.outgoingMessages = [];
  }

  /**
   * Simulate receiving a message from the server
   * This triggers the 'data' event synchronously to ensure immediate processing
   */
  receiveMessage(message: object): void {
    if (this.errorMode) return;
    const json = JSON.stringify(message);
    // Emit data event directly instead of using push() to ensure synchronous processing
    this.emit("data", Buffer.from(json + "\n"));
  }

  /**
   * Simulate receiving multiple messages
   */
  receiveMessages(messages: object[]): void {
    for (const msg of messages) {
      this.receiveMessage(msg);
    }
  }

  /**
   * Simulate a malformed JSON message
   */
  receiveMalformedJson(): void {
    if (this.errorMode) return;
    this.push("not valid json\n");
  }

  /**
   * Emit a raw stdout frame exactly as the app-server would write it.
   * Used for malformed-frame tests: routes through the client's line
   * parser rather than around it.
   */
  receiveRawFrame(frame: string): void {
    if (this.errorMode) return;
    this.emit("data", Buffer.from(frame.endsWith("\n") ? frame : `${frame}\n`));
  }

  /**
   * Simulate a stream error
   */
  simulateError(error: Error): void {
    this.emit("error", error);
  }

  /**
   * Enable error mode to prevent further message processing
   */
  enableErrorMode(): void {
    this.errorMode = true;
  }
}
