/**
 * Conservative structural compatibility of JSON Schema producer → consumer.
 *
 * The bridge + introspection helpers stay in json-schema.ts; this module owns
 * the compat engine and nothing else. The engine
 * flags DEFINITE mismatches (no false positives) — everything else returns
 * `{ ok: true }` (not provably incompatible).
 *
 * NOTE: the closed-object rule rarely fires for TypeBox/harvested schemas
 * (`Type.Object` doesn't emit `additionalProperties: false`); it's reachable
 * mainly for hand-authored frontmatter that explicitly closes the object. The
 * per-field type/enum/const rules are what catch most real producer↔consumer drift.
 */

import { deepEqual } from "./internal-utils.js";
import type { JsonSchemaObject } from "./json-schema.js";
import type { SchemaCompatResult } from "./skill-contract.js";

/** The set of JSON-Schema `type`s a schema allows (string or string[]), or undefined if untyped. */
function typeSet(schema: JsonSchemaObject): Set<string> | undefined {
	const t = schema.type;
	if (typeof t === "string") return new Set([t]);
	if (Array.isArray(t) && t.every((x) => typeof x === "string")) return new Set(t as string[]);
	return undefined;
}

/** Two sets share no member. */
function disjoint(a: ReadonlySet<unknown>, b: ReadonlySet<unknown>): boolean {
	for (const x of a) if (b.has(x)) return false;
	return true;
}

/** `integer` is a subtype of `number` — widen so the two never read as disjoint. */
function widenNumeric(s: Set<string>): Set<string> {
	return s.has("integer") ? new Set([...s, "number"]) : s;
}

/**
 * Rule 1 — a producer that CLOSES its object (`additionalProperties: false`) and
 * omits a field the consumer `requires` provably never emits it. `undefined` when
 * the producer is open or emits every required field.
 */
function closedProducerOmitsRequired(
	producer: JsonSchemaObject,
	producerProps: Record<string, JsonSchemaObject>,
	required: readonly string[],
): SchemaCompatResult | undefined {
	if (producer.additionalProperties !== false) return undefined;
	for (const key of required) {
		if (!(key in producerProps)) {
			return { ok: false, reason: `consumer requires "${key}" but producer (closed object) never emits it` };
		}
	}
	return undefined;
}

/** Rule 2 — producer and consumer pin disjoint `type` sets for the shared field. */
function fieldTypeConflict(key: string, p: JsonSchemaObject, c: JsonSchemaObject): SchemaCompatResult | undefined {
	const pt = typeSet(p);
	const ct = typeSet(c);
	if (pt && ct && disjoint(widenNumeric(pt), widenNumeric(ct))) {
		return {
			ok: false,
			reason: `field "${key}": producer emits ${[...pt].join("|")} but consumer expects ${[...ct].join("|")}`,
		};
	}
	return undefined;
}

/** Rule 3 — producer and consumer both restrict to `enum`, and the two enums are disjoint. */
function fieldEnumConflict(key: string, p: JsonSchemaObject, c: JsonSchemaObject): SchemaCompatResult | undefined {
	if (!Array.isArray(p.enum) || !Array.isArray(c.enum)) return undefined;
	const pe = new Set(p.enum.map((v) => JSON.stringify(v)));
	const ce = new Set(c.enum.map((v) => JSON.stringify(v)));
	if (disjoint(pe, ce)) return { ok: false, reason: `field "${key}": producer enum is disjoint from consumer enum` };
	return undefined;
}

/**
 * Rule 4 — producer and consumer both pin a `const`, and the two constants
 * differ. Compares with `deepEqual` (key-order-independent) to match the
 * `registerSkillContracts` collision check (registry.ts) — `JSON.stringify`
 * is insertion-order dependent, so `{ a, b }` vs `{ b, a }` would register as
 * identical yet read as incompatible here.
 */
function fieldConstConflict(key: string, p: JsonSchemaObject, c: JsonSchemaObject): SchemaCompatResult | undefined {
	if ("const" in p && "const" in c && !deepEqual(p.const, c.const)) {
		return {
			ok: false,
			reason: `field "${key}": producer const ${JSON.stringify(p.const)} ≠ consumer const ${JSON.stringify(c.const)}`,
		};
	}
	return undefined;
}

/**
 * Conservative structural compatibility of a producer's output schema against a
 * consumer's input schema. Deliberately NOT a full JSON-Schema subtype engine —
 * it only flags DEFINITE mismatches (no false positives). For each field present
 * in BOTH `properties` it reports a conflict when:
 *   1. their allowed `type` sets are disjoint — covers `type` arrays like
 *      `["string","null"]`, and treats `integer` as a `number` so `integer`↔
 *      `number` is never falsely flagged;
 *   2. both restrict to an `enum` and the two enums are disjoint (by JSON value)
 *      — the producer can only emit values the consumer never accepts;
 *   3. both pin a `const` and the two constants differ (by JSON value).
 * Plus: a CLOSED producer object (`additionalProperties: false`) that omits a
 * field the consumer `requires` — provably never emitted. Everything else (open
 * producers, untyped fields, nested objects, `$ref`, oneOf/anyOf) returns
 * `{ ok: true }` — not provably incompatible. Non-object roots aren't compared.
 */
export function isSchemaCompatible(producer: JsonSchemaObject, consumer: JsonSchemaObject): SchemaCompatResult {
	if (producer.type !== "object" || consumer.type !== "object") {
		// Non-object roots: compare root type when both sides declare one.
		// Scalars like { type: "string" } vs { type: "array" } are provably
		// incompatible; when either side omits `type`, degrade to ok (unprovable).
		if (typeof producer.type === "string" && typeof consumer.type === "string" && producer.type !== consumer.type) {
			return {
				ok: false,
				reason: `root type mismatch: producer is "${producer.type}", consumer is "${consumer.type}"`,
			};
		}
		return { ok: true };
	}
	const producerProps = (producer.properties as Record<string, JsonSchemaObject> | undefined) ?? {};
	const consumerProps = (consumer.properties as Record<string, JsonSchemaObject> | undefined) ?? {};
	const required = Array.isArray(consumer.required) ? (consumer.required as string[]) : [];

	const omission = closedProducerOmitsRequired(producer, producerProps, required);
	if (omission) return omission;

	for (const key of Object.keys(consumerProps)) {
		const p = producerProps[key];
		const c = consumerProps[key];
		if (!p || !c) continue;
		const conflict = fieldTypeConflict(key, p, c) ?? fieldEnumConflict(key, p, c) ?? fieldConstConflict(key, p, c);
		if (conflict) return conflict;
	}
	return { ok: true };
}
