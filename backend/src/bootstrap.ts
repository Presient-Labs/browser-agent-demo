import type { AuditStore } from "./audit.js";
import type { Config } from "./config.js";
import { ProviderError, type ModelProvider } from "./providers/types.js";
import { resolveProvider, type ResolveDeps } from "./providers/registry.js";
import { log } from "./logger.js";

/** Resolves the provider and records a metadata-only audit event on rejection. No network call on any rejection path. */
export function resolveProviderAudited(cfg: Config, audit: AuditStore, deps: ResolveDeps = {}): ModelProvider {
  try {
    return resolveProvider(cfg, deps);
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : "PROVIDER_NOT_APPROVED";
    audit.record({ task_id: "startup", category: "provider_config", outcome: "rejected", code });
    log("provider_rejected", { code });
    throw e;
  }
}
