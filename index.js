/**
 * Keeps the Desktop startup gate satisfied.
 *
 * DeepSeek Harness Desktop decides in its native main process whether to open
 * the workspace or the "add an API key to get started" window:
 *
 *     needsWelcome(authentication) = !loggedIn && !hasApiKey
 *
 * `hasApiKey` is true when *any* credential reference named by the active
 * provider directory (the official `llm-deepseek` `apiKeyEnv`, plus every
 * configurable provider's `settingsPath.apiKeyEnv`) reports
 * `configured === true` through the `credentials` service. The gate never
 * validates the stored value, so a placeholder is enough to skip it while real
 * model calls keep using whichever provider the profile actually routes.
 *
 * This plugin therefore does one thing: when no named reference is configured,
 * it stores a placeholder for one of them. It never overwrites an existing
 * value, and it re-asserts the placeholder if the reference is unset later, so
 * the gate stays skipped across restarts.
 *
 * The plugin imports nothing, so it resolves from any install location.
 *
 * @module dsh-welcome-bypass
 */

/** Loader identity for the profile entry this bundle inserts. */
export const name = "welcome-bypass";

/** The credential seam is the only hard requirement. */
export const inject = ["credentials"];

/** Settings namespace of the official DeepSeek provider, whose `apiKeyEnv` the gate always counts. */
const OFFICIAL_NAMESPACE = "llm-deepseek";

/** Reference the official provider declares by default; the preferred target. */
const FALLBACK_REF = "DEEPSEEK_API_KEY";

/** Reference names are POSIX shell identifiers, so a configured name is validated before use. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Default configuration, overridable through the profile entry's `config` block. */
const DEFAULTS = {
  enabled: true,
  ref: "",
  placeholder: "dsh-welcome-bypass-placeholder",
  refill: true
};

/**
 * Normalize the profile entry configuration.
 *
 * @param config - Raw `config` block from `cordis.patch.yml`.
 * @returns Configuration with every default applied.
 */
function normalize(config) {
  const source = config !== null && typeof config === "object" ? config : {};
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULTS.enabled,
    ref: typeof source.ref === "string" ? source.ref.trim() : DEFAULTS.ref,
    placeholder: typeof source.placeholder === "string" && source.placeholder.length > 0
      ? source.placeholder
      : DEFAULTS.placeholder,
    refill: typeof source.refill === "boolean" ? source.refill : DEFAULTS.refill
  };
}

/**
 * Read the credential references the startup gate counts.
 *
 * Mirrors the Desktop welcome backend: the official provider's `apiKeyEnv` plus
 * `apiKeyEnv` at every configurable provider's settings address.
 *
 * @param ctx - Host context; `settings` and `llm` are optional.
 * @returns Distinct reference names, in discovery order.
 */
function candidateRefs(ctx) {
  const refs = new Set();

  let descriptors = [];
  try {
    const settings = ctx.get("settings");
    descriptors = settings?.describe() ?? [];
  } catch (error) {
    ctx.logger.warn("welcome-bypass: settings are not readable yet (%s)", error?.message ?? error);
  }
  if (!Array.isArray(descriptors)) descriptors = [];

  const byNamespace = new Map();
  for (const descriptor of descriptors) {
    if (descriptor === null || typeof descriptor !== "object") continue;
    byNamespace.set(descriptor.ns, descriptor);
    if (descriptor.ns !== OFFICIAL_NAMESPACE) continue;
    const declared = descriptor.value?.apiKeyEnv;
    if (typeof declared === "string" && REF_PATTERN.test(declared)) refs.add(declared);
  }

  let providers = [];
  try {
    const llm = ctx.get("llm");
    providers = llm?.listConfigurableProviders() ?? [];
  } catch (error) {
    ctx.logger.warn("welcome-bypass: the provider directory is not readable yet (%s)", error?.message ?? error);
  }
  if (!Array.isArray(providers)) providers = [];

  for (const provider of providers) {
    if (provider === null || typeof provider !== "object") continue;
    if (typeof provider.settingsNs !== "string" || !Array.isArray(provider.settingsPath)) continue;
    let value = byNamespace.get(provider.settingsNs)?.value;
    for (const key of provider.settingsPath) {
      if (typeof key !== "string" || value === null || typeof value !== "object") {
        value = undefined;
        break;
      }
      value = value[key];
    }
    const declared = value?.apiKeyEnv;
    if (typeof declared === "string" && REF_PATTERN.test(declared)) refs.add(declared);
  }

  return [...refs];
}

/**
 * Store the placeholder only when the gate would otherwise show.
 *
 * @param ctx - Host context carrying the `credentials` service.
 * @param options - Normalized plugin configuration.
 */
async function keepGateSatisfied(ctx, options) {
  const refs = candidateRefs(ctx);
  if (refs.length === 0) {
    // The provider directory is not readable yet. The official provider's
    // default reference is still what the gate checks, so keep it configured
    // rather than doing nothing: a later run revisits the real directory.
    const fallback = options.ref.length > 0 ? options.ref : FALLBACK_REF;
    if (!REF_PATTERN.test(fallback)) {
      ctx.logger.warn("welcome-bypass: %j is not a usable credential reference; the gate stays as it is", fallback);
      return;
    }
    const info = await ctx.credentials.describe(fallback);
    if (info !== null && typeof info === "object" && info.configured === true) return;
    await ctx.credentials.set(fallback, options.placeholder);
    ctx.logger.info("welcome-bypass: stored a placeholder for %s before the provider directory was readable", fallback);
    return;
  }

  let configured = 0;
  for (const ref of refs) {
    const info = await ctx.credentials.describe(ref);
    if (info !== null && typeof info === "object" && info.configured === true) configured += 1;
  }
  if (configured > 0) return;

  const target = options.ref.length > 0
    ? options.ref
    : refs.includes(FALLBACK_REF) ? FALLBACK_REF : refs[0];
  if (!REF_PATTERN.test(target)) {
    ctx.logger.warn("welcome-bypass: %j is not a usable credential reference; the gate stays as it is", target);
    return;
  }

  await ctx.credentials.set(target, options.placeholder);
  ctx.logger.info("welcome-bypass: stored a placeholder for %s so the Desktop startup gate stays skipped", target);
}

/**
 * Keep the gate satisfied for the lifetime of the profile.
 *
 * @param ctx - Profile scope; the `credentials` service is injected.
 * @param config - Profile entry configuration.
 */
export async function apply(ctx, config) {
  const options = normalize(config);

  if (!options.enabled) {
    ctx.logger.info("welcome-bypass: disabled; the Desktop welcome gate behaves normally");
    return;
  }

  /** Serialize runs so a burst of credential events cannot interleave two stores. */
  let queue = Promise.resolve();
  const schedule = (reason) => {
    queue = queue
      .then(() => keepGateSatisfied(ctx, options))
      .catch((error) => {
        ctx.logger.warn("welcome-bypass: could not satisfy the gate (%s): %s", reason, error?.message ?? error);
      });
    return queue;
  };

  if (options.refill) {
    ctx.on("credentials/reference-updated", (ref) => {
      if (typeof ref !== "string") return;
      void schedule(`reference ${ref} changed`);
    });
  }

  await schedule("startup");
}
