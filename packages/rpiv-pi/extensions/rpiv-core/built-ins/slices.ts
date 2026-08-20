/**
 * The slice-map grammar and slice-DAG layer: frontmatter parsing, dependency
 * edges, clustering, coverage units, and the design/subplan fanouts built on
 * them.
 */
import { basename } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { fanout, handleToString, type RunView } from "@juicesharp/rpiv-workflow/registration";
import { countHeadingsOutsideFences } from "./markdown-fence.js";
import { haltPreflight, latestFsArtifact, MAX_PHASES, type PhaseRecord, readArtifactFile } from "./shared.js";

/** `## Slice N:` headings — the source of truth a slice map's `slices:` array is derived from. */
const SLICE_HEADING_RE = /^## Slice (\d+):/gm;

/**
 * Parse a slice map's `slices:` frontmatter into `{ n, title }` records,
 * derive-checked against the body's `## Slice N:` headings and the required
 * `slice_count` scalar — the slices twin of `planPhaseRecords`. A mismatch means
 * the producer's rebuild was skipped or the array went stale; throw rather than
 * dispatch a wrong unit list.
 */
const sliceRecords = (content: string, who: string, path: string): readonly PhaseRecord[] => {
	const { frontmatter } = parseFrontmatter(content);
	const fm = frontmatter as Record<string, unknown>;
	const raw = fm.slices;
	const slices = Array.isArray(raw) ? raw : [];
	const headingCount = countHeadingsOutsideFences(content, SLICE_HEADING_RE);
	if (slices.length !== headingCount) {
		throw haltPreflight(
			who,
			`${who}: slice map ${path} has mismatched slices`,
			`${who}: slice map ${path} frontmatter slices (${slices.length}) ≠ '## Slice N:' headings (${headingCount}) — the derived array is stale against the body`,
		);
	}
	if ((slices.length > 0 || fm.slice_count !== undefined) && fm.slice_count !== slices.length) {
		throw haltPreflight(
			who,
			`${who}: slice map ${path} has invalid slice_count`,
			`${who}: slice map ${path} frontmatter slice_count (${String(fm.slice_count)}) ≠ slices length (${slices.length}) — rebuild slice_count from the '## Slice N:' headings`,
		);
	}
	return slices.map((entry, index) => {
		const e = (entry ?? {}) as Record<string, unknown>;
		return {
			entry: e,
			n: typeof e.n === "number" ? e.n : index + 1,
			title: typeof e.title === "string" ? e.title : "",
			index,
			total: slices.length,
		};
	});
};

/** The slice-number deps a slice-map entry declares (empty when absent). */
const sliceDeps = (entry: Record<string, unknown>): number[] => {
	const raw = entry.deps;
	return Array.isArray(raw) ? raw.filter((d): d is number => typeof d === "number") : [];
};

/** Fan `design-slice` out over the latest slice map's `slices:` array — one design
 *  session per slice, dependency-ordered. `deps` (slice-N unit ids) drive the wave
 *  scheduler; `depArtifactFlag` injects each completed dependency's design path as
 *  `--upstream <path>` so a dependent slice reads its dependency's decided Key Interfaces. */
const SLICE_DESIGN_FANOUT = fanout({
	source: "slices",
	unit: { by: "frontmatter-array", pattern: "slices" },
	max: MAX_PHASES,
	depArtifactFlag: "--upstream",
	units: ({ state, cwd }) => {
		const doc = latestFsArtifact(state, "slices");
		if (doc?.handle.kind !== "fs") return [];
		const path = doc.handle.path;
		const promptPath = handleToString(doc.handle);
		return sliceRecords(readArtifactFile(path, cwd), "SLICE_DESIGN_FANOUT", path).map((r) => ({
			prompt: `${promptPath} Slice ${r.n}: ${r.title}`.trimEnd(),
			label: `slice ${r.index + 1}/${r.total}`,
			id: `slice-${r.n}`,
			deps: sliceDeps(r.entry).map((n) => `slice-${n}`), // directed edges → unit ids (slice-N)
		}));
	},
});

/** Max slices per synth cluster — a context-budget proxy; oversized DAG components split by this. */
const MAX_CLUSTER_SLICES = 6;

/**
 * Group slices into clusters = connected components of the `deps` DAG (a slice
 * and everything it transitively depends on / that depends on it land together),
 * so coupled slices reconcile inside ONE subplan pass and only cross-cluster
 * seams reach the root. Components larger than `MAX_CLUSTER_SLICES` are chunked
 * (by slice number) to bound each pass's context. Returns clusters of slice
 * numbers, each sorted ascending; components ordered by their smallest slice.
 */
const clusterSliceDag = (records: readonly PhaseRecord[]): number[][] => {
	const ns = records.map((r) => r.n);
	const parent = new Map<number, number>(ns.map((n) => [n, n]));
	const find = (x: number): number => {
		let root = x;
		while (parent.get(root) !== root) root = parent.get(root) ?? root;
		let cur = x;
		while (parent.get(cur) !== root) {
			const next = parent.get(cur) ?? root;
			parent.set(cur, root);
			cur = next;
		}
		return root;
	};
	const union = (a: number, b: number): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};
	for (const r of records) for (const d of sliceDeps(r.entry)) if (parent.has(d)) union(r.n, d);
	const byRoot = new Map<number, number[]>();
	for (const n of ns) {
		const root = find(n);
		const arr = byRoot.get(root);
		if (arr) arr.push(n);
		else byRoot.set(root, [n]);
	}
	const clusters: number[][] = [];
	for (const comp of [...byRoot.values()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))) {
		const sorted = [...comp].sort((a, b) => a - b);
		for (let i = 0; i < sorted.length; i += MAX_CLUSTER_SLICES) {
			clusters.push(sorted.slice(i, i + MAX_CLUSTER_SLICES));
		}
	}
	return clusters;
};

/**
 * A directed dependency cycle in the slice DAG (`A→B→…→A`), returned as the slice
 * numbers on the cycle; empty when acyclic. `clusterSliceDag` groups by the
 * UNDIRECTED connected component, which a directed cycle survives — so the
 * design-readiness gate needs this separate directed check. A cycle is the true
 * independence defect (slices in a cycle cannot be designed independently); the
 * deterministic floor catches it without an LLM coin-flip.
 */
const sliceDepCycle = (records: readonly PhaseRecord[]): number[] => {
	const deps = new Map<number, number[]>(records.map((r) => [r.n, sliceDeps(r.entry)]));
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map<number, number>();
	const stack: number[] = [];
	let cycle: number[] = [];
	const visit = (n: number): boolean => {
		color.set(n, GRAY);
		stack.push(n);
		for (const d of deps.get(n) ?? []) {
			if (!deps.has(d)) continue; // a dangling dep is a derive/numbering concern, not a cycle
			const c = color.get(d) ?? WHITE;
			if (c === GRAY) {
				cycle = stack.slice(stack.indexOf(d));
				return true;
			}
			if (c === WHITE && visit(d)) return true;
		}
		stack.pop();
		color.set(n, BLACK);
		return false;
	};
	for (const r of records) if ((color.get(r.n) ?? WHITE) === WHITE && visit(r.n)) break;
	return cycle;
};

/**
 * One frozen coverage unit — the brief's ID'd decomposition, set once at the
 * first (human-confirmed) cut and conserved across every reslice. The conserved
 * quantity the gate was missing: a reslice may REDISTRIBUTE units across slices,
 * never DROP one — which is what closes the "pass by simplifying / shrinking
 * scope" escape hatch the sizing dimensions can't see.
 */
interface CoverageUnit {
	id: string;
	brief: string;
}

/** Parse a slice map's `coverage:` frontmatter into `{ id, brief }` units (empty when absent). */
const sliceCoverageUnits = (content: string): CoverageUnit[] => {
	const { frontmatter } = parseFrontmatter(content);
	const raw = (frontmatter as Record<string, unknown>).coverage;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((e) => {
		const o = (e ?? {}) as Record<string, unknown>;
		return typeof o.id === "string" ? [{ id: o.id, brief: typeof o.brief === "string" ? o.brief : "" }] : [];
	});
};

/** The coverage-unit ids a slice entry claims to deliver (its `covers:` array). */
const sliceCovers = (entry: Record<string, unknown>): string[] => {
	const raw = entry.covers;
	return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
};

/** A design filename encodes its slice as `…slice-<N>…` — the design-fanout naming convention. */
const DESIGN_SLICE_RE = /slice-(\d+)/;

/**
 * Map slice number → its design artifact path, from the design fanout's published
 * outputs. An identity resolver: it maps an ARTIFACT to a slice NUMBER. It FAILS
 * LOUD only when identity is genuinely UNRESOLVABLE — a design filename that
 * carries no `slice-<N>` token, where a positional `idx + 1` guess would scramble
 * the cluster→design wiring and drop slices.
 *
 * A slice claimed by MORE THAN ONE output is NOT ambiguous: the `designs` channel
 * legitimately accumulates several entries per slice — `slice-design` emits it,
 * then `design-review` re-emits the accepted/edited design on the SAME channel
 * (its documented "latest-wins, same paths" contract, so `subplan`/`synthesize`
 * read the accepted docs). So the newest entry wins, deterministically — throwing
 * on a duplicate would halt every normal run at `subplan`. (The resume re-dispatch
 * that once left CONFLICTING designs on the channel is fixed at its source,
 * so there is no corruption left to fail loud on here.)
 */
const designPathsBySlice = (state: RunView): Map<number, string> => {
	const bySlice = new Map<number, string>();
	for (const out of state.named.designs ?? []) {
		for (const a of out.artifacts) {
			if (a.handle.kind !== "fs") continue;
			const name = basename(a.handle.path);
			const match = DESIGN_SLICE_RE.exec(name);
			if (!match) {
				throw haltPreflight(
					"designPathsBySlice",
					`designPathsBySlice: design ${name} has no slice number`,
					`designPathsBySlice: design artifact ${a.handle.path} carries no 'slice-<N>' token — cannot resolve which slice it designs; a positional guess would mis-route the cluster→design mapping and drop slices`,
				);
			}
			// Latest design per slice wins — the channel holds multiple entries per
			// slice by design (design-review re-emits), and the newest is authoritative.
			bySlice.set(Number(match[1]), handleToString(a.handle));
		}
	}
	return bySlice;
};

/**
 * Fan `subplan` out over slice-DAG clusters. Each unit merges ONE cluster's
 * per-slice designs into a sub-plan (`--as-subplan`), so no single pass holds
 * every design — the context-bounding twin of the flat fan-in `synthesize`.
 */
const SYNTH_CLUSTER_FANOUT = fanout({
	source: "designs",
	unit: { by: "slice-dag-cluster", pattern: "clusters" },
	max: MAX_PHASES,
	units: ({ state, cwd }) => {
		const doc = latestFsArtifact(state, "slices");
		if (doc?.handle.kind !== "fs") return [];
		const records = sliceRecords(readArtifactFile(doc.handle.path, cwd), "SYNTH_CLUSTER_FANOUT", doc.handle.path);
		const designBySlice = designPathsBySlice(state);
		// Thread the research the slices rest on into every cluster's subplan pass,
		// so cross-slice constraints and acceptance criteria reach synthesis DIRECTLY
		// (not only via each design's refraction). `synthesize` accepts `--research`
		// in partial mode; the flat `synthesize` fan-in already received it, but the
		// hierarchical cluster fanout dropped it.
		const research = latestFsArtifact(state, "research");
		const researchFlag = research?.handle.kind === "fs" ? ` --research ${handleToString(research.handle)}` : "";
		return clusterSliceDag(records)
			.map((cluster, i) => {
				const designs = cluster
					.map((n) => designBySlice.get(n))
					.filter((p): p is string => p !== undefined)
					.map((p) => `--designs ${p}`);
				if (!designs.length) return undefined;
				return {
					// Stamp each cluster's ordinal into its prompt so the partial-mode pass
					// writes a distinct `_cluster-<k>.md` — a re-dispatched unit must never
					// reuse a sibling's filename and clobber it. `<k>` matches `id: cluster-<k>`.
					prompt: `${designs.join(" ")}${researchFlag} --cluster ${i + 1} --as-subplan`,
					label: `cluster ${i + 1} (slices ${cluster.join(",")})`,
					id: `cluster-${i + 1}`,
				};
			})
			.filter((u): u is { prompt: string; label: string; id: string } => u !== undefined);
	},
});

export {
	clusterSliceDag,
	DESIGN_SLICE_RE,
	designPathsBySlice,
	SLICE_DESIGN_FANOUT,
	SYNTH_CLUSTER_FANOUT,
	sliceCoverageUnits,
	sliceCovers,
	sliceDepCycle,
	sliceRecords,
};
