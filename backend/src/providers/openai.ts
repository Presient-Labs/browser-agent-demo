import { ProviderError, type ModelProvider, type ProviderResponse } from "./types.js";

/**
 * STUB - NOT IMPLEMENTED. Exists only to show the provider seam. It never makes a network call
 * and always fails safely. Consequence: a "both providers work by configuration" requirement
 * (client Milestone 2) is NOT met by this demo.
 */
export class OpenAIProviderStub implements ModelProvider {
  readonly id = "openai";
  readonly mode = "REAL" as const;
  constructor(readonly model: string) {}
  async complete(): Promise<ProviderResponse> {
    throw new ProviderError("PROVIDER_NOT_IMPLEMENTED", false);
  }
}
