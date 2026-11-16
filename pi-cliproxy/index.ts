import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "cliproxy";
const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * The proxy's /v1/models returns ids only, so context windows, output limits,
 * and thinking levels come from Pi's own catalogs. Ids Pi does not know are
 * skipped rather than guessed at.
 */
function builtinCatalog(): Map<string, Model<Api>> {
	const models = [
		...getBuiltinModels("openai"),
		...getBuiltinModels("anthropic"),
		...getBuiltinModels("meta"),
	] as Model<Api>[];
	return new Map(models.map((model) => [model.id, model]));
}

/** Accepts the proxy root with or without a trailing slash or /v1. */
function proxyRoot(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function discoverModels(root: string, apiKey: string, signal: AbortSignal): Promise<Model<Api>[]> {
	const response = await fetch(`${root}/v1/models`, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]),
	});
	if (!response.ok) throw new Error(`CLIProxyAPI model discovery failed: HTTP ${response.status}`);

	const payload = (await response.json()) as { data?: { id?: unknown }[] };
	if (!Array.isArray(payload.data)) throw new Error("CLIProxyAPI returned an invalid model list");

	const catalog = builtinCatalog();
	const ids = new Set(payload.data.map((entry) => entry.id).filter((id): id is string => typeof id === "string"));
	return [...ids]
		.sort()
		.map((id) => catalog.get(id))
		.filter((model): model is Model<Api> => model !== undefined)
		.map((model) => ({
			...model,
			provider: PROVIDER_ID,
			// The Anthropic client appends /v1 itself; the OpenAI Responses client does not.
			baseUrl: model.api === "anthropic-messages" ? root : `${root}/v1`,
			// Requests are billed to the subscriptions behind the proxy, not per token.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

async function refreshModels(context: RefreshModelsContext): Promise<Model<Api>[]> {
	const cached = (context.stored?.models ?? []) as Model<Api>[];
	if (!context.allowNetwork) return cached;

	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!context.baseUrl || !apiKey) return cached;

	const models = await discoverModels(proxyRoot(context.baseUrl), apiKey, context.signal);
	// Persist so the models exist at startup, before the next background refresh.
	await context.publish({ persist: { models, checkedAt: Date.now() } });
	return models;
}

/**
 * Registers the models served by a CLIProxyAPI instance under their own
 * provider, next to Pi's built-in ones. The endpoint and key come from the
 * `cliproxy` provider entry in models.json.
 */
export default function cliproxyExtension(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, { name: "CLIProxyAPI", refreshModels });
}
