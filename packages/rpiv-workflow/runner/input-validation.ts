/** EA research candidate: validator exceptions fail closed.
 * A missing contract/data channel is still outside this check's coverage.
 * Named-channel and prompt dispatch rules are unchanged from the pinned source.
 */
import { formatError, withTimeout } from "../internal-utils.js";
import { isJsonSchemaObject, jsonSchemaToStandard } from "../json-schema.js";
import { ERR_SCHEMA_TIMEOUT, FAIL_INPUT_VALIDATION } from "../messages.js";
import type { RunContext } from "../types.js";
import {
	DEFAULT_VALIDATION_RETRY_TIMEOUT_MS,
	describeFailure,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	MIN_VALIDATION_RETRY_TIMEOUT_MS,
	type ValidationResult,
	validateOutputData,
} from "../validate-output.js";
import { clampRange } from "../validation-bounds.js";
import { haltPreflight } from "./errors.js";
import type { ResolvedStage } from "./resolve-stage.js";

async function validateOrThrow(
	schema: Parameters<typeof validateOutputData>[0],
	data: unknown,
	stage: ResolvedStage,
	prevSkill: string,
	timeoutMs: number,
): Promise<void> {
	let result: ValidationResult;
	try {
		result = await withTimeout(
			Promise.resolve(validateOutputData(schema, data)),
			timeoutMs,
			ERR_SCHEMA_TIMEOUT("inputSchema", timeoutMs),
		);
	} catch (error) {
		throw haltPreflight(stage.skill, FAIL_INPUT_VALIDATION(stage.skill, prevSkill, formatError(error)));
	}
	if (!result.valid)
		throw haltPreflight(
			stage.skill,
			FAIL_INPUT_VALIDATION(stage.skill, prevSkill, result.failures.map(describeFailure).join("; ")),
		);
}

function clampValidateTimeoutMs(raw: number | undefined): number {
	return clampRange(
		raw,
		MIN_VALIDATION_RETRY_TIMEOUT_MS,
		DEFAULT_VALIDATION_RETRY_TIMEOUT_MS,
		MAX_VALIDATION_RETRY_TIMEOUT_MS,
	);
}

export async function ensureInputValid(stage: ResolvedStage, run: RunContext): Promise<void> {
	if (!stage.def.inputSchema || run.state.output?.data === undefined) return;
	await validateOrThrow(
		stage.def.inputSchema,
		run.state.output.data,
		stage,
		run.state.output.meta.stage || "unknown",
		clampValidateTimeoutMs(stage.def.validateTimeoutMs),
	);
}

export async function ensureContractInputValid(stage: ResolvedStage, run: RunContext): Promise<void> {
	if (stage.def.prompt !== undefined || stage.def.inputSchema || stage.def.reads?.length) return;
	const consumesData = run.skillContracts?.get(stage.skill)?.consumes?.data;
	// A genuinely absent contract remains optional. A present but invalid one is not absent.
	if (consumesData === undefined) return;
	if (!isJsonSchemaObject(consumesData))
		throw haltPreflight(
			stage.skill,
			FAIL_INPUT_VALIDATION(stage.skill, "contract", "invalid declared consumes.data schema"),
		);
	if (run.state.output?.data === undefined) return;
	await validateOrThrow(
		jsonSchemaToStandard(consumesData),
		run.state.output.data,
		stage,
		run.state.output.meta.stage || "unknown",
		clampValidateTimeoutMs(stage.def.validateTimeoutMs),
	);
}
