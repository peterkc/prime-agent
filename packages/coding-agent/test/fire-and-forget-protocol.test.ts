import { describe, expect, it } from "vitest";
import { createAgentSessionMessagePrompt, parseAgentSessionMessagePromptId } from "../src/core/agent-messages.js";

const endpoint = { activeSessionId: "active-child", sessionId: "child-id", sessionName: "worker" };

describe("fire-and-forget agent protocol", () => {
	it("labels nuclear-family delivery with the bracket grammar header", () => {
		const prompt = createAgentSessionMessagePrompt({
			id: "agentmsg_reply",
			source: "agent_message",
			message: "finished",
			from: { activeSessionId: "active-child", sessionId: "child-id", sessionName: "worker" },
			fromRelationship: "child",
			target: endpoint,
		});
		expect(prompt).toBe("[agent-message from child:worker]\nMessage id: agentmsg_reply\n\nfinished");
		// The visible ID is for reply links; only details identify a current message.
		expect(parseAgentSessionMessagePromptId(prompt)).toBeUndefined();
	});

	it("labels a parent without requiring a name", () => {
		const prompt = createAgentSessionMessagePrompt({
			id: "agentmsg_task",
			source: "agent_message",
			message: "continue",
			fromRelationship: "parent",
			target: endpoint,
		});
		expect(prompt.startsWith("[agent-message from parent:unknown]\n")).toBe(true);
	});
});
