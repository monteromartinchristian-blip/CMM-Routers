import {
  OpenAiCompatibleAdapter,
  OpenAiCompatibleClient,
  type ProviderFetchFn,
  type ProviderHttpResponse,
} from "../../src/providers/openai-compatible/adapter.js";
import { providerWaveManifest } from "../../src/providers/manifests.js";
import type { ProviderId } from "../../src/core/model.js";
import type { ProviderManifest } from "../../src/providers/manifest.js";

/** Credential value used only inside in-memory test doubles. */
export const TEST_SECRET = "injected-test-secret";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export function recordingFetch(
  respond: (request: RecordedRequest) => ProviderHttpResponse,
): { fetchFn: ProviderFetchFn; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn: ProviderFetchFn = async (url, init) => {
    const request: RecordedRequest = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>),
    };
    requests.push(request);
    return respond(request);
  };
  return { fetchFn, requests };
}

export function jsonResponse(status: number, payload: unknown): ProviderHttpResponse {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return { status, text: async () => text };
}

export function catalogFetch(
  catalog: unknown,
  status = 200,
): { fetchFn: ProviderFetchFn; requests: RecordedRequest[] } {
  return recordingFetch(() => jsonResponse(status, catalog));
}

/** Streaming chat-completions fixture: real SSE frames on a ReadableStream. */
export function sseFetch(
  records: unknown[],
): { fetchFn: ProviderFetchFn; requests: RecordedRequest[] } {
  const encoder = new TextEncoder();
  return recordingFetch(() => ({
    status: 200,
    text: async () => "",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const record of records) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(record)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  }));
}

/**
 * Effective base URL for a manifest in tests: the documented default, or a
 * clearly non-production placeholder for providers whose real endpoint is
 * region/account-parameterized (those manifests carry `baseUrl: null` and the
 * router requires configuration to supply one).
 */
export function testBaseUrl(manifest: ProviderManifest): string {
  return (
    manifest.baseUrl ??
    `https://${manifest.id}.test-region.maas.example.invalid/compatible-mode/v1`
  );
}

export function waveAdapter(
  id: ProviderId,
  options: {
    catalog?: unknown;
    fetchFn?: ProviderFetchFn;
    secret?: string;
    timeoutMs?: number;
    baseUrl?: string;
  } = {},
): OpenAiCompatibleAdapter {
  const manifest = providerWaveManifest(id);
  const baseUrl = options.baseUrl ?? testBaseUrl(manifest);
  const fetchFn =
    options.fetchFn ?? catalogFetch(options.catalog ?? { data: [] }).fetchFn;
  return new OpenAiCompatibleAdapter({
    manifest,
    baseUrl,
    client: new OpenAiCompatibleClient({
      baseUrl,
      secretEnv: manifest.auth.secretEnv,
      secret: options.secret ?? TEST_SECRET,
      providerLabel: manifest.displayName,
      fetchFn,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    }),
  });
}

export function routerRequest(
  provider: ProviderId,
  upstreamModel: string,
  extra: Record<string, unknown> = {},
): { request: never; signal: AbortSignal } {
  const controller = new AbortController();
  return {
    request: {
      requestId: `wave-${provider}-${upstreamModel}`,
      model: {
        id: `${provider}/${upstreamModel}`,
        provider,
        upstreamModel,
        displayName: upstreamModel,
        capability: "CHAT_AND_TOOLS" as const,
      },
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      stream: true,
      ...extra,
    } as never,
    signal: controller.signal,
  };
}
