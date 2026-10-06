import { PROVIDER_ENDPOINTS, type Config } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProviderStub } from "./openai.js";
import { ProviderError, type ModelProvider } from "./types.js";

export interface ResolveDeps { fakeFactory?: () => ModelProvider; fetch?: typeof fetch }

/**
 * Rejects unapproved provider/model BEFORE any client object (and therefore any network call) is created.
 * `fake` is allowed explicitly and is always labelled FAKE.
 */
export function resolveProvider(cfg: Pick<Config, "provider" | "model" | "approvedModels" | "anthropicApiKey">, deps: ResolveDeps = {}): ModelProvider {
  if (cfg.provider === "fake") {
    if (!deps.fakeFactory) throw new ProviderError("PROVIDER_NOT_APPROVED");
    return deps.fakeFactory();
  }
  if (!Object.hasOwn(PROVIDER_ENDPOINTS, cfg.provider)) throw new ProviderError("PROVIDER_NOT_APPROVED");
  if (!cfg.approvedModels.includes(`${cfg.provider}:${cfg.model}`)) throw new ProviderError("PROVIDER_NOT_APPROVED");
  if (cfg.provider === "openai") return new OpenAIProviderStub(cfg.model);
  if (!cfg.anthropicApiKey) throw new ProviderError("PROVIDER_NO_KEY");
  return new AnthropicProvider(cfg.model, cfg.anthropicApiKey, { fetch: deps.fetch });
}
