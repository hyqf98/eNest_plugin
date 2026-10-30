# LAN share backend

The plugin owns its HTTP listener, download codes, file/Range responses, expiry,
address discovery and transfer events. There are no third-party backend packages.
eNest 0.0.1 or later is required. Upgrading requires an explicit `backend.node`
grant; an old `lan.share` grant does not authorize native Node code.

The renderer passes only handle IDs returned by the host's native picker or its
confirmed drop flow. The backend uses generic `files.open/read/close` host
controls; no selected absolute path is returned by that bridge. Each download
reads at most 64 KiB at a time with stream backpressure. The host retains file
descriptors, validates the current incarnation and checks file identity/size/
mtime around each bounded read. This is capability-based file handling, not a
claim that a trusted `backend.node` process itself is OS-sandboxed.

Limits: 64 files per share, 4 GiB per file, 4 shares per incarnation (also subject
to the host's 64 total descriptors), 8 connections per share, 64 HTTP requests
per second, and 1-120 minutes. HEAD does not count as a download; only a completed
full GET counts. An active share retains one activity lease, released on stop.
Shutdown aborts transfers, closes listening and keep-alive sockets, closes file
tokens and suppresses events for the retired incarnation. The host's utility
process termination and file-capability disposal remain the fallback.

The share endpoint is HTTP, visible to the local network only after the user
presses Start. Share codes/URLs are bearer credentials. Do not expose the port to
the public internet; traffic is not encrypted.

New migration checks (temporary files and `127.0.0.1` only):

```sh
node --test plugins/lan-share/backend/tests/selected-file-sharing.test.mjs
```
