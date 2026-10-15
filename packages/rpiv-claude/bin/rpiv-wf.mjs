#!/usr/bin/env node
// rpiv-wf launcher. The workspace publishes raw TypeScript (no build step) and
// rpiv-workflow's own imports use `.js` specifiers for `.ts` files, so the CLI
// loads through jiti, the same loader Pi uses for these packages.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { main } = await jiti.import("../cli.ts");
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
process.exitCode = await main(process.argv.slice(2), undefined, { signal: controller.signal });
