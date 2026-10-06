import Anthropic from "@anthropic-ai/sdk";
import { PROVIDER_ENDPOINTS } from "../config.js";
import { ProviderError, type ModelProvider, type ProviderRequest, type ProviderResponse, type Msg } from "./types.js";

type AnthropicMsg = { role: "user" | "assistant"; content: any[] };

export function toAnthropicMessages(msgs: Msg[]): AnthropicMsg[] {
  const out: AnthropicMsg[] = [];
  const push = (role: "user" | "assistant", block: any) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of msgs) {
    if (m.role === "user") push("user", { type: "text", text: m.text });
    else if (m.role === "assistant") {
      if (m.text) push("assistant", { type: "text", text: m.text });
      for (const c of m.toolCalls) push("assistant", { type: "tool_use", id: c.id, name: c.name, input: c.input });
    } else push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: m.content });
  }
  return out;
}

/**
 * Transport guard: redirects are NEVER followed (a 307/308 would re-POST the task + page content to another host).
 * Any 3xx is converted into a non-retryable safe error.
 */
export function noRedirectFetch(base: typeof fetch): typeof fetch {
  return (async (input: any, init?: any) => {
    const r = await base(input, { ...(init ?? {}), redirect: "manual" });
    if (r.type === "opaqueredirect" || (r.status >= 300 && r.status < 400)) {
      try { await r.body?.cancel(); } catch { /* ignore */ }
      throw new ProviderError("PROVIDER_BAD_RESPONSE", false);
    }
    return r;
  }) as typeof fetch;
}

/** Real Anthropic adapter. Endpoint is a code constant (no user-supplied endpoints). */
export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly mode = "REAL" as const;
  private client: Anthropic;
  constructor(readonly model: string, apiKey: string, opts: { fetch?: typeof fetch; /** TEST ONLY (never wired to config/env): loopback server standing in for the endpoint */ testOnlyBaseURL?: string } = {}) {
    this.client = new Anthropic({
      apiKey,
      baseURL: opts.testOnlyBaseURL ?? PROVIDER_ENDPOINTS.anthropic,
      maxRetries: 0, // retries are owned (and bounded/audited) by the coordinator
      timeout: 60_000,
      logLevel: "off", // explicit: the SDK must never log request/response bodies (ANTHROPIC_LOG is ignored when this is set)
      fetch: noRedirectFetch(opts.fetch ?? globalThis.fetch),
      // The SDK has no telemetry channel; additionally blank its informational platform headers.
      defaultHeaders: {
        "X-Stainless-Lang": null, "X-Stainless-Package-Version": null, "X-Stainless-OS": null, "X-Stainless-Arch": null,
        "X-Stainless-Runtime": null, "X-Stainless-Runtime-Version": null, "X-Stainless-Retry-Count": null, "X-Stainless-Timeout": null,
      } as any,
    });
  }
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    try {
      const r = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 1024,
          system: req.system,
          tools: req.tools as any,
          messages: toAnthropicMessages(req.messages) as any,
        },
        { signal: req.signal },
      );
      const toolCalls = r.content.filter((b: any) => b.type === "tool_use").map((b: any) => ({ id: b.id, name: b.name, input: b.input }));
      const text = r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") || undefined;
      return { text, toolCalls, usage: { inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0 } };
    } catch (e: any) {
      if (req.signal?.aborted) throw e;
      if (e instanceof ProviderError) throw e;
      if (e?.cause instanceof ProviderError) throw e.cause; // e.g. redirect refused by the transport guard
      const status: number | undefined = e?.status;
      // Map to a safe code. The SDK error object (may echo content) is dropped here.
      if (status === 401 || status === 403) throw new ProviderError("PROVIDER_AUTH", false);
      if (status === 400 || status === 404) throw new ProviderError("PROVIDER_BAD_RESPONSE", false);
      throw new ProviderError("PROVIDER_UNAVAILABLE", true);
    }
  }
}
