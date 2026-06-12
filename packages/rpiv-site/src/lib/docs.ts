import { type CollectionEntry, getCollection } from "astro:content";

export type DocEntry = CollectionEntry<"docs">;

export type DocSection = "getting-started" | "guides" | "explanation" | "reference";

export const SECTION_ORDER: DocSection[] = ["getting-started", "guides", "explanation", "reference"];

export const SECTION_LABELS = {
	"getting-started": "Getting Started",
	guides: "Guides",
	explanation: "Explanation",
	reference: "Reference",
} satisfies Record<DocSection, string>;

/** The entry that renders at /docs itself — the docs root is the install
 *  walkthrough, not a hub page. Every other entry lives at /docs/<id>. */
export const DOCS_ROOT_ID = "getting-started";

export function docPath(entry: DocEntry): string {
	return entry.id === DOCS_ROOT_ID ? "/docs" : `/docs/${entry.id}`;
}

export async function getPublishedDocs(): Promise<DocEntry[]> {
	const docs = await getCollection("docs", ({ data }) => !data.draft);
	return docs.sort((a, b) => {
		const sectionDelta = SECTION_ORDER.indexOf(a.data.section) - SECTION_ORDER.indexOf(b.data.section);
		if (sectionDelta !== 0) return sectionDelta;
		return a.data.order - b.data.order;
	});
}

export async function getDocsBySection(): Promise<Array<{ section: DocSection; entries: DocEntry[] }>> {
	const docs = await getPublishedDocs();
	const groups = new Map<DocSection, DocEntry[]>(SECTION_ORDER.map((s) => [s, []]));
	for (const doc of docs) {
		groups.get(doc.data.section)!.push(doc);
	}
	return SECTION_ORDER.map((section) => ({ section, entries: groups.get(section)! }));
}
