import type { TOOL_DEFS } from "../tools.js";

export interface ToolCall { id: string; name: string; input: unknown }
export type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ProviderRequest { system: string; messages: Msg[]; tools: typeof TOOL_DEFS; signal?: AbortSignal }
export interface ProviderResponse { text?: string; toolCalls: ToolCall[]; usage: { inputTokens: number; outputTokens: number } }

export interface ModelProvider {
  readonly id: string; // fake | anthropic | openai
  readonly model: string;
  readonly mode: "FAKE" | "REAL";
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}

export type ProviderErrorCode =
  | "PROVIDER_NOT_APPROVED" | "PROVIDER_NO_KEY" | "PROVIDER_NOT_IMPLEMENTED"
  | "PROVIDER_UNAVAILABLE" | "PROVIDER_AUTH" | "PROVIDER_BAD_RESPONSE";

/** Carries ONLY a safe code. Never wraps the SDK error (which could echo payload content). */
export class ProviderError extends Error {
  constructor(public readonly code: ProviderErrorCode, public readonly retryable = false) {
    super(code);
    this.name = "ProviderError";
  }
}
