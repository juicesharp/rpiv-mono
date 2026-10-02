/**
 * Structural subset of Pi's normalized handleMouse contract. Keeping this local lets
 * the extension load on older Pi hosts that have no mouse types or mouse dispatch.
 * Pi owns terminal reporting, overlay coordinates, and click/drag recognition.
 */
export interface QuestionnaireMouseEvent {
	type: "press" | "release" | "move" | "drag" | "click" | "wheel";
	button: "left" | "middle" | "right" | "none";
	x: number;
	y: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	clickCount?: number;
}

export interface QuestionnaireMouseResult {
	handled: true;
	render?: boolean;
}
