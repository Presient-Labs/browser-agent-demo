import { z } from "zod";

/** Provider -> the ONLY endpoint that provider may talk to. Not env-configurable on purpose. */
export const PROVIDER_ENDPOINTS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

export interface Budgets {
  maxSteps: number;
  maxModelCalls: number;
  maxRetries: number;
  wallTimeMs: number;
  maxInspectChars: number;
  maxTotalExtractedChars: number;
  retryBackoffMs: number;
}

export interface Config {
  host: "127.0.0.1";
  backendPort: number;
  siteOrigin: string; // exact scheme://host:port that the agent may touch
  cdpPort: number;
  extensionDir: string;
  provider: string; // fake | anthropic | openai
  model: string;
  approvedModels: string[]; // "provider:model"
  anthropicApiKey: string; // backend-only; never serialized
  budgets: Budgets;
  rates: { inputPerMTok: number; outputPerMTok: number };
}

const num = (v: string | undefined, d: number) => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error("CONFIG_INVALID_NUMBER");
  return n;
};

const Env = z.object({
  PROVIDER: z.string().default("fake"),
  MODEL: z.string().default("claude-sonnet-5-5"),
  APPROVED_MODELS: z.string().default("anthropic:claude-sonnet-5-5"),
});

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = Env.parse({ PROVIDER: env.PROVIDER || undefined, MODEL: env.MODEL || undefined, APPROVED_MODELS: env.APPROVED_MODELS || undefined });
  return {
    host: "127.0.0.1",
    backendPort: num(env.BACKEND_PORT, 4200),
    siteOrigin: env.SITE_ORIGIN || "http://127.0.0.1:4100",
    cdpPort: num(env.CDP_PORT, 9333),
    extensionDir: env.EXTENSION_DIR || new URL("../../extension/dist", import.meta.url).pathname,
    provider: e.PROVIDER,
    model: e.MODEL,
    approvedModels: e.APPROVED_MODELS.split(",").map((s) => s.trim()).filter(Boolean),
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    budgets: {
      maxSteps: num(env.MAX_STEPS, 12),
      maxModelCalls: num(env.MAX_MODEL_CALLS, 14),
      maxRetries: num(env.MAX_RETRIES, 2),
      wallTimeMs: num(env.WALL_TIME_MS, 120_000),
      maxInspectChars: num(env.MAX_INSPECT_CHARS, 4000),
      maxTotalExtractedChars: num(env.MAX_TOTAL_EXTRACTED_CHARS, 16000),
      retryBackoffMs: num(env.RETRY_BACKOFF_MS, 500),
    },
    // PLACEHOLDER rates (USD per million tokens). Configure to current pricing; output is labelled "estimate".
    rates: { inputPerMTok: num(env.RATE_INPUT_PER_MTOK, 3), outputPerMTok: num(env.RATE_OUTPUT_PER_MTOK, 15) },
  };
}
