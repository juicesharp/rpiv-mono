---
name: code-review
description: "Conduct comprehensive code reviews using specialist row-only agents (diff-auditor at Wave-2 Q+S, peer-comparator at Wave-1 PM, claim-verifier at Step 6) plus orchestrator-side Gap-Finder (set arithmetic, no agent). Row-only contracts structurally resist narrativisation. Produces review documents in thoughts/shared/reviews/."
argument-hint: "[scope]"
---

# Code Review

Scope: $ARGUMENTS

Review changes across **Quality**, **Security**, **Dependencies** lenses with optional advisor adjudication. Valid scopes: `commit` | `staged` | `working` | hash | `A..B` | PR branch. **If Scope above is empty, ask the user before proceeding.**

**How it works**:
- Step 1 — resolve scope, read diff (with `-U30` context), derive flags, build semantic file map
- Step 2 — dispatch Wave-1: integration + precedents + (deps/CVE) + (peer-mirror); integration & peer-mirror gate Wave-2, precedents gates Step 5
- Step 3 — dispatch Wave-2: Quality + Security lenses, file-oriented
- Step 4 — dispatch Wave-3: Predicate-Trace + Interaction Sweep + Gap-Finder, all gated
- Step 5 — reconcile via advisor or inline dimension-sweep (blocks on precedents)
- Step 6 — verify findings: re-read each cited file:line; drop/demote unverified
- Step 7 — write artifact
- Steps 8–9 — present and handle follow-ups

**File-orientation contract**: agents reason about *files* as coherent units. Hunks are evidence *within* a file's analysis, never the unit of analysis. The `-U30` patch (Step 1) inlines function-level context so agents rarely need extra `Read` calls.

Every Wave-2 agent prompt contains EXACTLY: (a) `Known Context:` followed by the Discovery Map verbatim, and (b) the literal string `/tmp/code-review-patch.diff` as the patch path. Nothing else from Wave-1 outputs — NOT the raw integration-scanner dump, NOT precedent-locator output, NOT Dependencies/CVE output. See "Wave-2 context isolation" in Step 3 for the failure mode when this is violated. Wave-1 agents that do not consume the Discovery Map (precedents, dependencies, CVE) get `ChangedFiles` / manifest-diff only.

## Step 1: Resolve Scope and Assemble the Diff

1. **Interpret the Scope line** (from the header) and identify `OLDEST` + `NEWEST` commits (user-inclusive endpoints):
   - `commit` → `OLDEST=NEWEST=HEAD`
   - `staged` / `working` → no commits; see working-tree branch below
   - Single hash `h` → `OLDEST=NEWEST=h`
   - Range `A..B` → verify A is ancestor of B (`git merge-base --is-ancestor A B`; swap if reversed); `OLDEST=A`, `NEWEST=B`
   - Commit list (`h1,h2,h3` or whitespace-separated) → find endpoints via `git rev-list --topo-order`; `OLDEST` = farthest-from-HEAD, `NEWEST` = nearest. Reject if not on a single linear ancestry (ask user to clarify).
   - PR branch name → `OLDEST=$(git merge-base main HEAD)`, `NEWEST=HEAD` — note: `OLDEST` is already the parent-of-first-PR-commit, so skip the `BASE` computation below and use `BASE=OLDEST` directly.

2. **Compute the range once**: `BASE=$(git rev-parse "$OLDEST^")`, `TIP=$NEWEST`, `RANGE="$BASE..$TIP"`. This gives a range that INCLUDES `OLDEST`'s own changes (standard `A..B` excludes `A`). Every subsequent git command uses `$RANGE` — do NOT inline a `^` character in templates; orchestrators sometimes drop it.

3. **Assemble the UNION of changes** (not the net endpoint-diff — so reverted intermediate work stays visible). Save the patch to a tempfile once with generous context; do NOT re-run `git log --patch` to slice windows later:
   - `git log "$RANGE" --name-only --pretty=format: | sort -u` → `ChangedFiles`
   - `git log "$RANGE" --stat --reverse` → per-commit size summary
   - `git log "$RANGE" --patch --reverse --no-merges -U30 > /tmp/code-review-patch.diff` → union patches with **30 lines of surrounding context per hunk** (function-level context inline)
   - `git log "$RANGE" --reverse --format="%H %s%n%n%b%n---"` → commit-message context
   - **Working-tree branch** (`staged` / `working`, no `$RANGE`): `git diff --cached --name-only` / `git diff --name-only`; `git diff --cached --stat` / `git diff --stat`; `git diff --cached -U30` / `git diff -U30`. Commit-message context is N/A.
   - **Patch-size fallback**: `-U30` produces ~2–3× the size of `-U0`. If the resulting patch exceeds ~1MB, drop to `-U10` for this run; never use `-U0` — it defeats the skill's design.

3. **Bail-out**: if `ChangedFiles` is empty, print `No changes in scope [scope]. Exiting.` and STOP. Do not write an artifact.

4. **Derive flags** (orchestrator-side, used in later steps):
   - `ManifestChanged` = ChangedFiles intersects any dependency manifest or lockfile (e.g. `package.json`/lockfile, `Cargo.toml`/`Cargo.lock`, `go.mod`/`go.sum`, `pyproject.toml`/`requirements*.txt`/`poetry.lock`, `Gemfile*`, `*.csproj`, `pom.xml`/`build.gradle*`, `composer.json`, …) OR a peer/optional/dev-dependency field was touched.
   - `LockstepSelfReview` = repository root contains `scripts/sync-versions.js` AND every `packages/*/package.json` shares the same `version:` AND the diff touches `packages/*/package.json`.
   - `HasGatingPredicate` = diff adds or modifies a **status/enum-comparison predicate** (`Status == X`, `Status is X or Y`, `X.Contains(Status)`, pattern-match on a discriminator) OR introduces a new value into an enum referenced by existing gating predicates. NOT merely the presence of `if (!x) return`.
   - `ReviewType` = one of `commit | pr | staged | working`.
   - `PeerPairs` = `(new_file, peer_file)` tuples. `new_file` is in `git log "$RANGE" --diff-filter=A --name-only` (working-tree: `git diff --diff-filter=A --name-only [--cached]`). `peer_file` exists at HEAD (`git ls-tree HEAD`) and matches one heuristic:
     - **Stem similarity ≥ 60%** of the longer stem (e.g. `PhysicalProductSubscription` ↔ `Subscription`).
     - **Interface/impl pair**: `I<Name>` ↔ `<Name>`, `<Name>` ↔ `<Name>.impl`, `<Name>{Abstract,Base,Protocol}` ↔ `<Name>`.
     - **Shared suffix** from `{Handler, Service, Repository, Aggregate, Reducer, Controller, Resolver, Command, Query, Job, Processor, Strategy, Policy, Event, Listener, Subscriber, Publisher, Exception, Eligibility, Ability, QueryParam, Specification, Factory, Builder}`.

     Drop a pair only when the peer doesn't exist at HEAD, no heuristic matches, or both files were added in this diff. Empty list ⇒ skip the peer-mirror agent. Co-modified peers are KEPT — the agent Reads them at HEAD (post-diff tree state), so any invariant present at HEAD counts as peer evidence regardless of whether the peer was edited in this diff.

## Step 2: Dispatch Wave-1 — Integration + Precedents + Deps/CVE + Peer-Mirror

Spawn ALL of the following in parallel at T=0 in a **single message with multiple Agent tool calls**. Do NOT wait for integration-scanner before dispatching precedents / dependencies / CVE — they do not consume Discovery-Map output, only `ChangedFiles` and the manifest diff (both orchestrator-produced in Step 1).

**Agent — Integration map:**
- subagent_type: `integration-scanner`
- Prompt: "Map inbound references, outbound dependencies, and infrastructure wiring for the following changed files: [ChangedFiles, one per line]. Flag any auth-boundary crossings (middleware, guards, interceptors, authorize-style decorators) and config/DI/event registration touching these paths. Do NOT analyse code quality — connections only, in your standard output format."

**Agent — Precedents** (always): use the `precedent-locator` prompt defined in Step 3 below — dispatch it here, not in Wave-2. Input it needs: `ChangedFiles` only.

**Agent — Dependencies** (only when `ManifestChanged`): use the `codebase-analyzer` Dependencies prompt defined in Step 3 below — dispatch here. Input it needs: touched manifest paths + `LockstepSelfReview` flag.

**Agent — CVE / advisory** (only when `ManifestChanged`): use the `web-search-researcher` prompt defined in Step 3 below — dispatch here. Input it needs: parsed `name@version` list from the manifest diff (orchestrator extracts and hands over directly).

**Agent — Peer-Mirror** (only when `len(PeerPairs) > 0`): `subagent_type: peer-comparator`. Input: the `PeerPairs` list verbatim, nothing else — no Discovery Map (it isn't built yet and the agent doesn't need it), no patch path (the work is peer-vs-new entity comparison, not diff analysis). Prompt:
  ```
  Peer-mirror check.

  PeerPairs (orchestrator-computed):
  [list of (new_file, peer_file) tuples]

  For each pair, Read BOTH files in full. Enumerate the peer's PUBLIC surface as rows:
  - every public method / exported function
  - every domain event / notification / message fired (language-agnostic: method calls named `fire*`, `emit*`, `publish*`, `dispatch*`, `raise*`, `notify*`, `AddDomainEvent`, or idiomatic equivalents)
  - every state transition (name + precondition guard + side-effects)
  - every constructor-injected / DI-supplied collaborator
  - every persisted field / column / serialised property
  - every registration this file contributes to a switch/map/table/route/handler registry elsewhere (match by type name appearing in a `switch`/`match`/`when`/dispatch table)

  For each row, check the new file. Emit ONE row per peer invariant:

    peer_site (file:line — `<verbatim line>`) | new_site (file:line — `<verbatim line>` OR `<absent>`) | status | one-sentence delta

  status ∈ {Mirrored, Missing, Diverged, Intentionally-absent}.

  "Intentionally-absent" requires an explicit cite — a comment in the new file, a commit-message line mentioning the omission, or a type-system constraint that makes the invariant inapplicable (e.g. the peer's `Trial*` methods are absent because the new entity's type says it doesn't support trials). Suspicion is not sufficient; when in doubt, emit Missing.

  Output format: markdown table per pair, heading `### Peer pair: <new_file> ↔ <peer_file>`. No prose outside the tables. No severity. No recommendations. Citation contract applies to every cell.
  ```

While these agents run, the orchestrator produces the rest of the Discovery Map inline from Step 1's data:
- `ChangedFiles`, `ManifestChanged`, `LockstepSelfReview`, `ReviewType`
- **Semantic file map** (per file: `path (+A -B)` + role tag + top-level symbol names touched; see format and rules below)
- Commit-message context (if applicable)

**Wait for `integration-scanner` AND the peer-mirror agent (when dispatched)** before dispatching Wave-2. Wave-2 agents consume both via the Discovery Map (auth-boundary crossings, inbound refs, peer-mirror Missing/Diverged rows). Precedents / Dependencies / CVE continue running in the background; **Precedents MUST be awaited before Step 5 begins** (Reconciliation reads its follow-up-within-30-days counts to weight severity; see Step 5). Dependencies / CVE also merge in at Step 5 but may arrive later in the wait barrier.

**Synthesize the Discovery Map** — a compact block that Wave-2 agents receive verbatim as `Known Context`. Each file line carries a *role tag* and a *symbols-touched hint*; files are clustered by shared directory prefix so agents orient without re-reading the patch.

```
## Discovery Map

Review type: [ReviewType]
Scope: [scope argument]
Commit/range: [git ref]
Manifest changed: [yes|no]
Lockstep self-review: [yes|no]

Changed files ([N]):

  ## [cluster — shared directory prefix]
    path/file.ext (+A -B) [role-tag] — top 1–3 symbols touched
    ...

Auth-boundary crossings: [integration-scanner, file:line]
Inbound refs (files with ≥3 consumers): [integration-scanner]
Outbound deps: [integration-scanner]
Wiring/config: [integration-scanner]
Peer mirrors: [peer-mirror agent output verbatim — Missing/Diverged rows only; Mirrored and Intentionally-absent rows are summarised as counts]
```

**Clustering**: group files by longest shared directory prefix yielding clusters of 2+ files; singletons form their own cluster labelled with the filename. Emerges from the repo — no framework assumptions.

**Role-tag** (one tag per file, first match wins):
1. `[boundary]` — in integration-scanner's auth-boundary output
2. `[persistence]` — path contains `migration`/`schema`/`repository`/`dao`/`model`, or matches an ORM/migration convention visible in the repo
3. `[test]` — path contains `/test`/`/spec`/`__tests__`, or filename ends in a test suffix (`.test.*`, `.spec.*`, `_test.*`, `Test.*`)
4. `[config]` — in integration-scanner's wiring/config output, or is a manifest/lockfile/settings file
5. `[hub]` — in integration-scanner's inbound-refs with ≥3 consumers
6. `[code]` — default

**Symbols-touched hint**: extract top 1–3 top-level definitions from the diff's `+` lines using a heuristic appropriate to the file's language (class/function/def/fn/struct/trait/interface/type/export). Cap at ~80 chars. Leave blank if ambiguous — orientation, not completeness.

## Step 3: Dispatch Wave-2 — Quality + Security Lenses

Spawn Quality + Security in parallel using the Agent tool. Each receives the `## Discovery Map` block inline as `Known Context` above its task, and a pointer to `/tmp/code-review-patch.diff` for the diff itself. Precedents / Dependencies / CVE are already running from Wave-1 — do NOT re-dispatch them here; the prompts below document what those Wave-1 agents received, they are not re-issued.

**Wave-2 context isolation (LOAD-BEARING — violations cause silent quality collapse)**: Each Wave-2 agent receives EXACTLY two things, nothing else: (1) the Discovery Map (digested form) and (2) the literal path string `/tmp/code-review-patch.diff`.

**DO NOT paste into Wave-2 prompts**, under any circumstance, even if the orchestrator has already received them:
- raw integration-scanner output (the Discovery Map already summarises its auth/ref/wiring findings)
- precedent-locator output
- Dependencies lens output
- CVE lens output
- any prior Wave-2 or Wave-3 output from earlier runs in the same Pi session

**Why this is load-bearing**: summary context induces *narrativisation* — the agent treats the preamble as "the orchestrator already framed the findings, I just classify them" instead of independently reading the patch file. Observed failure signatures when this is violated: Quality drops from ~40 tool calls / 3M tokens / 500s to ~5-15 tool calls / 300k tokens / 100-200s, and returns hallucinated findings (invented statuses, mis-cited line numbers, claims that files are "missing from patch" when they are in fact present).

**Self-check before dispatching Wave-2**: read your outgoing Agent prompt. If it contains any content from Wave-1 agent RESULTS beyond the Discovery Map you synthesised, strip it. The Discovery Map is the contract; raw outputs are reconciliation-only.

**Citation contract** (applies to every Wave-2+ agent, every step): every `file:line` citation MUST be accompanied by the literal line text in backticks — format `file:line — \`<verbatim line>\` — <note>`. Omit findings whose lines you cannot quote verbatim.

**Quality lens** (`diff-auditor`) — **file-oriented**:
  ```
  Analyse changes file by file. For each file in ChangedFiles, read its diff region in `/tmp/code-review-patch.diff` (patch has `-U30` — full function context is already inline; rarely need an extra Read call), form a mental model of what the file does and what the diff changes about it, then apply the 13 surfaces below to the file as a whole. Cite `file:line` with verbatim line text (citation contract) for every finding. Omit findings not traceable to a diff-touched change. No severity.

  **File order strategy**: prioritise by role tag — `[boundary]` files first (security-sensitive), then `[persistence]` (durable-state surfaces), then `[hub]` (blast-radius amplifiers), then `[code]`, then `[config]`, then `[test]` last. Within the same tag, prioritise files with the largest diffs.

  **Per file**, write a short section (`### file/path.ext`) containing only the surfaces that APPLY to that file's changes. Use sub-headings for grouped evidence. A surface may be flagged across multiple files — report the evidence where it lives, and rely on cross-layer surfaces (8, 9) to tie them together.

  **Surfaces** — each surface's mechanical trigger decides whether it APPLIES to a given file's changes. Walk every applicable trigger:

  1. **Logic & flow** (always, per file with new/modified code) — validation, error paths, off-by-one, null misses, branch ordering, return/await, unguarded mutation.
  2. **Pattern coherence** (≥2 similar constructs within a file, or ≥2 files in the same cluster) — cite nearby line broken from.
  3. **Blast radius** (Discovery Map lists inbound refs to this file, OR this file is flagged as a hub) — `consumer:line` + what changes for each inbound ref.
  4. **Test coverage gaps** (always, checked once across the whole changeset) — for each risk-bearing function/method added/changed, check whether any `[test]`-tagged file in ChangedFiles contains a corresponding test. Flag risk-bearing behavior with no adjacent test.
  5. **Predicate-set coherence** (`HasGatingPredicate`) — ≥2 conditionals on the same enum/type across the changeset. Tabulate `predicate file:line | accepted | rejected`. Flag mismatches. Surface 5 output MUST use heading `### Predicate-set coherence` at review-scope level (not nested inside a per-file section) — downstream step consumes it verbatim.
  6. **Registration coverage** (changeset adds discriminator value / enum variant / handler key / route / event type / strategy entry) — every dispatch/registry/switch across ChangedFiles that must enumerate it. Cite each registration site + each enumeration site. Flag gaps.
  7. **Query/write symmetry** (changeset adds setter/linker, shape change, or new persisted field) — trace BOTH creation and renewal/update paths; cite the setter file:line AND the reader file:line.
  8. **Cross-layer drift** (same entity/enum/key appears in ≥2 files in different clusters or role tags — e.g. model ↔ DTO ↔ schema ↔ registry ↔ presentation) — open each file, tabulate presence, flag asymmetry. When the entity is a **key fanned out across parallel tables** (locale maps, theme maps, strategy registries, handler/command tables, feature-flag tables), every table must carry the added key and none must retain a removed/renamed one — flag orphaned references and missing entries.
  9. **Peer-member consistency** (a file gains a new method/hook/case/handler in a set of peers — class methods, hook siblings, reducer cases, handler registrations, CLI subcommands) — tabulate the invariants the peers share (state mutation, emitted event/signal, precondition guard, bookkeeping counter, teardown symmetry); flag omissions in the new member.
  10. **Durable-state hygiene** (file is a schema migration, repository/DAO, file-backed config, KV/cache, serialized artifact, or adds a new persisted field) — trace the forward-write AND the reverse/rollback path; flag irreversible or data-losing rollback, missing lookup affordance for a new query field (index, key, sorted structure), iteration over an unbounded/mutable source without a stable cursor, and new invariants at the storage layer not mirrored by the in-memory validator.
  11. **Shared-state acquisition** (file introduces async handler, event listener, singleton init, queue consumer, file-lock region, or global cache mutation) — trace acquire/release around every mutation; flag unguarded check-then-act across an `await`/callback/IPC boundary, stale reads while another writer is in flight, non-commutative acquire order between distinct state slots, and replay/retry paths that lack an idempotency key.
  12. **Multi-step commitment** (file issues ≥2 writes that must all succeed or all be undone — DB transaction, cross-table mutation, multi-file write, filesystem+network pair, multi-API orchestration, compensating-action chain) — trace the commit boundary; flag missing undo/compensation on partial failure, retry paths that re-apply non-idempotent steps, and divergence between two stores that must agree without a coordinating primitive.
  13. **Error handling & idempotency** (file adds a failure-response construct — retry loop, catch/except block, error boundary, fallback branch, circuit breaker, timeout, resumable step) — trace the error-propagation path; flag swallowed errors, retry without an idempotency key, fallback that silently degrades observable behavior, unjustified timeout values.

  **Economising Reads**: issue a `Read` only when (a) you need a file NOT in ChangedFiles (hub, peer, test), or (b) the changed function is longer than the `-U30` window can show. Never re-Read a file just to re-orient — that's what the symbols-touched hint is for.
  ```

**Security lens** (`diff-auditor`) — **file-oriented**:
  ```
  Analyse each changed file as a whole, looking for sinks in the classes below. For each file, grep the file's diff region in `/tmp/code-review-patch.diff` (patch has `-U30` — sink context is inline) for the sink patterns, and for each hit provide the verbatim line (citation contract) plus 2 surrounding lines and `confidence: N/10` that user-controlled input can reach the sink under current deployment. Drop hits with confidence < 8. Cross-reference Discovery Map auth-boundary crossings and inbound refs — a sink in a file reached from an auth-boundary file is in scope even if the sink file itself doesn't cross the boundary.

  **File order strategy**: `[boundary]` files first (direct source→sink exposure); then `[persistence]` (query injection, unsafe deserialization); then `[code]` (command exec, SSRF, explicit-trust rendering); then `[hub]` / `[config]`; skip `[test]` unless a test helper touches a sink.

  IN-SCOPE RULE: only report findings whose sink line is inside a changed file's diff region (add/modify/adjacent-context rewrite). Pre-existing sinks in files the diff did not change are out of scope, UNLESS the diff changes how data flows TO the sink (e.g. new user-controlled source routed to an untouched sink) — then cite both locations. When in doubt, trace data flow from Discovery Map boundary crossings through the changed files.

  Sink classes — match the concept in whatever language the diff uses:
  - **Command execution** — shell/process spawn w/ user input (e.g. `exec`, `subprocess.run(shell=True)`, `Runtime.exec`, …).
  - **Dynamic code / unsafe deserialization** — `eval` / dynamic-function constructors; deserializers that can execute code (e.g. `pickle.loads`, `yaml.load` w/o safe loader, `ObjectInputStream`, `BinaryFormatter`, …).
  - **Query injection** — user input concatenated or interpolated into a query string interpreted by an external engine (SQL, NoSQL operators, LDAP filters, XPath, GraphQL constructed as string). Parameterized/prepared queries and typed query builders are safe.
  - **Explicit-trust rendering** — user input emitted into a channel that will interpret it as code/markup rather than data. In-scope only when the framework's explicit-trust API is invoked (`dangerouslySetInnerHTML`, `bypassSecurityTrustHtml`, `v-html`, `template.HTML`, `mark_safe`, `html_safe`, triple-stache, raw-HTML markdown, …), plain `innerHTML =` / `document.write(` in vanilla/server-rendered code, or equivalent passthroughs in non-HTML renderers (unescaped ANSI-escape emission to a TTY, unquoted shell-prompt interpolation, template-engine raw blocks).
  - **Path traversal** — user-controlled components into file-system APIs without normalization/allowlist.
  - **SSRF** — outbound HTTP/TCP with user-controlled host OR protocol (not just path).
  - **Secrets in diff** — literal credentials, API keys, PEM blocks, connection strings w/ embedded passwords, `.env` content.
  - **Missing trust-boundary check** — a traced sink reached from a Discovery-Map boundary crossing (HTTP handler, RPC endpoint, IPC message, CLI flag that flows to a privileged operation, webhook receiver) without an upstream authorization/validation step (middleware, guard, attribute/decorator, allowlist check, signature verification).

  Do NOT report: DOS/resource exhaustion/rate-limiting, missing hardening without a traced sink, theoretical races/timing without reproducer, log spoofing/prototype pollution/tabnabbing/open redirects/XS-Leaks/regex DOS, client-side-only authn/authz (server is the authority), findings sourced only from env var / CLI flag / UUID, test-only or notebook files without a concrete untrusted-input path, outdated-dependency CVEs (CVE lens handles).

  Name the sink class and the matched idiom. Evidence only. No CVE lookups.
  ```

**Dependencies lens** (`codebase-analyzer`, only when `ManifestChanged`; otherwise SKIP and omit `### Dependencies` in artifact):
  ```
  Lockstep self-review: [yes|no]

  Identify the ecosystem from touched manifests (npm, Cargo, Go modules, PyPI/Poetry, Bundler, NuGet, Maven/Gradle, …). Parse the changed manifest(s) and list:
  1. Added deps: `name@version` with `file:line`.
  2. Bumped deps: `name: old -> new` with `file:line`.
  3. Removed deps.
  4. Peer / optional / dev-scope changes (whatever the ecosystem calls them).
  5. License field changes in manifest or lockfile.
  6. Lockstep=yes: flag only intra-monorepo drift where a sibling pin diverges from the lockstep version. Treat wildcard peer pins as intentional.
  7. Lockstep=no: flag version conflicts between direct dep and lockfile resolution.

  Evidence only. No CVE lookups.
  ```

**Precedents lens** (`precedent-locator`):
  ```
  Code review of [scope]. Changed files: [ChangedFiles].
  Find similar past changes touching these files or nearby. Per precedent: commit hash, blast radius, follow-up fixes within 30 days, one-sentence takeaway. Distil composite lessons.
  ```

**CVE/advisory lens** (`web-search-researcher`, only when `ManifestChanged`):
  ```
  Look up CVEs / GitHub Advisories / OSS Index entries for the target versions. Return LINKS. Per vulnerability: severity (Critical/High/Moderate/Low), affected range, whether bumped-to version is fixed.

  Dependencies:
  [name@version per line — orchestrator-extracted]
  ```

**Wait for Quality + Security to complete** before proceeding. Precedents / Dependencies / CVE from Wave-1 may still be running; gather them before Step 5, not before Step 4.

## Step 4: Dispatch Wave-3 — Predicate-Trace + Interaction Sweep + Gap-Finder

Once Wave-2 (Quality + Security) completes, dispatch 4a and 4b as parallel agents **in a single message**; compute 4c inline (orchestrator-side set arithmetic — no agent). They do NOT consume each other's output:

- **Interaction Sweep (4b)** receives Quality's `Predicate-set coherence` table directly as its predicate-row source. Quality's table already flags mismatches — Predicate-Trace (4a) only *elaborates* them through consumers. Interaction Sweep's categories 1–6 don't need 4a at all; categories 7–9 (stranded-state, false-promise, co-tenant filter gap) operate on the same rows 4a would trace.
- **Gap-Finder (4c)** is coverage arithmetic: `{in-scope files} − {files with ≥1 Quality/Security finding} = {uncovered files}`. Orchestrator already holds both sets post-Wave-2 — an agent would discard context only to re-receive it via prompt. Inline is strictly cheaper and deterministic.
- If Predicate-Trace (4a) surfaces a row that was not visible in Quality's table, append it via a Step 9 follow-up — cheaper than a serial gate.

### Step 4a: Predicate-Trace

**Gate**: SKIP this sub-step (do not dispatch 4a) unless `HasGatingPredicate` is true AND the Quality lens returned ≥2 rows in its `Predicate-set coherence` table referencing the same enum/type. If skipped, 4b and 4c still dispatch.

Otherwise spawn ONE `codebase-analyzer` in parallel with 4b:
  ```
  Coherence rows (Quality — Predicate-set coherence): [paste verbatim]
  Gating predicates in diff: [`file:line` list]

  Per predicate, return: `predicate file:line | inputs | promise (what TRUE/matching branch implies) | consumer file:line | consumer filter | fulfils? | gap`.

  Flag:
  - *False promise* — matching branch depends on a consumer/filter elsewhere that excludes this entity's source/type/state.
  - *Stranded state* — entity reaches state X via one conditional, but every conditional that operates on this entity elsewhere excludes X (no exit path).

  Evidence only. Citation contract applies.
  ```

Do NOT wait — 4b (Interaction Sweep) dispatches in the same message as 4a; 4c runs inline in the orchestrator.

### Step 4b: Interaction Sweep

**Gate**: SKIP this sub-step (do not dispatch 4b) when EITHER `len(ChangedFiles) < 2` OR the Quality lens returned fewer than 4 total observations across all files. Emergent interactions need surface area; tiny diffs cannot structurally produce them.

Otherwise spawn ONE `codebase-analyzer` in parallel with 4a:
  ```
  Quality Evidence: [verbatim]
  Security Evidence: [verbatim]
  Predicate-set coherence rows (verbatim from Quality's table — full Step 4a output is NOT required and is NOT awaited): [verbatim | "not applicable"]
  Precedents: [verbatim if Wave-1 finished; else "deferred to Step 5"]

  Group evidence by shared entity, state machine, workflow, data flow path, API boundary, background process, or producer-consumer contract.

  Per group, check for emergent defects:
  1. contradictory assumptions between components/layers,
  2. unreachable, stuck, or non-terminal states,
  3. retry/reprocess mechanisms made inert by another behavior,
  4. duplicate-processing / idempotency gaps from ordering or missing guards,
  5. guards in one layer invalidating transitions in another,
  6. one finding masking, amplifying, or permanently triggering another,
  7. stranded state — state X reachable via one conditional but every conditional operating on this entity elsewhere excludes X,
  8. false-promise predicate — matching branch's consumer excludes this entity's source/type/state,
  9. co-tenant filter gap — shared discriminator filter where a new or terminal value the diff touches falls through every consumer's filter.

  Return only findings with ≥2 concrete `file:line` facts from different files/components, each quoted verbatim per the citation contract. No recommendations. No single-location repeats.

  For findings involving ordering/races/concurrency across processes or handlers, name the ordering primitive that would prevent the race (distributed lock, exclusive-key wrapper, ordered partition, transaction, idempotency key, etc.) and explain why it does NOT apply here. Drop the finding if the primitive exists in the diff or nearby and your argument against it is speculative.
  ```

### Step 4c: Gap-Finder (orchestrator-side coverage arithmetic)

**Gate**: SKIP when `len(ChangedFiles) < 2`. Tiny diffs cannot structurally have coverage gaps.

No agent dispatch. Compute inline while 4a / 4b run:

1. **Coverage map** — parse Quality + Security outputs; for each finding row extract its `file:line` citation and map `file → [finding-id]`. Files with ≥1 row are covered; files with none are uncovered.
2. **In-scope filter** — keep files tagged `[boundary]`, `[persistence]`, `[code]`, or `[hub]` AND whose diff delta (sum of added + removed lines) is ≥ 5. Drop `[test]` and `[config]` entirely; drop files with tiny deltas.
3. **Emit gap findings** — walk uncovered in-scope files in role-tag priority `[boundary]` → `[persistence]` → `[hub]` → `[code]`. For each, open its diff region in `/tmp/code-review-patch.diff` and pick ONE risk-bearing line (first non-comment `+` line, or the function-declaration header if a whole function was added). Emit:

   `G<ordinal> — file:line — \`<verbatim line>\` — [role-tag] — <risk class in 3-6 words>`

   Risk-bearing behavior class (diff introduces one of): state mutation | I/O (DB/network/file) | error path | conditional on mutable state | concurrent/shared-state access | public API surface change. Maximum **5** gap findings; stop once reached. Citation contract applies.

**Wait for ALL of 4a / 4b AND the Precedents agent from Wave-1 to complete** before proceeding to Step 5 (Reconciliation). Precedents is a **hard gate** — severity weighting in Step 5 reads its follow-up-within-30-days counts. Dependencies / CVE (when dispatched) also merge in here but are not individually hard-gated; wait for them too unless they clearly exceed the review SLA, in which case omit `## Dependencies` and note it in the artifact. 4c has no wait — it completes synchronously with the orchestrator.

## Step 5: Reconcile Findings

**Barrier**: Step 5 MUST NOT begin until the Precedents agent has returned. Severity weighting depends on historical follow-up counts; starting reconciliation without them produces mis-weighted severities that the verification pass (Step 6) cannot correct.

**Resolution integrity check** (load-bearing): when Precedents returns a commit that claims to resolve or supersede a current finding, run `git merge-base --is-ancestor <precedent-hash> <TIP>` before accepting the resolution.
  - Ancestor: the precedent IS in the reviewed branch; mark the finding `resolved-by: <hash>` and demote its severity to 💭 (kept for context).
  - Not ancestor: the precedent is on a different branch / not merged; treat it as **context only**. Do NOT mark the finding resolved; annotate the precedent's row in `## Precedents` third column `NOT ancestor of [TIP] (context only)`.
  - Orchestrator unable to run git (e.g., `staged` / `working` scope with no commit): skip the check and annotate `resolution: unverified`.

1. **Compile and classify evidence** per lens:
   - **Quality** — 🔴 traced flow contradiction (dropped error path, missing validation on a sink, null-deref); 🟡 blast-radius × complexity-delta (hot path + new allocation, ABI change without migration); 🔵 pattern divergence with nearby template; 💭 composite-lesson architecture concern.
   - **Security** — 🔴 concrete user-reachable source→sink trace via Discovery Map auth-boundary (reject hits without explicit trace); 🟡 concrete crypto issue (weak hash in auth/integrity role, non-constant-time compare, hardcoded key material); 🔵 divergence from a secure example in the same file; 💭 architectural question.
   - **Dependencies** — 🔴 Critical/High CVE in touched dep OR lockstep-contract violation; 🟡 Moderate CVE, outdated major with migration path, license incompatibility; 🔵 minor/transitive drift; 💭 architectural dep question.
   - **Interaction-sweep** — 🔴/🟡 only (no 💭): 🔴 concrete emergent failure across ≥2 files/components; 🟡 multi-component mismatch with bounded blast radius or existing mitigation. **Promotion rule**: when ≥2 lens findings share the same entity/flow and combine into an emergent failure, the aggregate is 🔴 even if each constituent was 🟡/🔵. The interaction IS the defect — don't leave constituents at their original severity and skip the cross-finding bullet.
   - **Gap-finder** — 🟡 uncovered risk-bearing region in a changed file with no lens coverage; 🔵 low-impact gap (style-only or defensive-only region missed). No 🔴 (gap findings are uncertain by nature).
   - **Peer-mirror** — treat every Missing/Diverged row as a finding. Base severity 🔵. **Bump to 🟡** when the missing invariant is a domain-event emission, a precondition guard on a state-mutating method, or a persisted-field invariant. **Bump to 🔴** when the missing invariant intersects a dispatch site the diff touches (switch/map/table/registry enumerating the peer's type alongside the new type — detectable from integration-scanner's `Wiring/config` output and the Discovery Map's `[config]`/`[hub]` files). Rationale: a missing mirror on a dispatched invariant is a silent-stranded-state cascade constituent; on a non-dispatched invariant it is a style issue. Record every peer-mirror bump in `## Reconciliation Notes`.
   - **Precedents** → compile into `## Precedents` (table: `hash | subject | 30d-follow-ups | note`), composite lessons below. **Severity weighting**: for each current finding, count precedent commits touching the same symbol/file that had ≥1 follow-up fix within 30 days. If count ≥ 2, bump the finding one severity tier (🔵→🟡, 🟡→🔴); cap at 🔴. Record the bump by annotating the finding's title line `[precedent-weighted]` — do NOT emit a separate reconciliation section.

2. **Probe advisor availability** — attempt a probe by checking whether `advisor` is in the active tool set (main-thread visibility). If yes, proceed to advisor path; otherwise take the inline path.

3. **Advisor path** (when advisor is active):
   - Print a main-thread `## Pre-Adjudication Findings` block first — the advisor reads `getBranch()`, so evidence must be flushed before the call.
   - Call `advisor()` (zero-param). If it returns usable prose, paste it verbatim as a blockquote at the top of `## Recommendation` and skip the inline path. Otherwise fall through.

4. **Inline path** (advisor unavailable or errored):
   - Run a dimension-sweep modeled on `skills/design/SKILL.md:83-116`: Data model / API surface / Integration / Scope / Verification / Performance.
   - For every finding, ask: does another finding contradict this severity given the Discovery Map? If yes, note the tension.
   - Record every severity move as a title-line annotation on the affected finding (`[precedent-weighted]`, `[cascade: <kind>]`, `[subsumed-by <ID>]`). No standalone reconciliation section.

5. **Emit the reconciled severity map** — authoritative severity per finding, carrying the advisor's guidance when present. Keep the per-pass grouping (do NOT tag each finding with its originating lens in prose; the H2 it sits under is the tag).
   - Interaction findings carry `I<n>` IDs and appear under the severity H2 that matches their final tier (`## 🔴 Critical`, `## 🟡 Important`). The old `### Cross-Finding Interactions` sub-heading is retired — severity is the top-level grouping.
   - When an interaction finding subsumes a local finding at the root-cause level, keep the local finding only if its evidence is independently actionable; annotate the local finding's title line `[subsumed-by I<n>]`.
   - Distinct structural defects MUST remain distinct findings even when related. Specifically: a *stranded state* (entity reaches X, no exit path) and a *false-promise predicate* (TRUE branch promises unreachable behavior) are separate defects even when they arise in the same subsystem — do NOT collapse them. Collapse only when the narrative, fix, and evidence locations are identical.
   - **Cascade detection** (load-bearing): before emitting severities, scan findings for these triples and emit a 🔴 Cross-Finding bullet if any fires —
       • *{entity reaches state X} + {no event on that transition} + {consumer filter excludes X}* = **silent stranded state**
       • *{check-then-act on shared resource} + {no ordering primitive} + {retry/replay path}* = **duplicate-processing cascade**
       • *{spec A accepts Y} + {spec B rejects Y} + {workflow depends on both}* = **contradictory-predicate deadlock**
     Also check `thoughts/shared/reviews/*.md` and Precedents: if a prior review names a cascade whose constituents appear in current findings, cite it and assert reproduction. Missed cascades are the biggest historical quality regression; prefer false positives here.

## Step 6: Verify Findings

Before writing the artifact, spawn ONE `claim-verifier` whose sole job is to ground every reconciled finding in the actual code at its cited `file:line`. This catches two classes of error the lenses cannot self-detect: (a) *confident assertions* the agent never opened a file to confirm, and (b) *rationalisations* ("intentional-by-design", "pre-existing", "not a real deadlock") that contradict what the code does. Lens agents reason from the patch; the verifier reasons from the file.

**Dispatch** after Step 5's reconciled severity map is final, before Step 7 writes anything:

  ```
  Verify each finding below against the actual repository state. You have Read access to the whole tree.

  Findings (verbatim from Step 5):
  [paste the full reconciled severity map — each finding with its file:line citation, verbatim line quote per the citation contract, and severity tier]

  For EACH finding:
  1. `grep -n` the verbatim quote in the cited file. Absent → Falsified. Present at a different line → rewrite the citation to the actual line, then continue. Present at cited line → continue.
  2. If the finding makes a claim about behavior reachable elsewhere (consumer filters, dispatch registrations, peer aggregates, upstream guards, downstream sinks), Read those referenced files too. Do NOT trust the patch-only view.
  3. If the finding claims a state is "stranded" / a predicate is "false-promise" / a precondition is "missing" — construct a concrete 2–3 line reproducer trace: "caller at A:L invokes B:L with entity in state X; guard at C:L rejects; exit path would require D which the code does not provide." If you cannot construct it, the finding is Weakened.
  4. If the finding was marked `resolved-by: <hash>` in Step 5, Read the resolving commit's changes on the reviewed branch (via `git show <hash> -- <file>`) and confirm the resolution is actually present at TIP.

  Return ONE tag per finding — output format:

    FINDING <id> | <tag> | <one-sentence justification citing a file:line>

  Tags:
  - Verified — quote matches, claim is reproducible against the actual code, no contradiction found
  - Weakened — claim is partially true but narrower than stated (severity should drop one tier), OR it relies on a consumer-side assumption that the actual consumer does not make
  - Falsified — quote does not match, OR the claimed behavior is contradicted by code the lens did not read (peer site, upstream guard, existing handler, resolution already applied)

  Be explicit about contradictions. If finding A says "intentional by design" and finding B says "stranded state" about the same entity, mark the one whose claim the code does NOT support as Falsified and cite the contradicting line.

  Citation contract applies to every justification. No recommendations. No new findings.
  ```

**Before applying tags** — re-read every Weakened and Falsified justification (the tag is a summary; the justification is the evidence). Per `agents/claim-verifier.md` tag semantics: Weakened = narrower, Falsified = wrong direction, Verified = correct or understated. If a justification contradicts its tag (e.g. "inverted" / "opposite" under Weakened, or "worse than stated" under Weakened), override before applying the rules below. Also verify identity on the ID set — exactly one row per input finding; re-dispatch `claim-verifier` on any missing IDs before proceeding.

**Apply the tags** (on the corrected tag):
- **Falsified** findings — remove from the artifact entirely. Their ID is retired (never reused); the retirement is counted in the frontmatter `verification` string (`F` dropped) and nowhere else.
- **Weakened** findings — demote one severity tier (🔴→🟡, 🟡→🔵, 🔵→💭). Rewrite the finding's evidence line to reflect the narrower claim.
- **Verified** findings — carry through unchanged to Step 7.
- **Edge case**: if a 🔴 Cross-Finding Interaction bullet relies on constituents that are now Falsified or Weakened, re-evaluate the interaction. Drop the interaction if it no longer stands on ≥2 Verified constituents from different files.

**Gate**: if verification removes / demotes ALL 🔴 findings AND there are no remaining 🟡 findings, set `status: approved` in the artifact frontmatter. Otherwise `status: needs_changes` (or `requesting_changes` for verified 🔴 > 3).

**Do not skip this step** — it is the only mechanism that stops confident-but-unread lens assertions from reaching the artifact.

## Step 7: Write the Review Document

1. **Determine metadata**:
   - Filename: `thoughts/shared/reviews/YYYY-MM-DD_HH-MM-SS_[scope-kebab].md`
   - Repository: git root basename (fallback: cwd basename).
   - Branch + commit: from git-context injected at session start, or `git branch --show-current` / `git rev-parse --short HEAD` (fallback: `no-branch` / `no-commit`).
   - Reviewer: user from injected git-context (fallback: `unknown`).

2. **Write the artifact** using the Write tool (no Edit — this skill writes once per run).

**Finding IDs**: lens-prefix + ordinal, stable across severity moves. `I` = interaction, `Q` = quality, `S` = security, `G` = gap. Ordinals never renumber — if a finding is dropped by Step 6, its ID is retired, not reused.

**Title-line annotations** (appear in square brackets on the finding's title line, point-of-demand for reconciliation facts):
- `[precedent-weighted]` — severity bumped by Step 5's precedent follow-up weighting.
- `[cascade: <kind>]` — severity set by Step 5's cascade-detection triple (`stranded-state`, `duplicate-processing`, `contradictory-predicate-deadlock`).
- `[subsumed-by <ID>]` — root-cause subsumed by another finding but kept because its specific evidence is independently actionable.

**Section-omission rules**: omit entirely (no empty placeholders) when —
- `## 💭 Discussion` — no 💭 findings.
- `## Pattern Analysis` — no peer-mirror pair existed for this diff.
- `## Impact` — integration-scanner returned no inbound refs to changed files.
- `## Precedents` — precedent-locator returned no precedents.

**What is NOT emitted to the artifact**: verification outcomes in prose (frontmatter `verification` string is the only channel), advisor availability / dispatch path / tool failures (skill trace, not review content), `last_updated` / `last_updated_by` (git mtime + git author carry this for a write-once artifact).

**Advisor prose**, when advisor ran, is pasted verbatim as a blockquote at the top of `## Recommendation`, not as a standalone section.

**Template shape**: Read the full template at `templates/review.md` (house pattern per `.rpiv/guidance/skills/architecture.md:66` — `templates/` subfolder, runtime-read, never inlined). At emission time: Read `templates/review.md`, fill every `[placeholder]` with reconciled-and-verified values from Steps 5 and 6, apply the section-omission rules above (delete the whole section AND its trailing separator line when its input is empty), strip the leading `<!-- -->` comment, and Write the result to the target path.

## Step 8: Present Summary

```
Review written to:
`thoughts/shared/reviews/[filename].md`

Severity:     [C] critical · [I] important · [S] suggestions
Lenses:       [Q] quality · [Se] security · [D] dependencies
Verification: [V] verified · [W] weakened · [F] falsified (dropped)
Advisor:      [adjudicated | inline]
Status:       [approved | needs_changes | requesting_changes]

Top items:
1. [ID] — `file:line` — [headline]
2. [ID] — `file:line` — [headline]
3. [ID] — `file:line` — [headline]

Ask follow-ups.
```

## Step 9: Handle Follow-ups

- If the user asks for deeper analysis of a specific finding, spawn a targeted `codebase-analyzer` on that area (1 agent max) and append a `## Follow-up [ISO 8601 timestamp]` section using the Edit tool. The section heading's timestamp is the append-time record — no frontmatter update needed.
- Never rewrite prior findings; only append. Retired IDs (Falsified in Step 6) stay retired; follow-ups introduce new IDs with the same lens-prefix scheme (next ordinal).

## Important Notes

- **Frontmatter**: `allowed-tools` is intentionally omitted — the skill inherits `Agent`, `ask_user_question`, `advisor`, `Write`, `web_search`, `todo` per `.rpiv/guidance/skills/architecture.md:40`. Do NOT re-add the line.
- **Security-lens precision stance**: prefer false negatives. Evidence must carry `confidence ≥ 8`; 🔴 requires an explicit source→sink trace. Missing hardening without a traced sink is NOT a finding.
- **Load-bearing ordering**:
  - Wave-1 fans out at T=0 — integration-scanner, Precedents, (when `ManifestChanged`) Dependencies + CVE, and (when `len(PeerPairs) > 0`) the peer-mirror agent dispatch in a single multi-Agent message. integration-scanner AND peer-mirror gate Wave-2 (both feed the Discovery Map Wave-2 consumes); **Precedents is a hard gate on Step 5** (its follow-up-within-30-days counts drive severity weighting; reconciling without them produces mis-weighted severities the verification pass cannot correct); Dependencies + CVE soft-gate Step 5.
  - Step 4a (Predicate-Trace) and 4b (Interaction Sweep) dispatch in parallel once Wave-2 completes; 4c (Gap-Finder) is orchestrator-side coverage arithmetic — no agent. Interaction Sweep (4b) receives Quality's `Predicate-set coherence` table as its predicate-row source, not 4a's output.
  - When Quality's `Predicate-set coherence` surface returns ≥2 rows with mismatched values on the same enum/type, the 4b sweep MUST evaluate categories 7–9 against those rows.
  - **File orientation is load-bearing**: patches MUST use `-U30` (or `-U10` fallback for >1MB patches), never `-U0`. The Discovery Map's semantic file map (clusters + role tags + symbols-touched hint) is the orientation primitive, not per-hunk line ranges. Lens prompts organise findings per file (`### file/path.ext`), not per hunk. Agents SHOULD NOT issue extra `Read` calls for files already represented in the patch unless specifically needed for a cross-file trace.
  - **Wave-2 context isolation**: Quality and Security prompts MUST NOT include Wave-1 background-agent output (precedent-locator, Dependencies, CVE) even when those agents have finished before Wave-2 dispatches. Summary context from those agents causes the lens agents to narrativise instead of independently analyse the diff — the observed failure mode is a ~5× speedup coupled with hallucinated findings and mis-cited line numbers. Pass only Discovery Map + patch file path.
  - ALWAYS emit `## Pre-Adjudication Findings` to the main branch BEFORE calling `advisor()` — advisor reads `getBranch()` (main-thread-only, `packages/rpiv-advisor/advisor.ts:336`).
  - ALWAYS probe advisor availability before calling it (strip-when-unconfigured at `packages/rpiv-advisor/advisor.ts:463-472`).
  - NEVER call `advisor()` from a sub-agent (branch invisible to advisor).
  - NEVER parse advisor prose — paste verbatim as a blockquote at the top of `## Recommendation`.
  - ALWAYS wait for 4a / 4b AND the Precedents agent to complete before Step 5 — Wave-3's hard barrier. 4c is synchronous (orchestrator). Dependencies + CVE wait here too when running, but are not individually hard-gated.
  - ALWAYS run Step 6 (verification pass) between reconciliation and artifact write. It is the only mechanism that catches lens agents asserting claims they never opened a file to confirm, and the only mechanism that validates `resolved-by` annotations against the actual branch via `git merge-base --is-ancestor`. Skipping Step 6 silently re-admits the failure mode this skill was designed to prevent.
  - PRESERVE severity emoji/naming and frontmatter keys verbatim — `thoughts-locator` / `thoughts-analyzer` grep these.
  - Bundled row-only specialists at narrativisation-prone sites: `diff-auditor` (Wave-2 Q+S), `peer-comparator` (Wave-1 PM), `claim-verifier` (Step 6). See `.rpiv/guidance/agents/architecture.md`.
- **Agent roles**:
  - `integration-scanner` (Wave-1) — inbound/outbound refs, auth-boundary crossings.
  - `precedent-locator` (Wave-1) — git history + thoughts/.
  - `codebase-analyzer` ×1 (Wave-1, `ManifestChanged`) — dependencies parse.
  - `web-search-researcher` (Wave-1, `ManifestChanged`) — CVE/advisory lookups with LINKS.
  - `peer-comparator` ×1 (Wave-1, gated on `len(PeerPairs) > 0`) — peer-mirror check; tags Mirrored/Missing/Diverged/Intentionally-absent.
  - `diff-auditor` ×2 (Wave-2) — Quality, Security.
  - `codebase-analyzer` ×1 (Step 4a, gated) — predicate-trace.
  - `codebase-analyzer` ×1 (Step 4b, gated) — interaction sweep.
  - *(Step 4c, gated)* — gap-finder runs inline in the orchestrator (set arithmetic over coverage map; no agent).
  - `claim-verifier` ×1 (Step 6, always) — verification pass (grounds every reconciled finding at its cited `file:line`; tags Verified / Weakened / Falsified; Falsified dropped, Weakened demoted one tier).
