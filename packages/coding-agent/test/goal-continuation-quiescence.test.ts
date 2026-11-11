import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";

type Harness = {
	_goalState: { status: string; objective?: string; continuationsUsed: number };
	_goalContinuationAwaitsRlmWork: boolean;
	_meshFollowUpPending: boolean;
	_goalContinuationAwaitsMesh: boolean;
	_meshGoalResume?: Promise<void>;
	agent: { waitForIdle(): Promise<void> };
	_agentEventQueue: Promise<void>;
	_resumeGoalAfterMeshIdle(): void;
	_maybeResumeGoalContinuationAfterRlmWork(): void;
	_finishGoalWithError: ReturnType<typeof vi.fn>;
	_asError: (error: unknown) => Error;
	_disposed: boolean;
	_disposing: boolean;
	_sessionInputAdmissionPauses: Set<symbol>;
	_sessionInputPumpSuspended: boolean;
	_hasUnsettledRlmQuiescenceWork: () => boolean;
	_hasLiveBackgroundBashHandles: () => boolean;
	_stopGoalContinuationForTerminalMessage: () => boolean;
	_ensureGoalRuntimeActive: () => void;
	_setGoalState: (goal: unknown) => void;
	_createPreparedTurnAction: ReturnType<typeof vi.fn>;
	_admitSessionInput: ReturnType<typeof vi.fn>;
};

const getGoalContinuation = Reflect.get(AgentSession.prototype, "_getGoalContinuationMessages") as (
	this: Harness,
	context: { message: unknown; context: unknown },
) => Promise<unknown[]>;
const maybeResume = Reflect.get(AgentSession.prototype, "_maybeResumeGoalContinuationAfterRlmWork") as (
	this: Harness,
) => void;

const resumeMesh = Reflect.get(AgentSession.prototype, "_resumeGoalAfterMeshIdle") as (this: Harness) => void;
const setMeshPending = Reflect.get(AgentSession.prototype, "setMeshFollowUpPending") as (
	this: Harness,
	pending: boolean,
) => void;

function harness(overrides: Partial<Harness> = {}): Harness {
	return {
		_goalState: { status: "active", objective: "ship it", continuationsUsed: 0 },
		_goalContinuationAwaitsRlmWork: false,
		_meshFollowUpPending: false,
		_goalContinuationAwaitsMesh: false,
		agent: { waitForIdle: async () => {} },
		_agentEventQueue: Promise.resolve(),
		_resumeGoalAfterMeshIdle() {
			resumeMesh.call(this);
		},
		_maybeResumeGoalContinuationAfterRlmWork() {
			maybeResume.call(this);
		},
		_finishGoalWithError: vi.fn(),
		_asError: (error) => (error instanceof Error ? error : new Error(String(error))),
		_disposed: false,
		_disposing: false,
		_sessionInputAdmissionPauses: new Set(),
		_sessionInputPumpSuspended: false,
		_hasUnsettledRlmQuiescenceWork: () => false,
		_hasLiveBackgroundBashHandles: () => false,
		_stopGoalContinuationForTerminalMessage: () => false,
		_ensureGoalRuntimeActive: () => {},
		_setGoalState: function (this: Harness, goal: unknown) {
			this._goalState = goal as Harness["_goalState"];
		},
		_createPreparedTurnAction: vi.fn((schedule: string, _text: string, _images: unknown, options: unknown) => ({
			schedule,
			options,
		})),
		_admitSessionInput: vi.fn(),
		...overrides,
	};
}

const context = { message: { role: "assistant", stopReason: "stop" }, context: {} };

describe("goal continuation vs unsettled subagent work", () => {
	it("F23 resumes once after ACP MCP close releases the overlapping idle pause", async () => {
		let idle!: () => void;
		let closed!: () => void;
		const idlePromise = new Promise<void>((resolve) => {
			idle = resolve;
		});
		const closePromise = new Promise<{ status: string }>((resolve) => {
			closed = () => resolve({ status: "ok" });
		});
		const mode = Object.assign(
			harness({
				_meshFollowUpPending: true,
				_goalContinuationAwaitsMesh: true,
				agent: { waitForIdle: () => idlePromise },
			}),
			{
				_mcpManager: { canReleaseAcpServers: () => true, replaceAcpServers: () => false },
				_ipythonKernelProvisioner: { manager: { isRunning: true, execute: () => closePromise } },
				acquireSessionInputPause: AgentSession.prototype.acquireSessionInputPause,
				_sessionInputPumpEpoch: 0,
				_notifySessionInputCheckpointChange: () => {},
				_flushDeferredRlmTerminalNotices: () => {},
				_maybeResumeAutonomousContinuationAfterRlmWork: () => {},
				_scheduleSessionInputPump: () => {},
			},
		);
		const closing = AgentSession.prototype.releaseAcpMcpServers.call(mode as unknown as AgentSession, "acp-owner", [
			"server",
		]);
		try {
			setMeshPending.call(mode, false);
			idle();
			await mode._meshGoalResume;
			expect(mode._sessionInputAdmissionPauses.size).toBe(1);
			expect(mode._admitSessionInput).not.toHaveBeenCalled();
			expect(mode._goalState.continuationsUsed).toBe(0);
			closed();
			await closing;
			maybeResume.call(mode);
			expect(mode._sessionInputAdmissionPauses.size).toBe(0);
			expect(mode._admitSessionInput).toHaveBeenCalledTimes(1);
			expect(mode._goalState.continuationsUsed).toBe(1);
		} finally {
			idle();
			closed();
			await closing;
		}
	});

	it("F23 retries a Mesh-idle continuation after atomic admission refuses it", async () => {
		const mode = harness({ _goalContinuationAwaitsMesh: true });
		mode._admitSessionInput.mockImplementationOnce(() => {
			throw new Error("admission race");
		});
		resumeMesh.call(mode);
		await mode._meshGoalResume;
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
		expect(mode._goalState.continuationsUsed).toBe(0);
		expect(mode._finishGoalWithError).not.toHaveBeenCalled();
		maybeResume.call(mode);
		maybeResume.call(mode);
		expect(mode._admitSessionInput).toHaveBeenCalledTimes(2);
		expect(mode._goalState.continuationsUsed).toBe(1);
		expect(mode._goalContinuationAwaitsRlmWork).toBe(false);
	});

	it.each([
		["_hasUnsettledRlmQuiescenceWork", false],
		["_hasUnsettledRlmQuiescenceWork", true],
		["_hasLiveBackgroundBashHandles", false],
		["_hasLiveBackgroundBashHandles", true],
	] as const)("holds Mesh-idle goal continuation for %s (new mail: %s)", async (work, newMail) => {
		const mode = harness({ _meshFollowUpPending: true, _goalContinuationAwaitsMesh: true, [work]: () => true });
		setMeshPending.call(mode, false);
		await mode._meshGoalResume;
		expect(mode._admitSessionInput).not.toHaveBeenCalled();
		expect(mode._goalState.continuationsUsed).toBe(0);
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
		mode[work] = () => false;
		if (newMail) setMeshPending.call(mode, true);
		maybeResume.call(mode);
		if (newMail) {
			expect(mode._admitSessionInput).not.toHaveBeenCalled();
			setMeshPending.call(mode, false);
			await mode._meshGoalResume;
		}
		expect(mode._admitSessionInput).toHaveBeenCalledTimes(1);
		expect(mode._goalState.continuationsUsed).toBe(1);
	});

	it("defers the continuation while descendant work is unsettled", async () => {
		const mode = harness({ _hasUnsettledRlmQuiescenceWork: () => true });
		await expect(getGoalContinuation.call(mode, context)).resolves.toEqual([]);
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
		expect(mode._goalState.continuationsUsed).toBe(0);
	});

	it("continues normally when no descendant work is pending", async () => {
		const mode = harness();
		const messages = await getGoalContinuation.call(mode, context);
		expect(messages).toHaveLength(1);
		expect(mode._goalContinuationAwaitsRlmWork).toBe(false);
		expect(mode._goalState.continuationsUsed).toBe(1);
	});

	it("defers the continuation while a background bash handle runs and keeps the deferral on resume", async () => {
		const mode = harness({ _hasLiveBackgroundBashHandles: () => true });
		await expect(getGoalContinuation.call(mode, context)).resolves.toEqual([]);
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
		expect(mode._goalState.continuationsUsed).toBe(0);
		maybeResume.call(mode);
		expect(mode._admitSessionInput).not.toHaveBeenCalled();
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
	});
	it("resumes a deferred continuation exactly once, unqueued, idle-waking, and counted", () => {
		const mode = harness({ _goalContinuationAwaitsRlmWork: true });
		maybeResume.call(mode);
		maybeResume.call(mode);
		expect(mode._admitSessionInput).toHaveBeenCalledTimes(1);
		const [action, options] = mode._admitSessionInput.mock.calls[0]!;
		expect((action as { options: { resumeIfIdle: boolean } }).options.resumeIfIdle).toBe(true);
		expect(options).toBeUndefined();
		expect(mode._goalState.continuationsUsed).toBe(1);
	});

	it("keeps the deferral while admission is paused and retries after release", () => {
		const paused = harness({
			_goalContinuationAwaitsRlmWork: true,
			_sessionInputAdmissionPauses: new Set([Symbol("pause")]),
		});
		maybeResume.call(paused);
		expect(paused._admitSessionInput).not.toHaveBeenCalled();
		expect(paused._goalContinuationAwaitsRlmWork).toBe(true);

		paused._sessionInputAdmissionPauses.clear();
		maybeResume.call(paused);
		expect(paused._admitSessionInput).toHaveBeenCalledTimes(1);
		expect(paused._goalContinuationAwaitsRlmWork).toBe(false);
	});

	it("keeps the deferral while the pump is suspended after an abort", () => {
		const mode = harness({ _goalContinuationAwaitsRlmWork: true, _sessionInputPumpSuspended: true });
		maybeResume.call(mode);
		expect(mode._admitSessionInput).not.toHaveBeenCalled();
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
	});

	it("keeps the deferral and rolls back the count when admission throws", () => {
		const mode = harness({
			_goalContinuationAwaitsRlmWork: true,
			_admitSessionInput: vi.fn(() => {
				throw new Error("admission race");
			}),
		});
		maybeResume.call(mode);
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
		expect(mode._goalState.continuationsUsed).toBe(0);
	});

	it("stays deferred while work remains and drops the deferral for inactive goals", () => {
		const busy = harness({ _goalContinuationAwaitsRlmWork: true, _hasUnsettledRlmQuiescenceWork: () => true });
		maybeResume.call(busy);
		expect(busy._admitSessionInput).not.toHaveBeenCalled();
		expect(busy._goalContinuationAwaitsRlmWork).toBe(true);

		const inactive = harness({ _goalContinuationAwaitsRlmWork: true });
		inactive._goalState = { status: "paused", objective: "ship it", continuationsUsed: 0 };
		maybeResume.call(inactive);
		expect(inactive._admitSessionInput).not.toHaveBeenCalled();
		expect(inactive._goalContinuationAwaitsRlmWork).toBe(false);
	});
});
