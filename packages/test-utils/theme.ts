import { vi } from "vitest";

type ColorKey = string;

export interface MockTheme {
	fg: (_color: ColorKey, text: string) => string;
	bg: (_color: ColorKey, text: string) => string;
	bold: (text: string) => string;
	strikethrough: (text: string) => string;
}

export function makeTheme(overrides: Partial<MockTheme> = {}): MockTheme {
	return {
		fg: (_color, text) => text,
		bg: (_color, text) => text,
		bold: (text) => text,
		strikethrough: (text) => text,
		...overrides,
	};
}

export interface MockTui {
	requestRender: ReturnType<typeof vi.fn>;
}

export function makeTui(): MockTui {
	return { requestRender: vi.fn() };
}
