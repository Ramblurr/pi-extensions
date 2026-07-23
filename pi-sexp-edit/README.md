# pi-sexp-edit

> **Status:** implementation specification. This directory intentionally contains
> no implementation yet.

`pi-sexp-edit` is a custom Pi extension for reading and editing Clojure forms
through compact structural handles. An agent selects a form by copying a handle
from `sexp_read`; it never has to reproduce the existing form as a text-matching
argument.

The extension runs locally inside Pi. It has no MCP integration, daemon, socket,
or network service. TypeScript registers the Pi tools and invokes short-lived
Babashka processes. Package-local Clojure code owns parsing, reconciliation,
validation, delimiter repair, and syntax-preserving edits.

This document is the implementation contract for the first release.

## Central contract

The public interface describes syntax nodes, not lines, columns, byte offsets,
regular expressions, or old source text.

A handle such as `§h` identifies one exact version of one structural occurrence:

- unrelated external edits do not invalidate it;
- moving it within a uniquely reconcilable sibling sequence does not invalidate
  it;
- changing its concrete subtree does invalidate it;
- deleting it invalidates it;
- an ambiguous duplicate mapping invalidates it;
- a retired handle is never rebound or reused.

The implementation maintains this contract with per-node concrete hashes,
top-down occurrence addresses, and conservative old-tree/new-tree
reconciliation. A whole-file hash may be used internally as a fast path, but it
is not a public precondition and a changed root does not by itself reject an
edit.

## Goals

- Provide a structural interface for Clojure-family source and data files.
- Preserve untouched source text byte-for-byte.
- Preserve comments, whitespace, commas, reader syntax, and formatting.
- Give duplicate forms distinct handles.
- Preserve handles for uniquely reconciled, unchanged occurrences across
  separate calls and out-of-band edits.
- Reject only requested targets that changed, disappeared, or became ambiguous.
- Apply multiple edits from one call as one transaction.
- Validate all model-supplied Clojure before writing.
- Attempt bounded delimiter repair before rejecting malformed model output.
- Integrate with Pi cancellation, output limits, and its per-file mutation
  queue.
- Keep Clojure parsing and transformation logic in included `.clj` files invoked
  through `bb`.

## Non-goals

- No MCP integration or long-running Babashka process.
- No project-code evaluation, macroexpansion, namespace loading, or semantic
  analysis.
- No claim that `(inc x)` and `(+ x 1)` are equivalent.
- No whole-file formatter.
- No public line, column, offset, or text-match selectors.
- No persistence across Pi restart or `/reload` in the first release.
- No `dry_run` in the first release.
- No handles for comment or whitespace nodes in the first release.
- No automatic three-way source merge.
- No cross-process compare-and-swap, advisory locking, or other lost-write
  protocol in the first release. Use Pi's normal mutation queue and atomic file
  replacement, but do not claim coordination with arbitrary external writers.
- No preservation of handles for nodes moved across different parents in the
  first release. Reordering within one matched parent may be reconciled.

## Terminology

**Document**
: A process-local record for one canonical file path. It owns a compact document
  ID, the latest observed source snapshot, and all issued handles.

**Structural node**
: A rewrite-clj syntax node eligible for display or editing. Whitespace and
  comments participate in concrete hashing and source preservation but are not
  structural targets in version 1.

**Concrete subtree hash**
: A SHA-256 commitment to a node's tag and exact rendered subtree, including all
  concrete syntax owned by the node.

**Occurrence address**
: A top-down, snapshot-specific hash derived from the document identity, parent
  address, structural child role, and structural child index.

**Handle**
: An opaque, document-scoped ID such as `§h`. Handles are allocated
  monotonically and are not derived directly from source hashes or positions.

**Active handle**
: A handle that reconciles to exactly one current node whose concrete subtree is
  unchanged from the version represented by the handle.

**Retired handle**
: A handle that changed, was deleted, became ambiguous, or was explicitly
  replaced. Retirement is permanent within the document record.

## Public tools

The extension registers exactly two tools in version 1:

- `sexp_read`
- `sexp_edit`

There is no public hash or revision parameter. The versioned target handle is the
optimistic precondition.

### `sexp_read`

`sexp_read` has two strict input variants.

Open or refresh a path:

```json
{
  "path": "src/example.clj",
  "depth": 0,
  "include_atoms": false
}
```

Inspect an open document, optionally below one handle:

```json
{
  "document": "D4",
  "target": "§7",
  "depth": 2,
  "include_atoms": false
}
```

Schema requirements:

- Accept exactly one of `path` or `document`.
- Allow `target` only with `document`.
- `depth` is an integer from `0` through `20`.
- `include_atoms` is boolean.
- Reject unknown properties.
- Resolve relative paths against `ctx.cwd`.
- Normalize one leading `@` from a path, matching Pi's built-in file tools.
- Canonicalize an existing path before document lookup.
- Accept `.clj`, `.cljs`, `.cljc`, `.bb`, `.edn`, and `.cljd` files.

Defaults:

- Opening or refreshing a document defaults to `depth: 0` and renders collapsed
  top-level forms.
- Inspecting a target defaults to `depth: 2`.
- `include_atoms` defaults to `false`.

An opening result should resemble:

```text
document: D4
path: src/example.clj

§1 (ns example.core ...)
§7 (defn calculate-total [x] ...)
§m (defn report-total [x] ...)
```

Inspecting `§7` should resemble:

```text
document: D4
target: §7

§7 (defn calculate-total [x]
  §b (let [fee §e (fee-for x)]
    §h (+ x fee)))
```

The result intentionally contains no file hash or revision.

#### Rendering rules

- The marker is the single `§` character followed by a lowercase base-36 ID.
- Marker syntax must live behind one shared constant.
- Annotations are presentation metadata and are never written into the file.
- Compound nodes and reader nodes receive visible handles by default.
- Symbols, keywords, strings, characters, booleans, nil, and numbers receive
  handles only when `include_atoms` is true.
- Comments, whitespace, commas, and line breaks never receive handles.
- Atomic forms still render when `include_atoms` is false; they simply lack
  annotations.
- `depth: 0` renders a compact summary of each selected root. Every collapsed
  node needed for later inspection must retain a visible handle.
- Increasing depth expands structural descendants. It does not change source.
- Only handles actually included in tool output are considered advertised to the
  agent.
- Truncate output at Pi's standard 2,000-line or 50-KB limit and clearly report
  that truncation occurred.

`§` is legal inside a Clojure symbol. Do not reject arbitrary symbols merely
because they contain `§`. During edit validation, reject only a symbol token that
exactly equals an active handle issued by the current document. This catches a
copied annotation without banning legitimate project symbols such as
`price§bucket`.

#### Read-time reconciliation

Opening an already-known canonical path or reading an existing document must
parse the latest source and reconcile it with the stored snapshot. A changed
root does not create a new document ID.

A successful read may:

- preserve handles for unchanged, uniquely mapped nodes;
- retire changed, deleted, or ambiguous handles;
- allocate handles for newly displayed nodes;
- update the document's observed snapshot without modifying the file.

If current source does not parse, return a parse error, modify no file, and keep
the last good document snapshot.

### `sexp_edit`

`sexp_edit` accepts one document and a non-empty edit array:

```json
{
  "document": "D4",
  "edits": [
    {
      "target": "§e",
      "operation": "replace",
      "new_form": "(lookup-fee x)"
    },
    {
      "target": "§h",
      "operation": "replace",
      "new_form": "(- x fee)"
    }
  ]
}
```

The schema must reject unknown properties and support these operations:

| Operation | `new_form` | Meaning |
| --- | --- | --- |
| `replace` | required | Replace the target with one or more complete forms. |
| `delete` | forbidden | Remove the exact target node. |
| `insert_before` | required | Insert one or more forms immediately before the target. |
| `insert_after` | required | Insert one or more forms immediately after the target. |

`new_form` may contain multiple complete forms when the surrounding syntax can
accept them. The complete candidate file, not an operation-local guess, is the
final authority on whether the result is syntactically valid.

There is no `expected_hash`, `revision`, old form, path, line, or column in this
request.

#### Edit execution

For every call:

1. Resolve the document record and canonical path.
2. Read and parse the latest source.
3. Reconcile the stored tree with the latest tree.
4. Resolve every requested handle against that same reconciled pre-edit tree.
5. Validate and, when allowed, repair every `new_form`.
6. Reject the complete batch if any target or operation conflicts.
7. Apply all operations structurally with rewrite-clj.
8. Reparse the complete candidate source.
9. Produce a unified diff from the latest pre-edit source to the candidate.
10. Atomically replace the file.
11. Rebuild hashes, allocate replacement handles, and commit the new document
    snapshot only after the file write succeeds.

All targets are resolved before any operation is applied. An earlier edit cannot
move the location used to resolve a later target.

A successful result should include:

```text
document: D4
external_changes_reconciled: true
applied_edits: 2
retired_handles: §e §b §7 §h
created_handles: §k §m §n §p

<unified diff>

<compact annotated excerpts around changed forms>
```

The exact handles above are illustrative. Return:

- whether the pre-edit source differed from the stored snapshot;
- the number of applied operations;
- repairs applied to model input;
- advertised handles retired by reconciliation or mutation;
- handles created for replacements, insertions, and changed displayed
  ancestors;
- a unified diff containing only the extension's edit against the latest source;
- compact annotated excerpts that let the agent continue editing.

Do not flood output with hidden internal handles. Report all affected handles
that were previously advertised, all new handles shown in the excerpt, and
counts for any omitted internal changes.

#### Edit errors

An edit must write nothing when:

- the document is unknown, such as after `/reload`;
- current source cannot be parsed;
- a requested handle is unknown or retired;
- a requested handle changed, was deleted, or cannot be mapped uniquely;
- batch targets overlap incompatibly;
- tool arguments or operation-specific constraints are invalid;
- delimiter repair fails;
- replacement text still does not parse after repair;
- the complete candidate file does not parse;
- the write fails or is cancelled.

Return structured error details with:

- the target handle, when applicable;
- one of `unknown`, `changed`, `deleted`, `ambiguous`, `batch-conflict`,
  `invalid-form`, `repair-failed`, `invalid-candidate`, or `write-failed`;
- a concise explanation;
- a refreshed excerpt and replacement handle when a changed logical container
  was reconciled confidently enough to display, but never silently retarget the
  failed edit.

Successful observation of external source may update the in-memory reconciled
snapshot even when the requested mutation conflicts. Candidate mutation state
must never be committed after a failed write. If current source cannot be
parsed, preserve the last good snapshot.

## Handle and hash model

### Immutable versioned handles

A handle is an immutable reference to the exact concrete subtree seen when that
handle was issued or last preserved.

Required lifecycle rules:

- Unchanged, uniquely reconciled nodes retain their handles.
- A changed node retires its old handle and receives a new handle if displayed.
- Replacing a target always retires the target handle, even when replacement
  produces exactly one form.
- Deleting a target retires the target and every issued descendant handle.
- Inserting forms does not retire unchanged sibling handles.
- Changing a descendant retires every issued ancestor handle whose concrete
  subtree changed.
- An unchanged descendant may retain its handle after its ancestor changes if
  reconciliation maps it uniquely.
- Duplicate nodes always have distinct opaque handles.
- Retired IDs are never reused or resurrected.
- Handles are scoped by document ID; `§7` in two documents has no relationship.

This differs deliberately from a persistent object ID. It prevents an old tool
call from silently applying to replacement content through a familiar handle.

### Concrete subtree hashes

Compute a SHA-256 hash for every syntax node. The required invariant is:

> Except for cryptographic collision, equal concrete subtree hashes mean equal
> node tags and byte-for-byte equal rendered subtree source.

Use domain-separated, length-prefixed hashing. A simple acceptable encoding is:

```text
C(node) = SHA-256(frame("concrete-node", node-tag, exact-rendered-source))
```

An implementation may instead hash a canonical interleaving of node-local
concrete fragments and child hashes, but it must account for every delimiter,
reader prefix, comment, comma, and whitespace byte. Do not use `pr-str` or parsed
values as the hash input.

Container hashes change when any owned descendant changes. Equal container
hashes therefore allow the reconciler to preserve the entire subtree without
examining individual descendants.

Intentional duplicate hashes are normal. Never treat a subtree hash as a unique
node ID.

### Top-down occurrence addresses

Content alone cannot distinguish duplicate siblings, so each snapshot also has
a top-down structural address:

```text
A(root) = SHA-256(frame("document-root", document-id))

A(child) = SHA-256(frame("structural-address",
                        A(parent),
                        child-role,
                        structural-child-index))
```

A snapshot fingerprint may combine both dimensions:

```text
F(node) = SHA-256(frame("node-version", A(node), C(node)))
```

These hashes are internal. The opaque `§…` handle remains the public reference.

`structural-child-index` counts addressable form children in concrete order. It
must not count whitespace, comments, commas, or line breaks, because adding
trivia must not renumber structural siblings. `child-role` distinguishes edges
such as top-level form, collection element, map key, map value, metadata, reader
operand, and discard operand where rewrite-clj exposes that distinction.

Do not derive a child address from the parent's concrete content hash. Doing so
would change every descendant address after any sibling edit and recreate
whole-file invalidation at each container.

Addresses are snapshot locations, not permanent identity. Inserting a preceding
sibling may change an unchanged node's address. Reconciliation may transfer its
opaque handle to the new address when the correspondence is unique.

### Why indices do not eliminate ambiguity

Indices distinguish duplicates in one snapshot:

```text
parent: [A A]

first A  -> H(parent-address, 0)
second A -> H(parent-address, 1)
```

They cannot recover unobserved history:

```text
old: [A A]
new: [A A A]
```

The new form may have been inserted before, between, or after the old forms.
Every current position has a distinct address, but no source fact identifies
which position is new. The old duplicate handles must be retired rather than
mapped by an arbitrary LCS tie-break or nearest-index guess.

## Reconciliation

The reconciler compares the last good parsed snapshot with freshly parsed
source. It returns a partial, injective mapping from old nodes to current nodes.
Only mappings supported uniquely by structural evidence may preserve handles.

### Stored document state

The Babashka side should return opaque JSON state containing at least:

```clojure
{:document-id "D4"
 :canonical-path "/absolute/path/src/example.clj"
 :next-handle-id 23
 :baseline-source "... exact last observed source ..."
 :handles {"§7" {:path [...]
                  :node-tag :list
                  :concrete-hash "..."
                  :advertised? true
                  :status :active}}
 :retired-handles {"§3" {:reason :changed}}}
```

Field names may differ, but the semantics may not. Because Babashka processes
are short-lived, the state must contain enough data to reparse the old snapshot
and reattach issued handles. Do not attempt to retain rewrite-clj zipper objects
across processes.

Keeping the exact baseline source plus a compact handle manifest is the
recommended first implementation. The TypeScript layer treats this state as
validated opaque data.

### Reconciliation procedure

1. Parse the baseline source and current source as complete rewrite-clj roots.
2. Verify each active handle's stored path and concrete hash against the
   baseline tree. Treat disagreement as corrupt internal state.
3. Pair the two document roots.
4. If a paired node has equal concrete hashes, pair its complete structural
   subtree positionally and preserve all active handles within it.
5. If a paired container differs, align its ordered structural child sequences.
6. Recurse only through child pairs whose occurrence correspondence is unique.
7. Produce exactly one of `preserved`, `changed`, `deleted`, or `ambiguous` for
   every issued active handle affected by the comparison.
8. Allocate no new public handles until a node is rendered in a result.

Use these sources of matching evidence, from strongest to weaker:

1. Equal concrete subtree hash at the same structural edge.
2. Equal concrete subtree hashes unique within the current matched-parent
   segment.
3. Unique, compatible named-declaration keys, such as list head plus declared
   symbol for `ns`, `def`, `defn`, `defmacro`, `defmulti`, `defmethod`,
   `defrecord`, `deftype`, and `defprotocol` forms.
4. Unique order-preserving sequence alignment by exact subtree hash.
5. A one-old/one-new unmatched gap with compatible node tags, used only to pair
   a changed container for recursive inspection. The changed container's own
   handle still retires.

Named keys and compatible shape can pair changed containers so the reconciler
can discover unchanged descendants. They never preserve the changed container's
old handle.

The mapping must remain one-to-one and order-preserving within a matched parent,
except that a uniquely keyed or uniquely hashed child may be recognized after a
reorder within that same parent. Version 1 need not track a subtree moved to a
different parent.

A conventional LCS implementation that selects one arbitrary optimum is unsafe.
For issued handles in duplicate runs, determine whether all valid optimal
alignments map the old node to the same current node. If more than one destination
is possible, mark it `ambiguous`.

Do not globally search for a familiar hash and assume that a unique copy is the
old occurrence after its parent disappeared. A deletion followed by an identical
insertion elsewhere is observationally indistinguishable from a move. Stay
conservative.

### Examples

An unrelated top-level change does not invalidate `§h`:

```text
old root                 current root
├── defn foo              ├── defn foo changed
└── defn bar              └── defn bar unchanged
    └── §h (+ x fee)          └── §h (+ x fee)
```

A sibling change inside one function may preserve `§h`:

```clojure
(defn calculate-total [x]
  (audit x)                         ; changed externally
  §h (+ x fee))                     ; exact subtree unchanged
```

Changing the target retires it:

```text
old:     §h (+ x fee)
current:    (+ x tax)
```

Duplicate forms remain distinct under an equal parent subtree because the
complete equal subtree maps positionally:

```clojure
(do
  §2 (foo)
  §3 (foo))
```

An insertion into an indistinguishable duplicate run is ambiguous:

```text
old children:     [A A]
current children: [A A A]
```

Both old handles in the run must fail if targeted unless surrounding structural
evidence proves a unique mapping.

## Conflict scope

The default conflict unit is the requested concrete subtree, not its whole file
or nearest top-level definition.

An external change is not a target conflict when the requested handle still maps
to one exact unchanged subtree. An external change is a target conflict when the
requested handle is changed, deleted, or ambiguous.

This is syntactic conflict detection, not semantic dependency tracking. An agent
may have reasoned about a parent while targeting only a child. Version 1 does not
infer those dependencies or automatically guard ancestors. A future release may
add optional `require_unchanged` handles, but that is not part of the first tool
schema.

## Transaction and batch rules

The `edits` array is one transaction. Resolve every target against one reconciled
pre-edit tree, validate the complete batch, and either write all operations or
none.

Reject at least:

- the same target edited more than once incompatibly;
- a target and one of its ancestors edited in the same batch;
- a target and one of its descendants edited in the same batch;
- insertion relative to a node deleted or replaced incompatibly by the batch;
- deletion or replacement that makes another target boundary meaningless;
- an operation that leaves invalid syntax in its surrounding context;
- any invalid target, even when other targets are valid.

For independent sibling edits, apply operations in a way that is independent of
source offsets. For multiple insertions at the same boundary, preserve request
order in the resulting source.

Replacement or deletion retires handles according to the final tree, not the
order in which zipper operations happen internally. Return all previously
advertised handles retired by the transaction.

## Parsing and syntax preservation

Use [`rewrite-clj`](https://github.com/clj-commons/rewrite-clj) for the concrete
syntax tree and zipper mutations.

Requirements:

- Parse the complete file, including multiple top-level forms.
- Preserve reader conditionals, splicing reader conditionals, metadata, tagged
  literals, anonymous functions, quote forms, syntax quote, unquote, deref,
  var quote, discard forms, namespaced maps, auto-resolved keywords, comments,
  commas, and whitespace.
- Never convert nodes through `pr-str` when preserving source.
- Never evaluate forms or resolve project namespaces.
- Reparse the complete candidate source before writing.
- Preserve all unrelated source bytes exactly.

Use an explicit rewrite-clj dependency compatible with Babashka. Version `1.2.55`
is the design baseline. The first release may require Babashka `1.12.218` or
newer; verify this combination in automated tests before publishing.

### Comment ownership

Version 1 uses the exact-node model:

- A contiguous leading comment does not belong to the following form.
- Replacing or deleting a form leaves its immediately preceding comments and
  surrounding trivia in place.
- Comments inside a replaced or deleted collection belong to that collection's
  concrete subtree and disappear with it.
- Comment nodes do not receive public handles.
- Inserting a form does not move or delete existing comments.

This conservative rule may leave an orphaned leading comment after deletion. It
is preferable to silently deleting prose the agent did not select.

### Local indentation

Do not run a formatter. Reindent only model-supplied multiline forms relative to
the selected structural boundary:

- Place the first line at the target or insertion boundary.
- Shift continuation lines by the target node's starting indentation while
  preserving their relative indentation.
- Preserve blank lines and relative indentation within the supplied form.
- Do not reindent unrelated existing nodes.

For example, replacing a form that begins after four spaces with:

```clojure
(let [fee (lookup x)]
  (+ x fee))
```

should produce:

```clojure
    (let [fee (lookup x)]
      (+ x fee))
```

The implementation may use internal row and column data for this purpose. Such
coordinates must never appear as public selectors.

## Validation and delimiter repair

Model-supplied source requires defense in depth.

For each `new_form`:

1. Validate JSON and operation-specific requirements in TypeScript.
2. Repeat operation-specific validation in Babashka.
3. Attempt to parse the text as one or more complete rewrite-clj forms.
4. If parsing fails because of a missing, extra, or mismatched delimiter, call
   `borkdude.parmezan/parmezan` on the exact supplied text.
5. Parse the repaired result again as one or more complete forms.
6. Reject any parsed symbol token that exactly equals an active handle in the
   current document.
7. Apply local indentation after repair and before insertion.
8. After all operations, parse the complete candidate file again.

Call Parmezan as a library:

```clojure
(require '[borkdude.parmezan :as parmezan])

(parmezan/parmezan malformed-source)
```

Do not require the `parmezan` executable. Pin this reviewed source revision:

```text
repository: https://github.com/borkdude/parmezan
Git SHA:    772feae8ae7fe08cda829033788c677d21599c43
```

Parmezan repairs only delimiter errors reported through Edamame's
`:edamame/expected-delimiter` data. A non-delimiter parse failure should propagate
as invalid input rather than trigger speculative rewriting.

Repair rules:

- Repair only `new_form` supplied by the model.
- Never repair existing file content implicitly.
- Never repair after partially applying a batch.
- Run repair inside the bounded, cancellable Babashka invocation.
- Revalidate repaired output with rewrite-clj.
- Reject the entire batch when any repair or validation fails.
- Report every successful repair with exact before and after text or a concise
  unified diff.
- Never silently write repaired text.

If existing source is malformed, both tools return a parse error and write
nothing.

## Extension architecture

### TypeScript responsibilities

The TypeScript entry point must:

- register `sexp_read` and `sexp_edit` with `pi.registerTool()`;
- define strict TypeBox schemas and agent-oriented descriptions;
- resolve and canonicalize paths;
- own the path-to-document and document-ID lookup maps;
- retain validated opaque Babashka state in memory;
- serialize concurrent operations on one document with an in-memory lock;
- wrap file mutations with `withFileMutationQueue()` using the canonical path;
- invoke `bb` through `pi.exec()` so cancellation propagates;
- enforce a bounded process timeout;
- locate package files relative to `import.meta.url`;
- perform atomic file replacement and permission preservation;
- truncate user-facing output with Pi's standard limits;
- convert structured Babashka failures into Pi tool errors;
- never interpolate source, replacement text, or paths into a shell command.

### Babashka responsibilities

Package-local Clojure code must own:

- rewrite-clj parsing;
- structural child enumeration;
- concrete and address hashing;
- old/new tree reconciliation;
- ambiguity detection;
- handle allocation, preservation, and retirement;
- collapsed annotated rendering;
- operation validation;
- Parmezan repair;
- zipper mutations;
- local indentation;
- complete candidate validation;
- diff input and compact changed excerpts;
- updated opaque document state.

The TypeScript layer should not understand or reproduce the Clojure tree.

### Short-lived JSON protocol

Every request starts a new `bb` process. Use one JSON request and one JSON
response. Babashka stdout must contain exactly one response object; diagnostics
go to stderr.

A command should resemble:

```text
bb --config /absolute/path/to/pi-sexp-edit/bb.edn \
  -m pi-sexp-edit.main --request /private/temp/request.json
```

Source snapshots and replacement forms must not appear in command-line
arguments. If `pi.exec()` cannot provide stdin, create a mode-`0600` temporary
request file, pass only its path, and delete it in `finally`.

The response envelope should be explicit:

```json
{
  "ok": true,
  "result": {},
  "state": {}
}
```

or:

```json
{
  "ok": false,
  "error": {
    "code": "ambiguous",
    "message": "Handle §h no longer maps uniquely",
    "data": {}
  },
  "state": {}
}
```

Validate both envelopes in TypeScript. Reject malformed JSON, extra stdout,
missing fields, protocol version mismatches, and oversized responses.

Use `cheshire.core`, available in Babashka, for JSON. Include a protocol version
in requests and responses so incompatible package components fail clearly.

## File updates and concurrency scope

Within one Pi process:

- use one in-memory lock per document for both reads and edits;
- enclose the latest read, Babashka transformation, temporary write, rename, and
  candidate-state commit in Pi's canonical-path mutation queue;
- resolve every batch target before writing;
- update candidate state only after a successful rename.

For atomic replacement:

1. Write the candidate to a temporary file in the target directory.
2. Preserve the original file's permission bits.
3. Flush and close the temporary file.
4. Rename it over the target atomically where the platform allows.
5. Remove temporary files after failure or cancellation.

The returned unified diff must compare the latest source read by `sexp_edit` with
the committed candidate, so out-of-band edits already present do not appear as
changes made by the tool.

Version 1 deliberately does not add a cross-process lock or filesystem
compare-and-swap protocol. Merkle reconciliation prevents broad stale-target
rejection; it does not by itself eliminate a writer changing the file during the
mutation window. Do not describe the tool as solving that separate problem.

## Proposed project layout

The package should remain self-contained:

```text
pi-sexp-edit/
├── README.md
├── LICENSE
├── package.json
├── index.ts
├── bb.edn
├── src/
│   └── pi_sexp_edit/
│       ├── main.clj
│       ├── protocol.clj
│       ├── parse.clj
│       ├── hashes.clj
│       ├── reconcile.clj
│       ├── handles.clj
│       ├── render.clj
│       ├── edit.clj
│       ├── repair.clj
│       └── validation.clj
└── test/
    ├── pi_sexp_edit/
    │   ├── hashes_test.clj
    │   ├── reconcile_test.clj
    │   ├── read_test.clj
    │   ├── edit_test.clj
    │   └── repair_test.clj
    └── index.test.ts
```

The implementer may combine small namespaces, but hashing, reconciliation, and
mutation logic should remain independently testable.

### `package.json`

Declare:

- package name `@ramblurr/pi-sexp-edit`;
- `type: "module"`;
- MIT license;
- `pi-package`, `pi-extension`, and `clojure` keywords;
- `./index.ts` under `pi.extensions`;
- the Pi coding-agent package as a peer dependency;
- TypeBox according to the Pi package conventions;
- every `.clj` source file, `bb.edn`, README, and LICENSE in published files;
- scripts for TypeScript tests, Babashka tests, and the combined suite.

Assume `bb` is available on `PATH`. Do not run package installation with npm
lifecycle scripts enabled contrary to the user's npm configuration.

### `bb.edn`

Use package-relative source and test paths. Pin dependencies rather than relying
on a developer checkout. The intended coordinates are:

```clojure
{:paths ["src"]
 :deps {rewrite-clj/rewrite-clj {:mvn/version "1.2.55"}
        borkdude/parmezan
        {:git/url "https://github.com/borkdude/parmezan"
         :git/sha "772feae8ae7fe08cda829033788c677d21599c43"}}}
```

Add a test task and any test-only paths needed by the implementation. Verify the
resolved Parmezan transitive Edamame dependency under Babashka `1.12.218`.

## Testing requirements

Safety matters more than aggressive handle preservation. Tests must prove that
the reconciler rejects uncertain mappings rather than merely demonstrating that
common edits work.

### Hash and address tests

Cover:

- deterministic SHA-256 framing;
- node tags and exact source affecting concrete hashes;
- comments and whitespace inside a subtree affecting its concrete hash;
- equal duplicate forms receiving equal content hashes;
- duplicate siblings receiving different occurrence addresses;
- trivia not affecting structural child indices;
- a preceding structural insertion changing later addresses;
- parent content changes not cascading through the address formula;
- document IDs scoping root addresses.

### Reconciliation tests

Cover:

- equal roots preserving every handle;
- one changed top-level form preserving handles in other forms;
- one changed sibling preserving an unchanged nested target;
- changed ancestors retiring while unchanged descendants survive;
- replacements and deletions retiring old handles;
- newly inserted nodes receiving new handles only when rendered;
- unique insertion before duplicate siblings when sequence evidence is complete;
- `[A A]` to `[A A A]` producing ambiguity rather than arbitrary matching;
- duplicate hashes in different named forms mapping under the correct parent;
- comment-only and whitespace-only external edits preserving unaffected child
  handles while retiring changed container handles;
- safe reorder matching within one parent;
- no cross-parent global hash guessing;
- mapping injectivity;
- retired handle IDs never being reused;
- corrupt stored paths or hashes producing internal-state errors.

Add generative or table-driven sequence tests that enumerate all optimal
alignments for short duplicate sequences. Assert that a handle is preserved only
when every valid alignment gives it the same destination.

### Parsing, rendering, and edit tests

Cover:

- collapsed top-level rendering and nested inspection;
- atomic handles being opt-in;
- exact active annotation rejection without rejecting unrelated `§` symbols;
- byte-for-byte preservation of unrelated comments and whitespace;
- reader conditionals, metadata, discard forms, tagged literals, anonymous
  functions, namespaced maps, quoting forms, commas, and auto-resolved keywords;
- exact-node leading-comment behavior;
- local multiline indentation without whole-file formatting;
- replace, delete, insert-before, and insert-after;
- multiple replacement forms where legal;
- invalid surrounding contexts, including malformed map entry counts;
- sibling batch edits without positional cascades;
- target/ancestor and other batch conflict rejection;
- request ordering for insertions at one boundary;
- complete candidate parsing before write.

### Repair tests

Cover:

- missing closing delimiters;
- extra delimiters;
- mismatched delimiters;
- nested repair;
- repaired reader forms;
- non-delimiter parse errors propagating without speculative repair;
- repaired output being reparsed;
- every repair being reported;
- one failed repair rejecting the complete batch;
- malformed existing files never being repaired automatically;
- cancellation or timeout during repair writing nothing.

### TypeScript tests

Cover:

- strict public schemas and union validation;
- relative, absolute, canonical, and leading-`@` paths;
- canonical-path document reuse;
- package-relative Babashka invocation;
- mode-`0600` request files and cleanup;
- JSON protocol validation and non-zero exits;
- cancellation and timeout propagation;
- output truncation;
- per-document locks and per-file mutation queue coverage;
- process-local state reuse across separate calls;
- observation-state updates after external reconciliation;
- candidate state changing only after successful atomic writes;
- unknown documents after reload;
- file mode preservation.

### End-to-end acceptance cases

1. Read a file, edit one nested form, then use an untouched sibling's original
   handle in a second edit without rereading.
2. Read two functions, modify the first externally, and successfully edit an
   unchanged handle in the second.
3. Modify a sibling inside one function externally and successfully edit another
   uniquely reconciled sibling from the original read.
4. Change the requested target externally and confirm that the old handle fails
   without writing.
5. Insert an indistinguishable duplicate into a duplicate run and confirm that an
   ambiguous old handle fails without writing.
6. Replace one target and confirm that its old handle and changed ancestor
   handles retire while an unchanged descendant or sibling handle survives.
7. Apply several independent edits in one transaction.
8. Submit a form missing a closing delimiter and confirm that Parmezan repairs,
   reparses, applies, and reports it.
9. Submit irreparable input and confirm that the entire batch fails without a
   file change.
10. Add or edit a leading comment and confirm the exact-node ownership rules.
11. Restart or reload Pi and confirm that an old document ID fails and a new
    `sexp_read` is required.

## Implementation order

A separate implementation agent should proceed in this order:

1. Build pure parsing, structural-child enumeration, hashing, and framing.
2. Build reconciliation with exhaustive duplicate-sequence tests.
3. Build immutable handle lifecycle and opaque state serialization.
4. Build annotated rendering and read operations.
5. Build edit validation and transactional rewrite-clj mutations.
6. Add Parmezan repair and repair reporting.
7. Add the JSON Babashka entry point.
8. Add TypeScript schemas, process invocation, document lookup, and locking.
9. Add atomic writes, diffs, truncation, and cancellation.
10. Run all unit and end-to-end acceptance cases.

Do not optimize state size or matching aggressiveness before the safety
properties pass. A false conflict costs one reread; a false match edits the wrong
form.

## Definition of done

Version 1 is ready only when:

- agents can read and edit exclusively through document IDs and `§` handles;
- no public revision, content hash, position, or old-form argument exists;
- external changes outside a target do not cause blanket file-level rejection;
- unchanged duplicate occurrences remain distinct when reconciliation evidence
  is unique;
- irreducibly ambiguous duplicates fail safely;
- changed targets never retain their old handles;
- all batch operations are transactional;
- unrelated concrete source remains byte-for-byte unchanged;
- malformed model forms receive bounded, reported Parmezan repair attempts;
- malformed existing files are never repaired implicitly;
- all packaged Clojure logic runs in short-lived `bb` processes;
- no MCP, daemon, socket, or network service is introduced;
- the complete automated test suite passes under the declared Babashka and Pi
  versions.
