/**
 * Single source of truth for the `#### Reconciliation` directive grammar:
 * parsing and application-classification, shared by the deterministic
 * `reconcile` gate (the sibling reconcile.ts) and skills/_shared/
 * reconcile-lint.mjs — the pre-flight CLI the implement skill runs before
 * finishing a phase (the skill-layer script depends on this extension module,
 * never the reverse). Because both sides import the SAME parser, a
 * directive that lints clean locally parses identically at the gate — the
 * lint's whole guarantee. Pure ESM, node-runnable, no dependencies (the Pi
 * peer dependency is NOT resolvable from a bare `node` invocation, so nothing
 * here may import it).
 *
 * Typed surface for TS consumers lives in reconcile-directives.d.mts.
 */

/**
 * A fence-opening line: optional leading whitespace then 3+ backticks or 3+
 * tildes. Mirrors extensions/rpiv-core/built-ins/markdown-fence.ts (which
 * .mjs cannot import) — the same deliberate mirror stitch-elaborations.mjs
 * carries; CommonMark fence rules are stable, drift is pinned by the shared
 * parser tests exercising fenced directives end to end.
 */
const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})/;

/** Whether `line` CLOSES the fence whose opener recorded `fenceChar`/`fenceLen`:
 *  same char, at least as long, nothing else on the line. */
const closesFence = (line, fence, fenceChar, fenceLen) => {
	const len = fence[1].length;
	return fence[1][0] === fenceChar && len >= fenceLen && line.trim().length === len;
};

/** Directive grammar (inline form), matched against a whole LIST ITEM (which
 *  may span lines — `[^`]` matches `\n`, so a multi-line find/replace snippet
 *  parses as long as it carries no inner backticks):
 *  `` - `<target>`: replace `<find>` → `<replace>` — <rationale> ``.
 *  The arrow is `→` (U+2192) or the ASCII `->`; the em-dash `—` (U+2014) +
 *  rationale is optional and may span lines. The two spans are intentionally
 *  asymmetric and MUST NOT be symmetrized: `find` is one-or-more `[^`]+` (an
 *  empty find has no anchored target and `String.replace("")` prepends the
 *  replacement on every run, so the parser rejects it at parse time), while
 *  `replace` is zero-or-more `[^`]*` (an empty replace is a legitimate
 *  deletion directive). */
const RECONCILE_DIRECTIVE_RE = /^-\s+`([^`]+)`\s*:\s*replace\s+`([^`]+)`\s*(?:→|->)\s*`([^`]*)`\s*(?:—[\s\S]*)?$/;
/** The fenced form's HEADER line — `- `<target>`: replace` with NO inline
 *  spans (an optional `— rationale` tail): the find/replace live in labeled
 *  fenced blocks on the item's continuation lines. The escape hatch for
 *  content a backtick grammar cannot express (inner backticks, template
 *  literals, markdown-in-tests). */
const RECONCILE_BLOCK_HEADER_RE = /^-\s+`([^`]+)`\s*:\s*replace\s*(?:—.*)?$/;
/** A directive ATTEMPT — `- `<target>`:` — that does not match either grammar.
 *  Used to surface a malformed directive as a finding rather than silently
 *  dropping it. */
const RECONCILE_DIRECTIVE_ATTEMPT_RE = /^-\s+`[^`]+`\s*:/;

/**
 * Parse the fenced-form continuation lines of one directive item: a `find:`
 * label line, a fenced code block, a `replace:` label line, a second fenced
 * block. Fence chars/lengths follow CommonMark (`closesFence`); content is
 * dedented by the opening fence line's own indentation so a list-nested block
 * captures the target file's exact bytes. Returns `undefined` when the
 * structure does not complete — the caller degrades to a malformed finding.
 */
const parseFencedSpans = (lines) => {
	const spans = [];
	let i = 0;
	for (const label of ["find:", "replace:"]) {
		while (i < lines.length && lines[i].trim() === "") i++;
		if (lines[i]?.trim() !== label) return undefined;
		i++;
		const open = lines[i] !== undefined ? FENCE_LINE_RE.exec(lines[i]) : null;
		if (!open) return undefined;
		const indent = /^[ \t]*/.exec(lines[i])?.[0] ?? "";
		const fenceChar = open[1][0];
		const fenceLen = open[1].length;
		i++;
		const content = [];
		let closed = false;
		for (; i < lines.length; i++) {
			const close = FENCE_LINE_RE.exec(lines[i]);
			if (close && closesFence(lines[i], close, fenceChar, fenceLen)) {
				closed = true;
				i++;
				break;
			}
			content.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i]);
		}
		if (!closed) return undefined;
		spans.push(content.join("\n"));
	}
	// An empty find is rejected for the same anchorless-`String.replace("")`
	// reason as the inline grammar; an empty replace is a legitimate deletion.
	if (spans[0] === "") return undefined;
	return { find: spans[0], replace: spans[1] };
};

/** Classify one collected list item (header + continuation lines) as a
 *  directive, a malformed attempt (the header line, surfaced), or prose (ignored).
 *
 *  Order and byte discipline are both load-bearing (review 2026-08-31 I4/Q2):
 *  the INLINE grammar runs first, over the RAW joined item — a per-line
 *  `trimEnd` stripped interior-line trailing whitespace from the captured
 *  spans while the applier matches raw file bytes, so a span whose file text
 *  carries line-trailing whitespace could never match (only the whole-item
 *  tail is trimmed, for the `$` anchor). Fenced-header second — trying it
 *  first mis-routed an inline item whose spans start on a continuation line
 *  (header ending at `replace`) into the fenced parser and surfaced a phantom
 *  malformed finding; the reverse mis-route cannot happen because a fenced
 *  item's `find:` label (or `— rationale` tail) sits where the inline grammar
 *  demands a backtick. */
const classifyItem = (lines, out) => {
	const header = lines[0].trimEnd();
	const m = RECONCILE_DIRECTIVE_RE.exec(lines.join("\n").trimEnd());
	if (m) {
		out.directives.push({ target: m[1].trim(), find: m[2], replace: m[3] });
		return;
	}
	const blockHeader = RECONCILE_BLOCK_HEADER_RE.exec(header);
	if (blockHeader) {
		const spans = parseFencedSpans(lines.slice(1));
		if (spans) {
			out.directives.push({ target: blockHeader[1].trim(), find: spans.find, replace: spans.replace });
		} else {
			out.malformed.push(header.trim());
		}
		return;
	}
	if (RECONCILE_DIRECTIVE_ATTEMPT_RE.test(header)) {
		out.malformed.push(header.trim());
	}
};

/**
 * Parse every `#### Reconciliation` directive from a plan body. Returns the
 * well-formed directives AND the malformed attempts (items that carry the
 * `- `<target>`:` shape but neither the inline `replace … → …` grammar nor a
 * complete fenced find:/replace: pair). Prose list items are ignored. Pure:
 * no I/O, no throw.
 *
 * Structure: a section opens at a `#### Reconciliation` heading and closes at
 * the next `#{1,4}` heading (so `### Success Criteria` / `## Phase N:` / a
 * sibling `#### Automated Verification:` all end it) — headings are only
 * recognized OUTSIDE fenced code blocks, so fenced find/replace content that
 * happens to carry `#`-leading lines cannot truncate the section. Within a
 * section, a `- ` line outside a fence starts a new list item; every following
 * line until the next item / section end is that item's continuation (this is
 * what lets a multi-line inline directive parse as one unit).
 */
const reconciliationRecords = (body) => {
	const out = { directives: [], malformed: [] };
	let inSection = false;
	let item;
	let fenceChar = "";
	let fenceLen = 0;
	const flush = () => {
		if (item) classifyItem(item, out);
		item = undefined;
	};
	for (const raw of body.split("\n")) {
		const line = raw.trimEnd();
		if (fenceLen > 0) {
			// Inside a fenced block: only a matching closer changes state; every
			// line (closer included) rides the current item verbatim.
			const close = FENCE_LINE_RE.exec(line);
			if (close && closesFence(line, close, fenceChar, fenceLen)) {
				fenceChar = "";
				fenceLen = 0;
			}
			item?.push(raw);
			continue;
		}
		const open = FENCE_LINE_RE.exec(line);
		if (open) {
			fenceChar = open[1][0];
			fenceLen = open[1].length;
			item?.push(raw);
			continue;
		}
		if (/^####\s+Reconciliation\b/.test(line)) {
			flush();
			inSection = true;
			continue;
		}
		// Any other heading ends the section (the open-heading branch above `continue`s,
		// so this only fires for non-`#### Reconciliation` headings).
		if (/^#{1,4}\s/.test(line)) {
			flush();
			inSection = false;
			continue;
		}
		if (!inSection) continue;
		if (/^-\s/.test(line)) {
			flush();
			item = [raw];
		} else {
			item?.push(raw);
		}
	}
	flush();
	return out;
};

/**
 * Classify what applying `directive` to the target's current `content` would
 * do — the gate's apply-branch decision, factored out so the lint predicts the
 * gate byte-for-byte:
 *
 *  - `"already-applied"` — the replacement is present AND (the find is gone,
 *    or the find only survives because the replacement contains it). The
 *    idempotent-re-run no-op for a substitution: a re-apply on a containment-
 *    shaped directive would compound drift (review 2026-08-31 I1), so this
 *    check runs FIRST.
 *  - `"apply"` — the find is present; `String.replace` would substitute the
 *    FIRST match exactly once.
 *  - `"deletion-satisfied"` — the find is gone and the replacement is empty:
 *    find-absent is the deletion's success condition (a prior apply removed it).
 *  - `"missing"` — the find is absent and the non-empty replacement is also
 *    absent: the directive is stale or authored from memory; the gate emits a
 *    finding (reconcile does not guess).
 */
const classifyApplication = (directive, content) => {
	const applied =
		directive.replace !== "" &&
		content.includes(directive.replace) &&
		(!content.includes(directive.find) || directive.replace.includes(directive.find));
	if (applied) return "already-applied";
	if (content.includes(directive.find)) return "apply";
	if (directive.replace === "") return "deletion-satisfied";
	return "missing";
};

/**
 * Mirror of plan-phases.ts `withTestTwins`: expand a declared write-set with
 * each `.ts/.tsx/.js/.jsx` production file's co-located `.test.*` twin (a file
 * already matching the test suffix maps to itself). Files of any other
 * language pass through untouched — the twin convention is a JS/TS-ecosystem
 * convenience layered on the language-agnostic declared set.
 */
const withTestTwins = (files) => {
	const out = new Set(files);
	for (const f of files) {
		if (/\.test\.[tj]sx?$/.test(f)) continue;
		const twin = f.replace(/\.([tj]sx?)$/, ".test.$1");
		if (twin !== f) out.add(twin);
	}
	return [...out];
};

/**
 * BEST-EFFORT extraction of the plan's declared write-set — the union of every
 * phase's `files:` entries in the leading `---` frontmatter block, twin-
 * expanded (`withTestTwins`) to match the scope floor. The gate derives the
 * authoritative set via Pi's real YAML parser (`planPhaseRecords` +
 * `phaseFiles`), which a bare `node` script cannot import — this line-scan
 * covers the two shapes plans actually carry: block style (`files:` followed
 * by `- path` items) and flow style (`files: ["a", "b"]` inline). Used by
 * reconcile-lint only, for the pre-flight eligibility warning; the gate never
 * calls this.
 */
const declaredWriteSet = (body) => {
	const lines = body.split("\n");
	if (lines[0]?.trim() !== "---") return new Set();
	const files = [];
	let inFilesBlock = false;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "---") break;
		const flow = /(?:^|\s)files:\s*\[([^\]]*)\]/.exec(line);
		if (flow) {
			inFilesBlock = false;
			for (const part of flow[1].split(",")) {
				const f = part.trim().replace(/^["']|["']$/g, "");
				if (f) files.push(f);
			}
			continue;
		}
		if (/(?:^|\s)files:\s*$/.test(line)) {
			inFilesBlock = true;
			continue;
		}
		if (inFilesBlock) {
			const item = /^\s+-\s+(.+)$/.exec(line);
			if (item) {
				files.push(item[1].trim().replace(/^["']|["']$/g, ""));
				continue;
			}
			inFilesBlock = false;
		}
	}
	return new Set(withTestTwins(files));
};

/**
 * Slice one `## Phase <n>:` section out of a plan body (heading line included,
 * ending at the next `## `-level heading), recognizing headings only OUTSIDE
 * fenced code blocks — a plan phase embedding a markdown fixture must not
 * truncate the section (the fence-aware discipline every plan scan shares).
 * Returns `undefined` when the phase heading is absent.
 */
const phaseSection = (body, n) => {
	const headingRe = new RegExp(`^##\\s+Phase\\s+${n}\\b`);
	const collected = [];
	let inPhase = false;
	let found = false;
	let fenceChar = "";
	let fenceLen = 0;
	for (const raw of body.split("\n")) {
		const line = raw.trimEnd();
		const fence = FENCE_LINE_RE.exec(line);
		if (fenceLen > 0) {
			if (fence && closesFence(line, fence, fenceChar, fenceLen)) {
				fenceChar = "";
				fenceLen = 0;
			}
			if (inPhase) collected.push(raw);
			continue;
		}
		if (fence) {
			fenceChar = fence[1][0];
			fenceLen = fence[1].length;
			if (inPhase) collected.push(raw);
			continue;
		}
		if (headingRe.test(line)) {
			inPhase = true;
			found = true;
			collected.push(raw);
			continue;
		}
		if (inPhase && /^##\s/.test(line) && !/^###/.test(line)) {
			inPhase = false;
			continue;
		}
		if (inPhase) collected.push(raw);
	}
	return found ? collected.join("\n") : undefined;
};

export { classifyApplication, declaredWriteSet, phaseSection, reconciliationRecords };
