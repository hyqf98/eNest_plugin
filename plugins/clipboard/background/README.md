# Clipboard Background

`history.mjs` owns the complete history model and business policy. It imports neither Node nor Electron, starts no timer, and does not write to the frozen frontend host API. `assets/background.html` registers it in the generic sandboxed background runtime.

- Native changes arrive as `clipboard.changed` snapshots. The host owns OS access, permission checks, bounded delivery, instance cancellation, and its single shared native observer, not history records or retention policy.
- `eventSettings` binds that event to the plugin-declared `monitoring` switch. The host interprets the declaration generically; it does not know what a history limit or excluded application means.
- `history.*` calls are plugin-private methods over `enest.background.call`. `src/js/history-api.mjs` adapts them for this plugin's existing UI. Copy, paste, and confirmed file reveal remain foreground native actions.
- All events, calls, and Quick searches use one serialized writer. A mutation persists its document before ACK; unused blobs are removed only after the index commit. Native publication failures can retry, and same-generation revision checks reject stale snapshots.
- A background can be recreated after idle disposal. Its durable document and blob storage are private to its plugin, independent of visible UI lifetime. Temporary UI consent never authorizes continuing clipboard observation.
- The performance panel's stop action retires the background and its native subscription until an explicit foreground call, disable/enable cycle, or updated build. Ordinary settings refreshes and Quick searches do not restart a manually stopped runtime.
- Legacy import treats the host's fixed-source document as opaque until it reaches this plugin. The plugin validates every record, preserves IDs and unknown fields, imports one image at a time with stable blob IDs, persists the new index, then commits the host migration marker. A failed migration leaves original files intact. No retention trimming runs during import.
- Clipboard images are limited to 8 MiB. History documents are limited to 16 MiB; a larger legacy source fails without replacing or deleting it. The host can grandfather a verified old-attachment byte budget instead of rejecting a valid old collection at the ordinary private-blob quota.

Background entrypoints require production-built assets. Source-preview development can keep its Vite frontend while the isolated background loads the matching `dist/assets/background.html`; run the plugin build and reload after changing background code. Missing or mismatched built output fails explicitly instead of enabling Node, network access, or arbitrary source paths. A short Quick search deadline may return no results while a cold import finishes; it does not cancel that durable import.

The new focused cases are `tests/background-migration.test.mjs`; they use synthetic in-memory data only. Host native/migration adapters have separate new fixture tests. Historical test suites and real user clipboard data are not required for these cases.
