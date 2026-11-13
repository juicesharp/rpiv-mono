import { describe, expect, expectTypeOf, it } from "vitest";
import { type TaskAction, type TaskStatus, type TodoParams, TodoParamsSchema } from "./types.ts";

// Pi 1.5 changed pi-ai's `StringEnum` to return its own schema type, which typebox's `Static`
// reads as `unknown`: `params.action` stopped type-checking in the tool's `execute`.
describe("TodoParamsSchema string enums", () => {
	it("type the enum fields as their literal unions", () => {
		expectTypeOf<TodoParams["action"]>().toEqualTypeOf<TaskAction>();
		expectTypeOf<NonNullable<TodoParams["status"]>>().toEqualTypeOf<TaskStatus>();
	});

	it("send providers a plain string enum, with no anyOf or const", () => {
		const { action, status } = TodoParamsSchema.properties;
		for (const [schema, values] of [
			[action, ["create", "update", "list", "get", "delete", "clear"]],
			[status, ["pending", "in_progress", "completed", "deleted"]],
		] as const) {
			const json = JSON.parse(JSON.stringify(schema));
			expect(json).toMatchObject({ type: "string", enum: values });
			expect(json).not.toHaveProperty("anyOf");
			expect(json).not.toHaveProperty("const");
		}
		expect(JSON.parse(JSON.stringify(status)).description).toMatch(/^Set this task's status/);
	});
});
