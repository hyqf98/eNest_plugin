# Historical fixtures

These two files were moved from the shell's former `src/main/dsh` directory when
the business implementation moved into this plugin. Source references and mock
module paths now point to the plugin backend, and the network mock targets its
proxy-aware adapter rather than Electron.

They retain the previous assertions and fixture design for historical context.
They have not been executed or repaired during the migration and are not included
in `test:backend:migration`. The new sibling `backend-migration.test.mjs` verifies
the current transport, ownership, storage and child-process lifecycle contracts.
