/**
 * Remove terminal control characters from model-controlled task text before
 * it reaches Pi's terminal renderer. Complete CSI/OSC escape sequences are
 * dropped whole (no printable remnants like `[31m`), newlines and tabs
 * become spaces so task fields cannot change the layout, and bidi controls
 * are removed so a field cannot reorder how neighbouring output reads.
 */
export function sanitizeTerminalText(value: string): string {
	return (
		value
			// CSI sequences, via both ESC-[ and the C1 single-byte introducer.
			.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
			// OSC sequences with their payload; an unterminated OSC swallows the
			// rest of the string, matching how a real terminal would treat it.
			.replace(/(?:\u001b\]|\u009d)[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\)?/g, "")
			// Any remaining two-character ESC sequence.
			.replace(/\u001b./g, "")
			// Unicode line/paragraph separators join lines like \n does below.
			.replace(/[\u2028\u2029]/g, " ")
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) =>
				character === "\n" || character === "\r" || character === "\t" ? " " : "",
			)
			// Bidi embedding/override/isolate controls and LRM/RLM marks.
			.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
	);
}
