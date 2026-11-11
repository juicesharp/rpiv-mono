import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "@juicesharp/rpiv-config";

const path = configPath("rpiv-todo", "auto-collapse.json");

export function readAutoCollapse(): boolean {
	if (!existsSync(path)) return false;
	const data: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!data || typeof data !== "object" || typeof (data as { enabled?: unknown }).enabled !== "boolean") {
		throw new Error(`Invalid auto-collapse configuration: ${path}`);
	}
	return (data as { enabled: boolean }).enabled;
}

export function saveAutoCollapse(enabled: boolean): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
}
