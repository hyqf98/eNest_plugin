# SQL intelligence

This is plugin-owned local analysis. No SQL is executed by a suggestion, diagnostic,
preview or signature request. Database metadata and drivers belong to this plugin's
backend; the host provides only generic native capabilities and permission checks.

The current interaction follows the user's decision to keep completion in a list beneath
the cursor. Types, comments, signatures and short SQL summaries belong in candidate rows.
Accepting a field group, star expansion or generated query does not open a confirmation
dialog or a separate completion-details panel. Text previews remain inside the settings
playground only.

## Boundaries

| Module | Responsibility |
| --- | --- |
| `completionEngine.js`, `contracts.d.ts` | Pure request/response contract; assemble providers |
| `syntax/` | Offset-preserving tokens, statement boundaries, query blocks, aliases, CTE and derived output |
| `dialects/registry.js` | Explicit dialect families, quoting, functions, pagination and feature coverage |
| `providers/` | Objects, fields, relationships, projections, templates, enums and diagnostics |
| `ranking/` | Semantic/context validity before matching and bounded usage preferences |
| `edits/` | Atomic offset edits and declarative snippet expansion |
| `metadata/` | Scoped identities, read-only sessions, lazy discovery, TTL, LRU, invalidation and request coalescing |
| `configuration/` | Versioned schema, validation, inheritance, migration and stable rule IDs |
| `settings/` | Draft forms, physical SELECT field extraction, pointer/keyboard ordering, scoped functions/enums/profiles, templates, playground and import/export |
| `runtime/`, `index.js` | Worker transport, sanitized requests, session-local facts and atomic editor edits |
| `../completion.js` | Thin store/backend adapter; retains compatibility for native query languages |
| `../editor.js`, `../monacoEditor.js` | Present the list beneath the cursor, show inline summaries and apply only to the captured document/context |

Cross-directory production imports use `@db`. Node tests install the same mapping
through `plugins/database/tests/register-db-alias.mjs` from the plugin repository root
before dynamically importing a module.

## Extension recipe

1. Add a dialect descriptor and explicitly declare which structural features it supports.
   Unknown drivers use generic safe keywords and cannot silently inherit MySQL rewrites.
2. Add a pure provider returning stable candidate IDs and `EditPlan` offsets. Never reach
   the host, global store, editor or network from a provider.
3. Return unresolved table references in `requiredTables`. The runtime reads metadata
   using a separate read-only queue, never the user's transaction session.
4. Preserve complete object identities and server metadata flags. An invisible/generated
   column is not interchangeable with an ordinary column.
5. Add incomplete-SQL and ambiguity fixtures, including cursor-before-FROM and same-name
   objects in different schemas. Test text after applying the edit, not candidate count alone.
6. If a new setting is needed, add its schema validation, defaults, inheritance and UI/test
   together. Configuration is declarative JSON; JavaScript expressions are not evaluated.

## Correctness contract

- Candidates originate from a document version, connection/console generation and context.
  Typing, switching targets, changing configuration or invalidation retires stale responses.
  `CompletionTicket` checks only relevant metadata dependencies and competing same-name
  objects at acceptance; unrelated lazy cache fills do not invalidate a valid candidate.
- `EngineClient` runs one task and keeps at most 32 pending tasks. New work for the
  same document/method/channel supersedes old work; an active superseded task terminates
  its Worker without dropping other documents in the queue. Editor AbortSignals cancel
  analysis and waiters, never a shared read-only metadata read or a user query.
- The Worker receives only SQL, allowlisted context, schema metadata and configuration.
  Connection options, credentials, native handles and host APIs stay outside the Worker.
- All completion kinds use the same list beneath the cursor and apply directly on explicit
  acceptance. There is no confirmation dialog, field-picker dialog or separate completion-
  details panel. Acceptance is one undo operation; Escape dismisses the list without editing.
  Document, configuration, metadata and target-context guards still run before application.
- Cold `sel` candidates carry a deferred template identity. Only explicit acceptance
  loads the chosen table, then resolves that same candidate and rechecks the captured
  document, caret and metadata before applying one undoable edit.
- Function parameter information uses a `nonInsert` row in the same list; it is never
  inserted as SQL or shown in a separate parameter panel. Candidate `presentation` has
  explicit type/description fields, so comments containing separators remain intact.
- Rule scope omits a namespace for inheritance/any match, while `null` explicitly means
  no namespace. Capturing a SELECT field group preserves this distinction.
  Namespace/table filters run after binding the physical object, so an explicit
  cross-schema reference can use its own rules despite different editor defaults.
  Settings metadata reads use the selected connection's defaults and preserve empty
  namespaces without borrowing the active editor's database or transaction console.
- `COUNT(*)`, unresolved stars and unsafe projection syntax do not receive guessed rewrites.
  Common field groups are explicit user choices, separate from an exact star expansion.
- Temporary objects are console-local confirmed facts. They are never described through
  another session. Uncertain session-changing commands suspend structural completion until
  the session context is restored, instead of assuming the original schema is still active.
- Metadata errors remain visible states. Empty/denied/stale/truncated metadata is not evidence
  that a table has no columns.

## Coverage

The structured parser handles the tested query-block subset; it is not a full validating
SQL grammar. MySQL, PostgreSQL and SQLite have structural rewrite fixtures. Other dialect
adapters have explicit lexical/quoting/pagination coverage and conservatively disable
unsupported rewrites. Native document/graph/time-series query languages use the existing
host provider via a read-only compatibility session.

Current limitations include advanced procedural SQL, vendor-specific recursive syntax,
server semantic inference, and temporary tables whose shape requires executing a query.
No AI service, row-value sampling or external metadata upload is part of this engine.
