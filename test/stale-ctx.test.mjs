import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";

// These tests run against the built bundle (dist/index.js). Run `pnpm build` first;
// `pnpm test` does this for you.
//
// The fake runtime below mirrors pi's extension contract:
// - contexts are getter-bags created fresh per event dispatch,
// - session_shutdown is awaited before the old runtime is invalidated,
// - every context getter throws once the runtime is invalidated.

const STALE_MESSAGE = "This extension ctx is stale after session replacement or reload.";
const EXTENSION_ID = "codex-usage";

const USAGE_PAYLOAD = {
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: { limit_window_seconds: 18_000, used_percent: 20, reset_after_seconds: 3_600 },
		secondary_window: { limit_window_seconds: 604_800, used_percent: 40, reset_after_seconds: 86_400 },
	},
};

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function jsonResponse(payload) {
	return { ok: true, json: async () => payload };
}

async function flush(times = 20) {
	for (let index = 0; index < times; index += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

async function waitFor(condition, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function makeRuntime(modelId = "gpt-5.1-codex", provider = "openai-codex") {
	const runtime = { stale: false, statuses: [], notifications: [] };
	const ui = {
		theme: { fg: (_color, text) => text },
		setStatus: (id, text) => runtime.statuses.push({ id, text }),
		notify: (message, type) => runtime.notifications.push({ message, type }),
	};
	function assertActive() {
		if (runtime.stale) throw new Error(STALE_MESSAGE);
	}
	function createContext() {
		return {
			get ui() {
				assertActive();
				return ui;
			},
			get hasUI() {
				assertActive();
				return true;
			},
			get model() {
				assertActive();
				return { id: modelId, provider };
			},
		};
	}
	return { runtime, createContext };
}

let agentDir;
let fetchQueue;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-codex-usage-test-"));
	await fs.writeFile(
		path.join(agentDir, "auth.json"),
		JSON.stringify({ "openai-codex": { type: "oauth", access: "token", accountId: "acct" } }),
	);
	fetchQueue = [];
	globalThis.fetch = () => {
		const pending = deferred();
		fetchQueue.push(pending);
		return pending.promise;
	};
});

afterEach(async () => {
	await fs.rm(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// Fresh module per call: pi rebinds a new extension instance for each session.
async function loadExtension() {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, definition) => commands.set(name, definition),
	};
	const module = await import(`../dist/index.js?case=${crypto.randomUUID()}`);
	module.default(pi);
	return { handlers, commands };
}

function watchRejections(t) {
	const rejections = [];
	const listener = (reason) => rejections.push(reason);
	process.on("unhandledRejection", listener);
	t.after(() => process.removeListener("unhandledRejection", listener));
	return rejections;
}

test("reload during an in-flight refresh does not touch the stale context", async (t) => {
	const rejections = watchRejections(t);
	const extension = await loadExtension();
	const session = makeRuntime();

	extension.handlers.get("session_start")({ type: "session_start", reason: "startup" }, session.createContext());
	await waitFor(() => fetchQueue.length === 1);

	// pi awaits session_shutdown, then invalidates the old runtime
	await extension.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, session.createContext());
	session.runtime.stale = true;
	const writesBeforeStale = session.runtime.statuses.length;

	fetchQueue[0].resolve(jsonResponse(USAGE_PAYLOAD));
	await flush();

	assert.deepEqual(rejections, []);
	assert.equal(session.runtime.statuses.length, writesBeforeStale, "no footer writes after invalidation");
});

test("startup refresh renders the usage footer and mode toggle re-renders without a fetch", async (t) => {
	const rejections = watchRejections(t);
	const extension = await loadExtension();
	const session = makeRuntime();

	extension.handlers.get("session_start")({ type: "session_start", reason: "startup" }, session.createContext());
	await waitFor(() => fetchQueue.length === 1);
	fetchQueue[0].resolve(jsonResponse(USAGE_PAYLOAD));
	await flush();

	const rendered = session.runtime.statuses.at(-1);
	assert.equal(rendered.id, EXTENSION_ID);
	assert.match(rendered.text, /5h:80%/);
	assert.match(rendered.text, /7d:60%/);

	await extension.commands.get("codex-usage-mode").handler("used", session.createContext());
	await flush();
	assert.equal(fetchQueue.length, 1, "mode toggle must render from the stored snapshot");
	assert.match(session.runtime.statuses.at(-1).text, /5h:20%/);

	assert.deepEqual(rejections, []);
});

test("a replacement session renders after the old one is replaced", async (t) => {
	const rejections = watchRejections(t);

	const oldExtension = await loadExtension();
	const oldSession = makeRuntime();
	oldExtension.handlers.get("session_start")({ type: "session_start", reason: "startup" }, oldSession.createContext());
	await waitFor(() => fetchQueue.length === 1);
	await oldExtension.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, oldSession.createContext());
	oldSession.runtime.stale = true;
	fetchQueue[0].resolve(jsonResponse(USAGE_PAYLOAD));
	await flush();

	const newExtension = await loadExtension();
	const newSession = makeRuntime();
	newExtension.handlers.get("session_start")({ type: "session_start", reason: "new" }, newSession.createContext());
	await waitFor(() => fetchQueue.length === 2);
	fetchQueue[1].resolve(jsonResponse(USAGE_PAYLOAD));
	await flush();

	assert.match(newSession.runtime.statuses.at(-1).text, /5h:80%/);
	assert.deepEqual(rejections, []);
});

test("codex-resets finishing after reload does not touch the stale context", async (t) => {
	const rejections = watchRejections(t);
	const extension = await loadExtension();
	const session = makeRuntime();

	extension.handlers.get("session_start")({ type: "session_start", reason: "startup" }, session.createContext());
	await waitFor(() => fetchQueue.length === 1);
	fetchQueue[0].resolve(jsonResponse(USAGE_PAYLOAD));
	await flush();

	const commandPromise = extension.commands.get("codex-resets").handler("", session.createContext());
	await waitFor(() => fetchQueue.length === 2);

	await extension.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, session.createContext());
	session.runtime.stale = true;
	const notificationsBeforeStale = session.runtime.notifications.length;

	fetchQueue[1].resolve(jsonResponse({ credits: [] }));
	await commandPromise;
	await flush();

	assert.deepEqual(rejections, []);
	assert.equal(session.runtime.notifications.length, notificationsBeforeStale);
});

test("session start on a non-Codex model hides the footer without fetching", async (t) => {
	const rejections = watchRejections(t);
	const extension = await loadExtension();
	const session = makeRuntime("claude-sonnet-4-5", "anthropic");

	extension.handlers.get("session_start")({ type: "session_start", reason: "startup" }, session.createContext());
	await waitFor(() => session.runtime.statuses.length > 0);
	await flush();

	assert.equal(fetchQueue.length, 0, "no usage fetch for a non-Codex model");
	const rendered = session.runtime.statuses.at(-1);
	assert.equal(rendered.id, EXTENSION_ID);
	assert.equal(rendered.text, undefined, "footer is cleared");
	assert.deepEqual(rejections, []);
});

test("model_select to a non-Codex model hides the footer; switching back resumes", async (t) => {
	const rejections = watchRejections(t);
	const extension = await loadExtension();
	const session = makeRuntime();

	extension.handlers.get("session_start")({ type: "session_start", reason: "startup" }, session.createContext());
	await waitFor(() => fetchQueue.length === 1);
	fetchQueue[0].resolve(jsonResponse(USAGE_PAYLOAD));
	await flush();
	assert.match(session.runtime.statuses.at(-1).text, /5h:80%/);

	extension.handlers.get("model_select")(
		{ type: "model_select", model: { id: "claude-sonnet-4-5", provider: "anthropic" }, previousModel: undefined, source: "set" },
		session.createContext(),
	);
	await flush();
	assert.equal(fetchQueue.length, 1, "no fetch when hiding");
	assert.equal(session.runtime.statuses.at(-1).text, undefined, "footer is cleared");

	extension.handlers.get("model_select")(
		{ type: "model_select", model: { id: "gpt-5.1-codex", provider: "openai-codex" }, previousModel: undefined, source: "set" },
		session.createContext(),
	);
	await waitFor(() => fetchQueue.length === 2);
	fetchQueue[1].resolve(jsonResponse(USAGE_PAYLOAD));
	await flush();
	assert.match(session.runtime.statuses.at(-1).text, /5h:80%/);
	assert.deepEqual(rejections, []);
});

test("switching to a non-Codex model during an in-flight refresh keeps the footer hidden", async (t) => {
	const rejections = watchRejections(t);
	const extension = await loadExtension();
	const session = makeRuntime();

	extension.handlers.get("session_start")({ type: "session_start", reason: "startup" }, session.createContext());
	await waitFor(() => fetchQueue.length === 1);

	extension.handlers.get("model_select")(
		{ type: "model_select", model: { id: "claude-sonnet-4-5", provider: "anthropic" }, previousModel: undefined, source: "set" },
		session.createContext(),
	);
	await flush();

	fetchQueue[0].resolve(jsonResponse(USAGE_PAYLOAD));
	await flush();

	assert.equal(fetchQueue.length, 1, "no follow-up fetch");
	assert.equal(session.runtime.statuses.at(-1).text, undefined, "footer stays hidden");
	assert.deepEqual(rejections, []);
});

test("auto-refresh ticks stay hidden without fetching on a non-Codex model", async (t) => {
	const rejections = watchRejections(t);
	mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => mock.timers.reset());
	const extension = await loadExtension();
	const session = makeRuntime("claude-sonnet-4-5", "anthropic");

	extension.handlers.get("session_start")({ type: "session_start", reason: "startup" }, session.createContext());
	await waitFor(() => session.runtime.statuses.length > 0);
	await flush();
	assert.equal(fetchQueue.length, 0);

	mock.timers.tick(120_000);
	await flush();

	assert.equal(fetchQueue.length, 0, "interval ticks must not fetch for a non-Codex model");
	assert.deepEqual(rejections, []);
});
