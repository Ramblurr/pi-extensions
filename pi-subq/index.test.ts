import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierOptions } from "@earendil-works/pi-ai";
import { createSubqProvider } from "./index.ts";

const provider = createSubqProvider();
const model = provider.getAllModels!().find((model) => model.type === "classifier") as ClassifierModel<ClassifierApi>;
const context: ClassifierContext = {
	state: { message: "I need help now" },
	questions: {
		escalate: { type: "bool", instructions: "Urgent?", criteria: { true: "Urgent", false: "Not urgent" } },
		queue: { type: "choice", instructions: "Owner?", criteria: { support: "Help", sales: "Buy" } },
		urgency: { type: "score", instructions: "When?", criteria: ["Later", "Now"] },
	},
};
const responseBody = {
	model: "subq-snap-1.2",
	answers: {
		escalate: { type: "noul", noul: 0.9 },
		queue: { type: "choice", choice: "support", probabilities: { support: 0.8, sales: 0.2 }, confidence: 0.8 },
		urgency: { type: "score", score: 0.9, legend: { "0": "Later", "1": "Now" }, probabilities: { "0": 0.1, "1": 0.9 }, confidence: 0.8 },
	},
	usage: { input_tokens: 1000, output_tokens: 0 },
};
const baseOptions: ClassifierOptions = { apiKey: "test-key", maxRetries: 0 };

// Only the HTTP boundary is replaced: Pi performs serialization, parsing, and pricing.
test("text decisions use SubQ's endpoint, auth, wire types, and pricing", async () => {
	const result = await provider.classify!(model, context, {
		...baseOptions,
		fetch: async (url, init) => {
			assert.equal(String(url), "https://api.subq.ai/v1/systemone");
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("authorization"), "Bearer test-key");
			assert.equal(headers.get("TypeSafe-Danger-Zone-Images"), null);
			assert.deepEqual(JSON.parse(String(init?.body)), {
				model: model.id,
				state: context.state,
				questions: { ...context.questions, escalate: { ...context.questions.escalate, type: "noul" } },
			});
			return Response.json(responseBody);
		},
	});
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(result.provider, "subq");
	assert.deepEqual(result.answers, {
		escalate: { type: "bool", probability: 0.9 },
		queue: responseBody.answers.queue,
		urgency: { type: "score", score: 0.9, confidence: 0.8 },
	});
	assert.equal(result.usage?.input, 1000);
	assert.equal(result.usage?.cost.total, 0.00004);
});

test("images use bare base64 objects, and hooks see the adapted payload", async () => {
	let observedResponse = false;
	const result = await provider.classify!(model, {
		...context,
		images: [
			{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
			{ type: "image", mimeType: "image/webp", data: "d29ybGQ=" },
		],
	}, {
		...baseOptions,
		onPayload: (payload) => {
			assert.deepEqual((payload as { images: unknown }).images, [
				{ mediaType: "image/png", base64: "aGVsbG8=" },
				{ mediaType: "image/webp", base64: "d29ybGQ=" },
			]);
			return { ...(payload as object), state: { message: "hook replacement" } };
		},
		onResponse: () => { observedResponse = true; },
		fetch: async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			assert.deepEqual(body.state, { message: "hook replacement" });
			assert.equal(body.assets, undefined);
			assert.equal(new Headers(init?.headers).get("TypeSafe-Danger-Zone-Images"), null);
			return Response.json(responseBody);
		},
	});
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(observedResponse, true);
});

test("image limits fail before HTTP", async () => {
	for (const [images, message] of [
		[Array.from({ length: 5 }, () => ({ type: "image" as const, mimeType: "image/png", data: "YQ==" })), /at most 4/],
		[[{ type: "image", mimeType: "image/gif", data: "YQ==" }], /PNG, JPEG, and WebP/],
		[[{ type: "image", mimeType: "image/png", data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") }], /exceeds 4 MiB/],
		[Array.from({ length: 3 }, () => ({ type: "image" as const, mimeType: "image/png", data: Buffer.alloc(3 * 1024 * 1024).toString("base64") })), /exceed 8 MiB/],
	] as const) {
		let requested = false;
		const result = await provider.classify!(model, { ...context, images: [...images] }, {
			...baseOptions,
			fetch: async () => { requested = true; return Response.json(responseBody); },
		});
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage!, message);
		assert.equal(requested, false);
	}
});

test("HTTP failures and malformed answers remain classifier errors", async () => {
	for (const response of [
		Response.json({ detail: { error_type: "insufficient_credits", message: "No credits" } }, { status: 402 }),
		Response.json({ answers: {}, usage: responseBody.usage }),
	]) {
		const result = await provider.classify!(model, context, { ...baseOptions, fetch: async () => response });
		assert.equal(result.stopReason, "error");
		assert.ok(result.errorMessage);
	}
});

test("abort signal propagates and produces an aborted result", async () => {
	const controller = new AbortController();
	const result = await provider.classify!(model, context, {
		...baseOptions,
		signal: controller.signal,
		fetch: async (_url, init) => {
			assert.equal(init?.signal, controller.signal);
			controller.abort();
			init?.signal?.throwIfAborted();
			throw new Error("unreachable");
		},
	});
	assert.equal(result.stopReason, "aborted");
});

test("Pi runtime discovers Snap and resolves models.json credential commands", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-subq-auth-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const modelsPath = join(dir, "models.json");
	writeFileSync(modelsPath, JSON.stringify({ providers: { subq: {
		apiKey: "!printf subq-test-key",
		baseUrl: "https://subq-proxy.invalid/v1",
	} } }));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(createSubqProvider());
	const available = await runtime.getAvailableOfType("classifier", "subq");
	assert.equal(available.length, 1);
	const result = await runtime.classify(available[0], context, {
		fetch: async (url, init) => {
			assert.equal(String(url), "https://subq-proxy.invalid/v1/systemone");
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer subq-test-key");
			return Response.json(responseBody);
		},
	});
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(result.provider, "subq");
});

test("registers only Snap as a classifier, with API-key login", () => {
	assert.deepEqual(provider.getModels(), []);
	assert.equal(model.id, "subq-snap-1.2");
	assert.equal(model.contextWindow, 393216);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(typeof provider.auth?.apiKey?.login, "function");
});
