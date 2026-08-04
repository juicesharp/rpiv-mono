/**
 * Remove terminal control characters from model-controlled task text before
 * it reaches Pi's terminal renderer. Newlines and tabs become spaces so task
 * fields cannot change the layout or emit terminal commands.
 */
export function sanitizeTerminalText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) =>
		character === "\n" || character === "\r" || character === "\t" ? " " : "",
	);
}
