import { type FauxResponseStep, fauxAssistantMessage, getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Loaded only by verify-tui.sh: a local model that answers without network or credentials.
// .agents/ is outside tsconfig and biome, so API drift here shows only when the skill runs.
export default function registerVerifyFauxProvider(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux", reasoning: false }] });
	let replies = 0;
	// Each reply queues the next one, so a run never runs out of replies.
	const reply: FauxResponseStep = () => {
		faux.appendResponses([reply]);
		replies += 1;
		return fauxAssistantMessage(`faux reply ${replies}`);
	};
	faux.setResponses([reply]);
	const apiProvider = getApiProvider(faux.api);
	if (!apiProvider) throw new Error("Faux API provider was not registered");
	pi.registerProvider(faux.getModel().provider, {
		api: faux.api,
		apiKey: "faux-key",
		baseUrl: faux.getModel().baseUrl,
		streamSimple: apiProvider.streamSimple,
		models: faux.models.map((model) => ({
			api: model.api,
			baseUrl: model.baseUrl,
			contextWindow: model.contextWindow,
			cost: model.cost,
			id: model.id,
			input: model.input,
			maxTokens: model.maxTokens,
			name: model.name,
			reasoning: model.reasoning,
		})),
	});
}
