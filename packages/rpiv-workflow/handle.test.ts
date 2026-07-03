/**
 * Artifact handle — the storage-agnostic reference collectors emit and parsers
 * consume. Proves the four constructor discriminators (`fs`/`url`/`opaque`/
 * `inline`) and that `handleToString` round-trips each kind into a
 * promptable one-liner, including the optional `mime` suffix on inline handles.
 */

import { describe, expect, it } from "vitest";
import { fs, handleToString, inline, opaque, url } from "./handle.js";

describe("handle constructors", () => {
	it("fs() tags a filesystem path", () => {
		expect(fs("/tmp/a.md")).toEqual({ kind: "fs", path: "/tmp/a.md" });
	});

	it("url() tags an href", () => {
		expect(url("https://example.com/x")).toEqual({ kind: "url", href: "https://example.com/x" });
	});

	it("opaque() tags an external id", () => {
		expect(opaque("SHA-123")).toEqual({ kind: "opaque", id: "SHA-123" });
	});

	it("inline() omits mime when not supplied", () => {
		expect(inline(new Uint8Array([1, 2, 3]))).toEqual({
			kind: "inline",
			bytes: new Uint8Array([1, 2, 3]),
		});
	});

	it("inline() attaches mime when supplied", () => {
		expect(inline(new Uint8Array([1]), "image/png")).toEqual({
			kind: "inline",
			bytes: new Uint8Array([1]),
			mime: "image/png",
		});
	});
});

describe("handleToString", () => {
	it("serialises fs to its path", () => {
		expect(handleToString(fs("/tmp/a.md"))).toBe("/tmp/a.md");
	});

	it("serialises url to its href", () => {
		expect(handleToString(url("https://example.com/x"))).toBe("https://example.com/x");
	});

	it("serialises opaque to its id", () => {
		expect(handleToString(opaque("SHA-123"))).toBe("SHA-123");
	});

	it("serialises inline to byte length, no mime suffix when absent", () => {
		expect(handleToString(inline(new Uint8Array([1, 2, 3, 4])))).toBe("inline:4b");
	});

	it("serialises inline to byte length + mime suffix when present", () => {
		expect(handleToString(inline(new Uint8Array([1, 2]), "image/png"))).toBe("inline:2b;image/png");
	});
});
