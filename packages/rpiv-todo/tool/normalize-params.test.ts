import { describe, expect, it } from "vitest";
import { prepareTodoArguments } from "./normalize-params.ts";

describe("prepareTodoArguments — double-encoded tasks[] (#244 shape)", () => {
	it("decodes tasks sent as a JSON string", () => {
		expect(prepareTodoArguments({ action: "create", tasks: '[{"subject":"a"},{"subject":"b"}]' })).toEqual({
			action: "create",
			tasks: [{ subject: "a" }, { subject: "b" }],
		});
	});

	it("decodes items sent as JSON strings", () => {
		expect(prepareTodoArguments({ action: "create", tasks: ['{"subject":"a"}', { subject: "b" }] })).toEqual({
			action: "create",
			tasks: [{ subject: "a" }, { subject: "b" }],
		});
	});

	it("returns well-formed arguments as-is", () => {
		const args = { action: "create", tasks: [{ subject: "a" }] };
		expect(prepareTodoArguments(args)).toBe(args);
		const single = { action: "create", subject: "a" };
		expect(prepareTodoArguments(single)).toBe(single);
	});

	it("leaves strings that are not the expected shape for validation to report", () => {
		expect(prepareTodoArguments({ action: "create", tasks: "not json" })).toEqual({
			action: "create",
			tasks: "not json",
		});
		expect(prepareTodoArguments({ action: "create", tasks: ['"just a string"'] })).toEqual({
			action: "create",
			tasks: ['"just a string"'],
		});
	});
});
