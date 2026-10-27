# Shared SSH plugin backend

`com.github.eNest.ssh` and `com.github.eNest.remote-desktop` bundle this source into their own `backend/index.cjs`. SSH sessions, SFTP, tunnels, OpenSSH config parsing, trust records, system commands, completion and all domain DTOs belong to these plugin packages. The browser-only `@enest/ssh-backend/client` adapter calls `enest.backend.call`; the host has no `enest.ssh` facade, SSH transport, action policy, or domain DTOs.

`backend.node` is explicit full Node.js authority. A utility process isolates lifetime and faults; it is not an operating-system sandbox. The host binds every callback to its own plugin ID and runtime generation. File APIs continue to resolve selected handles in the host; trust records use the existing plugin-private `ssh.knownHosts.v1` key.

The entry validates `{type:'init',pluginId,generation,wcId,context:{protocolVersion:1}}`, then accepts `{id,pluginId,method,args}` requests (32 pending, 4 MiB arguments, 8 MiB results). Responses use `{id,ok,data,error}`. Native calls use `{type:'host.request',id,method,params}` and `{type:'host.response',id,ok,data,error}`; streaming events use `{event,data}` without an acknowledgement queue. The client unpacks only matching `backend.event` envelopes. `{type:'shutdown'}` aborts owned resources and exits; the generic host confirms actual process exit before releasing its ownership barrier. SSH connect retains its 20-minute interactive timeout and direct SFTP transfers their 24-hour timeout through standard per-call options.

Native capability names are generic: `secret.resolve`, `permission.authorize`, `files.resolve`, `files.directoryTarget`, `files.pick`, `files.exportDirectory`, `files.export`, `storage.get/set`, `log.write`, `activity.acquire/release`. Each call is bound to the requesting runtime by the host. System SSH Agent access additionally requests the declared `ssh.agent` permission; obsolete `ssh.session/exec/sftp` permissions are not used. Releasing an activity before its acquire acknowledgement waits for that acknowledgement, preventing a late orphan lease.

Remote Desktop cannot borrow an SSH plugin session or vault reference. It must use a session or connection owned by its own backend; legacy profiles with only an SSH plugin profile ID fail with an actionable message. Local tunnel port `0` uses an OS-assigned loopback port and returns the actual bound port. Socket or WebSocket setup failure releases the tunnel and any dedicated SSH session.

The build stages locked `ssh2`, `asn1`, `bcrypt-pbkdf` and required JavaScript dependencies inside the plugin. Optional `cpu-features`, `nan` and `sshcrypto.node` are omitted so one backend package works across Electron platforms using Node crypto. No host Electron or main-process module is bundled.

From the plugin repository:

```sh
npm run typecheck --workspace @enest/ssh-backend
npm test --workspace @enest/ssh-backend
node scripts/build-plugin.mjs com.github.eNest.ssh com.github.eNest.remote-desktop
```

Current migration coverage is `tests/packaging/ssh-generic-backend.test.mjs` in the host repository. It uses isolated mocks for the generic transport, ownership, limits, native capabilities, event adapter, shutdown, dynamic loopback port allocation, and Remote Desktop cleanup. It does not establish a real SSH connection, read user keys, or claim native UI / remote-server acceptance. Older tests referencing the deleted host SSH facade are not migration acceptance tests.
