# Shared SSH plugin backend

`com.enest.ssh` and `com.enest.remote-desktop` bundle this source into their own `backend/index.cjs`. SSH sessions, SFTP, tunnels, OpenSSH config parsing, trust records, system commands and completion belong to these plugin packages. The host keeps a compatible `enest.ssh` RPC facade and the native file/vault/permission bridge.

`backend.node` is explicit full Node.js authority. A utility process isolates lifetime and faults; it is not an operating-system sandbox. The host binds every callback to its own plugin ID and runtime generation. File APIs continue to resolve selected handles in the host; trust records use the existing plugin-private `ssh.knownHosts.v1` key.

The entry receives `{type:'init',pluginId,generation,wcId}`, then `{id,pluginId,method,args}` requests. Responses use `{id,ok,data,error}`. Native calls use `{hostCall,method,args}` and `{hostResult,ok,data,error}`; streaming events use `{hostEvent:'event',args:[event]}` without an acknowledgement queue. Closing the instance aborts owned resources and terminates the process within the host's grace period.

The build stages locked `ssh2`, `asn1`, `bcrypt-pbkdf` and required JavaScript dependencies inside the plugin. Optional `cpu-features`, `nan` and `sshcrypto.node` are omitted so one backend package works across Electron platforms using Node crypto. No host Electron or main-process module is bundled.

From the plugin repository:

```sh
npm run typecheck --workspace @enest/ssh-backend
npm test --workspace @enest/ssh-backend
node scripts/build-plugin.mjs com.enest.ssh com.enest.remote-desktop
```

The host repository additionally has `src/main/ssh/sshBackendClient.test.mjs` for ownership and process lifetime, and opt-in `sshUtility.smoke.test.mjs` for real built plugin utility processes against an isolated local OpenSSH server (`ENEST_ELECTRON_SSH_SMOKE=1`). The native smoke validates both plugin entries, strict host fingerprints, key handles, exec, SFTP hashes, rejected raw paths/cross-plugin handles, TCP tunnels and process cleanup. It does not test permission dialogs or Windows/Linux native execution.
