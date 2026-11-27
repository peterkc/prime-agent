import { join } from "node:path";
import { getDocsPath } from "../config.js";
import type { ModelRegistry } from "./model-registry.js";

const UNKNOWN_PROVIDER = "unknown";
export const LOGIN_RECOVERY_MESSAGE = "Run /login to update credentials.";

export function hasResolvedModel(model: { provider: string } | undefined): boolean {
	return model !== undefined && model.provider !== UNKNOWN_PROVIDER;
}

export function getProviderLoginHelp(): string {
	return [
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(saved?: {
	provider: string | undefined;
	registry: ModelRegistry;
}): string {
	if (saved?.provider) {
		const cause = saved.registry.getProviderMissingAuthMessage(saved.provider);
		if (cause) return cause;
		if (!saved.registry.hasProvider(saved.provider)) return formatProviderNotRegisteredMessage(saved.provider);
	}
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatProviderNotRegisteredMessage(provider: string): string {
	return `Provider ${provider} is not registered. Use /model to pick another model.`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}

export function formatAuthenticationFailedMessage(provider: string): string {
	return (
		`Authentication failed for "${provider}". Credentials may have expired or network is unavailable.\n\n` +
		LOGIN_RECOVERY_MESSAGE
	);
}

/**
 * Image-attaching turns on a model without image input must not silently drop
 * the images: name the session model, the setting, and the alternatives so the
 * user can act immediately.
 */
export function formatImageModelRequiredMessage(sessionModelId: string): string {
	return [
		`This turn attaches images, but the selected model (${sessionModelId}) does not accept image input.`,
		"",
		"Pick one:",
		`- Switch the session model to an image-capable one with /model, or`,
		`- Set imageModel in settings.json to an image-capable model ("provider/model-id" or a bare id), e.g. "anthropic/claude-sonnet-4-5"`,
		"",
		"Then resend the message. Without it the request would silently drop the images.",
	].join("\n");
}

export function formatImageModelUnusableMessage(reference: string): string {
	return [
		`imageModel "${reference}" could not be resolved to an available, image-capable, authenticated model.`,
		"",
		"Fix the imageModel setting (settings.json) or authenticate the provider, then resend the message.",
	].join("\n");
}

export function isLikelyAuthenticationError(message: string): boolean {
	return (
		/\b(401|403)\b/i.test(message) ||
		/unauthorized|forbidden|invalid[_ -]?api[_ -]?key|api key.*invalid/i.test(message) ||
		/authentication failed|invalid authentication|missing authentication/i.test(message) ||
		/(expired|invalid) token|token expired|access denied|permission denied/i.test(message)
	);
}

export function addLoginGuidanceToAuthError(message: string): string {
	if (/\/login\b/.test(message)) {
		return message;
	}
	return `${message}\n\n${LOGIN_RECOVERY_MESSAGE}`;
}
