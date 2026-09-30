import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

function unsupported(name: string): never {
	throw new Error(`The workflow test context does not implement ${name}.`);
}

/** Creates a context checked against the installed tool execution contract. */
export function createToolContext(cwd: string): ExtensionToolContext {
	return {
		cwd,
		hasUI: false,
		mode: "json",
		get ui() { return unsupported("ui"); },
		get sessionManager() { return unsupported("sessionManager"); },
		get modelRegistry() { return unsupported("modelRegistry"); },
		model: undefined,
		scopedModels: [],
		signal: undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		hasPendingMessages: () => false,
		abort() {},
		shutdown() {},
		compact() {},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		tools: [],
		executeTool: async () => unsupported("executeTool"),
	};
}
