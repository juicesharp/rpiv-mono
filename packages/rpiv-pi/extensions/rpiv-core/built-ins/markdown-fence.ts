/**
 * A fence-opening line: optional leading whitespace then 3+ backticks or 3+
 * tildes (the CommonMark info-string delimiter). Single source of truth every
 * fence-aware scan shares.
 */
const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * Whether `line` CLOSES the fence whose opener recorded `fenceChar` and
 * `fenceLen`. CommonMark: a closing fence uses the SAME char (``` ``` ``` does not
 * close `~~~`) and is at least as long (a 4-backtick opener needs 4+ to close),
 * with only that char plus optional trailing whitespace on the line. `fence` is
 * the current line's `RegExpExecArray` match (narrowed from the guarded
 * `.exec()` result).
 */
const closesFence = (line: string, fence: RegExpExecArray, fenceChar: string, fenceLen: number): boolean => {
	const len = fence[1].length;
	return fence[1][0] === fenceChar && len >= fenceLen && line.trim().length === len;
};

/**
 * Visit every line of `content` that sits OUTSIDE fenced code blocks, calling
 * `visit(line, index)` with the line text and its 0-based index in
 * `content.split("\n")`. A `## Phase N:` / `## Slice N:` / `### Phase N —` / a
 * `#### N. path` inside a ``` or ~~~ fence is example/fixture text — a meta-plan
 * (one whose subject is the pipeline) legitimately embeds the pipeline's own
 * plan/slice fixtures — not a structural heading or declared write, so a naive
 * line scan would false-count it. Mirrors the fence-aware boundary scan in
 * skills/_shared/stitch-elaborations.mjs. Fence-opener and fence-closer lines
 * are skipped (never visited); `index` advances once per line (including skipped
 * fence lines) so it stays aligned with any caller's own `content.split("\n")`
 * array.
 */
const forEachLineOutsideFences = (content: string, visit: (line: string, index: number) => void): void => {
	let inFence = false;
	let fenceLen = 0;
	let fenceChar = "";
	let index = 0;
	for (const line of content.split("\n")) {
		const fence = FENCE_LINE_RE.exec(line);
		if (fence) {
			if (!inFence) {
				inFence = true;
				fenceLen = fence[1].length;
				fenceChar = fence[1][0];
			} else if (closesFence(line, fence, fenceChar, fenceLen)) {
				inFence = false;
				fenceLen = 0;
				fenceChar = "";
			}
		} else if (!inFence) {
			visit(line, index);
		}
		index++;
	}
};

/**
 * Count lines matching `re` (a `^…` heading pattern) that sit OUTSIDE fenced code
 * blocks. Fence-awareness lives on `forEachLineOutsideFences` (a naive `matchAll`
 * counts fenced examples and false-throws the derived-array staleness guard);
 * the per-line `lineRe` drops the source's `g`/`m` flags so `lastIndex` can't drift.
 */
const countHeadingsOutsideFences = (content: string, re: RegExp): number => {
	const lineRe = new RegExp(re.source); // per-line test; drop g/m so lastIndex can't drift
	let count = 0;
	forEachLineOutsideFences(content, (line) => {
		if (lineRe.test(line)) count++;
	});
	return count;
};

/**
 * Character-offset spans of fenced code blocks (delimiter lines included), an
 * unterminated fence running to end-of-text. Mirrors the `inFence`/`fenceLen`
 * toggle `countHeadingsOutsideFences` carries so every fence-aware scan agrees
 * on the same boundaries.
 */
const fencedSpans = (content: string): [number, number][] => {
	const spans: [number, number][] = [];
	let inFence = false;
	let fenceLen = 0;
	let fenceChar = "";
	let spanStart = 0;
	let offset = 0;
	for (const line of content.split("\n")) {
		const lineEnd = offset + line.length + 1; // +1 for the split-consumed \n
		const fence = FENCE_LINE_RE.exec(line);
		if (fence) {
			if (!inFence) {
				inFence = true;
				fenceLen = fence[1].length;
				fenceChar = fence[1][0];
				spanStart = offset;
			} else if (closesFence(line, fence, fenceChar, fenceLen)) {
				inFence = false;
				fenceLen = 0;
				fenceChar = "";
				spans.push([spanStart, lineEnd]);
			}
		}
		offset = lineEnd;
	}
	if (inFence) spans.push([spanStart, offset]);
	return spans;
};

export { closesFence, countHeadingsOutsideFences, FENCE_LINE_RE, fencedSpans, forEachLineOutsideFences };
