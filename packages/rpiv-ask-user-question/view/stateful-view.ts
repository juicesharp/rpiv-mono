import type { Component } from "@earendil-works/pi-tui";

/**
 * Generic prop-driven component contract. Every renderable owns its own `P` shape;
 * the adapter computes `P` from canonical state via per-component selectors and
 * pushes it via `setProps`. `focused: boolean` is a field on `P` only where the
 * component needs it.
 */
export interface StatefulView<P> extends Component {
	setProps(props: P): void;
}

/**
 * Discriminated focus union — encodes the three-cell focus invariant
 * (`notesVisible`, submit-tab, options). Dispatcher cascade (`key-router.ts`)
 * and reducer's defensive clears (`state-reducer.ts`) enforce mutual exclusion;
 * this type makes it explicit so per-component `focused: boolean` flags
 * derive from one equality check against this discriminant rather than
 * parallel boolean reads.
 *
 * Priority order: notes > submit > options. Matches the dispatcher
 * cascade exactly so the union is observably equivalent to today's reads.
 */
export type ActiveView = "notes" | "options" | "submit";
