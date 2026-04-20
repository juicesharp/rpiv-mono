import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { expect } from "vitest";
import { createMockPi } from "./pi.js";

export interface ToolContract {
	name: string;
	requiredFields: string[];
	optionalFields?: string[];
}

export function assertToolContract(tool: ToolDefinition, expected: ToolContract): void {
	expect(tool.name).toBe(expected.name);
	expect(typeof tool.description).toBe("string");
	expect(tool.description.length).toBeGreaterThan(0);
	expect(typeof tool.execute).toBe("function");

	const params = tool.parameters as unknown as {
		type?: string;
		required?: string[];
		properties?: Record<string, unknown>;
	};
	expect(params.type).toBe("object");

	const required = new Set(params.required ?? []);
	expect(required).toEqual(new Set(expected.requiredFields));

	if (expected.optionalFields) {
		const properties = new Set(Object.keys(params.properties ?? {}));
		for (const field of expected.optionalFields) {
			expect(properties.has(field)).toBe(true);
		}
	}
}

export async function describeRegisteredTools(
	factory: (pi: ReturnType<typeof createMockPi>["pi"]) => void | Promise<void>,
): Promise<ToolDefinition[]> {
	const { pi, captured } = createMockPi();
	await factory(pi);
	return [...captured.tools.values()];
}

export interface BranchRoundTripSpec<TDetails> {
	reset: () => void;
	snapshot: () => unknown;
	replay: (
		entries: Array<{
			type: "message";
			message: { role: "toolResult"; toolName: string; details: TDetails };
		}>,
	) => void | Promise<void>;
	toolName: string;
	details: TDetails[];
}

export async function roundTripBranchState<TDetails>(spec: BranchRoundTripSpec<TDetails>): Promise<{
	before: unknown;
	after: unknown;
}> {
	spec.reset();
	const before = spec.snapshot();
	const entries = spec.details.map((details) => ({
		type: "message" as const,
		message: { role: "toolResult" as const, toolName: spec.toolName, details },
	}));
	spec.reset();
	await spec.replay(entries);
	const after = spec.snapshot();
	return { before, after };
}
