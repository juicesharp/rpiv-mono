/**
 * Artifact handle — the storage-agnostic reference a collector emits and
 * a parser consumes. Tagged union so collectors / parsers narrow
 * structurally (`if (h.kind === "fs") fs.readFile(h.path)`); plain
 * `string` would force a parse on every consumer.
 *
 * Four built-in kinds cover the practical universe:
 *   - `fs`     — cwd-relative or absolute filesystem path.
 *   - `url`    — RFC-3986 reference (https, file://, custom scheme).
 *   - `opaque` — external system id (Linear ticket, S3 key, commit SHA).
 *   - `inline` — bytes the collector gathered directly (rare; useful for
 *                a binary the consumer wants without an fs round-trip).
 *
 * Authors who need a kind not in this list write a custom collector that
 * emits `opaque` and a custom parser that knows how to dereference it.
 */
export type ArtifactHandle =
	| { kind: "fs"; path: string }
	| { kind: "url"; href: string }
	| { kind: "opaque"; id: string }
	| { kind: "inline"; bytes: Uint8Array; mime?: string };

/**
 * One artifact a stage produced. The handle is the storage reference;
 * `role` is an optional user-facing label (`"primary"`, `"patch"`,
 * `"log"`) downstream stages can route on; `meta` carries any
 * collector-attached hints the matching parser needs.
 *
 * The framework reads `artifacts[0]` as the "primary" artifact for chain
 * inheritance (side-effect stages without their own artifacts inherit the
 * upstream list forward). `role` is metadata only — the framework does
 * not gate on it.
 */
export interface Artifact {
	handle: ArtifactHandle;
	role?: string;
	meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Handle constructors — eliminate kind-literal boilerplate at collector
// call sites. `fs(path)` reads cleaner than `{ kind: "fs", path }` and
// keeps the discriminator value in one place.
// ---------------------------------------------------------------------------

export const fs = (path: string): ArtifactHandle => ({ kind: "fs", path });
export const url = (href: string): ArtifactHandle => ({ kind: "url", href });
export const opaque = (id: string): ArtifactHandle => ({ kind: "opaque", id });
export const inline = (bytes: Uint8Array, mime?: string): ArtifactHandle =>
	mime !== undefined ? { kind: "inline", bytes, mime } : { kind: "inline", bytes };

/**
 * Serialise a handle to a human-readable string — used by the runner
 * when threading the primary artifact into a downstream stage's prompt
 * input (the prompt is plain text; URLs / paths / opaque ids all have a
 * natural one-line form). Inline handles serialise to their byte length
 * since their content isn't meaningfully promptable.
 */
export function handleToString(h: ArtifactHandle): string {
	switch (h.kind) {
		case "fs":
			return h.path;
		case "url":
			return h.href;
		case "opaque":
			return h.id;
		case "inline":
			return `inline:${h.bytes.byteLength}b${h.mime ? `;${h.mime}` : ""}`;
	}
}
