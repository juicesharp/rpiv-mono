import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Sub-agent EventBus payload schemas
//
// The sub-agent bus is an untyped channel — handlers used to cast payloads to
// `Record<string, unknown>` and coerce fields via `String(...)` / `Number(...)`.
// These schemas validate the payload at the boundary; the dispatcher only sees
// well-formed events. Malformed payloads are dropped with a single warning.
// ---------------------------------------------------------------------------

export const SubAgentCreatedPayloadSchema = Type.Object({
	id: Type.String(),
	type: Type.String(),
	description: Type.Optional(Type.String()),
	isBackground: Type.Optional(Type.Boolean()),
});
export type SubAgentCreatedPayload = Static<typeof SubAgentCreatedPayloadSchema>;

export const SubAgentStartedPayloadSchema = Type.Object({
	id: Type.String(),
	type: Type.String(),
});
export type SubAgentStartedPayload = Static<typeof SubAgentStartedPayloadSchema>;

const SubAgentTokensSchema = Type.Object({
	input: Type.Optional(Type.Number()),
	output: Type.Optional(Type.Number()),
	total: Type.Optional(Type.Number()),
});

export const SubAgentCompletedPayloadSchema = Type.Object({
	id: Type.String(),
	status: Type.Optional(Type.String()),
	result: Type.Optional(Type.String()),
	durationMs: Type.Number(),
	tokens: Type.Optional(SubAgentTokensSchema),
	toolUses: Type.Optional(Type.Number()),
});
export type SubAgentCompletedPayload = Static<typeof SubAgentCompletedPayloadSchema>;

export const SubAgentFailedPayloadSchema = Type.Object({
	id: Type.String(),
	status: Type.Optional(Type.String()),
	error: Type.String(),
	durationMs: Type.Number(),
});
export type SubAgentFailedPayload = Static<typeof SubAgentFailedPayloadSchema>;

export const SubAgentCompactedPayloadSchema = Type.Object({
	id: Type.String(),
	type: Type.String(),
	reason: Type.Optional(Type.String()),
	tokensBefore: Type.Optional(Type.Number()),
	compactionCount: Type.Optional(Type.Number()),
});
export type SubAgentCompactedPayload = Static<typeof SubAgentCompactedPayloadSchema>;

export const SubAgentSteeredPayloadSchema = Type.Object({
	id: Type.String(),
	message: Type.String(),
});
export type SubAgentSteeredPayload = Static<typeof SubAgentSteeredPayloadSchema>;
