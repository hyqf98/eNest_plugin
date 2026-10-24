# DSH native backend

DSH runtime discovery, installation, profiles, backups, session parsing, Web/SDK
children and JSON-RPC are plugin-owned. The shell has no DSH action dispatcher,
business permissions or runtime dependency. It only supplies the standard
`backend.node` consent boundary and backend control protocol v1.

## Compatibility and lifecycle

- `appDataPath/dsh-home`, `appDataPath/dsh-runtime` and
  `appDataPath/backups/dsh` are retained verbatim. No automatic data move occurs.
- `packagePath/runtime` is the only bundled runtime location. The host resolves
  the development `dist` directory before passing `packagePath`.
- `appExecPath`, not the utility process executable, runs JavaScript runtimes.
- Business requests acknowledge a client job ID promptly; `dsh.job` events carry
  their results. The standard shell RPC timeout remains 30 seconds.
- Jobs and live children hold host activity leases. Only actual child spawn/exit
  emits `process.track`/`process.untrack`. The shell verifies ancestry and start
  time; the plugin always kills its original `ChildProcess`, never a found PID.
- A Web runtime becomes ready only after its live loopback endpoint grant is
  acknowledged. Shutdown aborts jobs and downloads immediately, terminates
  children and waits for their exit before sending `shutdown.complete`.
- Downloads resolve the shell's current proxy per request and redirect. DIRECT,
  HTTP/HTTPS CONNECT, SOCKS4 and SOCKS5 routes are handled in the plugin; download
  bodies never pass through the shell. Existing checksum, archive path, symlink,
  size and atomic-promotion checks remain in place.

`contracts/dsh-workbench.ts` is private to this plugin. Its read/chat/admin action
groups validate the existing API surface; they are not shell permissions.
`backend.node` is a trusted native-code permission and is not granted by an old
`dsh.*` permission. The shell still isolates the renderer and controls its native
backend lifetime and endpoint grants.

## Verification

- `npm run typecheck:backend --workspace=dsh`
- `npm run test:backend:migration --workspace=dsh` runs only the new migration
  fixtures, using temporary storage and synthetic local runtimes.
- `tests/legacy` retains the prior shell fixtures as historical material. They
  are deliberately excluded from the new verification command.

Real runtime release download, existing user-profile mutation and live AI
sessions require separate user-approved acceptance checks; the fixtures do not
access the user's DSH directories, credentials or remote services.
