import { createProvider, envApiKeyAuth, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const API = "typesafe-system-one";

// System One encodes images as data URLs; SubQ requires bare base64 objects.
function subqPayload(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("SubQ payload must be an object");
	}
	const payload = value as Record<string, unknown>;
	if (!("images" in payload)) return payload;
	if (!Array.isArray(payload.images)) throw new Error("SubQ images must be an array");
	let totalBytes = 0;
	const images = payload.images.map((url: unknown) => {
		const match = typeof url === "string" && /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/su.exec(url);
		if (!match) throw new Error("SubQ image must be a PNG, JPEG, or WebP base64 data URL");
		const bytes = Buffer.byteLength(match[2], "base64");
		if (bytes > 4 * 1024 * 1024) throw new Error("SubQ image exceeds 4 MiB");
		totalBytes += bytes;
		return { mediaType: match[1], base64: match[2] };
	});
	if (totalBytes > 8 * 1024 * 1024) throw new Error("SubQ images exceed 8 MiB in total");
	return { ...payload, images };
}

export function createSubqProvider(): Provider {
	// Use Pi's supported provider export, not a path into its installation.
	const systemOne = builtinProviders().find((provider) => provider.id === "typesafe")?.classify;
	if (!systemOne) throw new Error("SubQ requires Pi with the TypeSafe classifier provider (tested on 1.4.0)");

	return createProvider({
		id: "subq",
		name: "SubQ",
		baseUrl: "https://api.subq.ai/v1",
		auth: { apiKey: envApiKeyAuth("SubQ API key", ["SUBQ_API_KEY"]) },
		models: [
			{
				type: "classifier",
				id: "subq-snap-1.1",
				name: "SubQ Snap 1.1",
				provider: "subq",
				api: API,
				baseUrl: "https://api.subq.ai/v1",
				input: ["text", "image"],
				cost: { input: 0.04, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 393216,
			},
		],
		classifiers: {
			[API]: {
				classify: (model, context, options) =>
					systemOne(
						{ ...model, compat: { ...model.compat, imageInput: "images", sendImageOptInHeader: false } },
						context,
						{
							...options,
							onPayload: async (payload, requestModel) => {
								const converted = subqPayload(payload);
								return (await options?.onPayload?.(converted, requestModel)) ?? converted;
							},
						},
					),
			},
		},
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(createSubqProvider());
}
