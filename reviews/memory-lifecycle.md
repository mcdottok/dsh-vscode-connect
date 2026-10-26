# connect 0.1.5 memory and lifecycle review

Date: 2026-10-24. Scope: the connect-owned API carrier, mux and discovery.
No installed plugin, desktop process, Profile, user session or credentials were
modified. The user will build and install. Desktop acceptance remains pending.

## Evidence and limits

The desktop crash reports identify the Host's V8 heap running out of memory
after long runs. They contain no allocation profile or heap snapshot, so they
cannot attribute the approximately 3.3GB heap to one plugin. Installed connect
metadata is 0.1.4 and its server code has the same persistent Peer and queued
refresh patterns audited here; generated bundle hashes differ from the local
artifact, so byte-for-byte build equivalence is not claimed.

Fixed-version contracts were checked in the public npm distributions
`@deepseek-ai/dsh-api-gateway@0.2.1-rc.2`, `@deepseek-ai/cordis@4.0.5` and the
public stream-protocol. Gateway's native upgrade path releases admission on
socket close before awaiting iterator cleanup. HTTP event-result requests and
their active event stream must retain the same Peer identity. Abort listeners
are removed per wait, following Node's [AbortSignal lifecycle guidance](https://nodejs.org/download/release/v22.12.0/docs/api/globals.html#class-abortsignal).

## Transport fixes

- The previous bridge retained a single owner Peer for the plugin lifetime.
  It now counts active HTTP and WebSocket leases, releases idle Peer scopes,
  and makes forced release idempotent. Credential exchange allocates no Peer.
- A completed HTTP response now aborts its request lifetime as well as removing
  the request from the active set. Shared Request-signal listeners can clean up.
- The old mux waited indefinitely for an opener, next read or generator return
  after cancellation. Its connection promise and Peer socket effect could then
  retain a dead socket, stream tables and queued data across reconnects.
  Cancellation now retires the transport task promptly; late openers receive
  return(), and uncooperative provider return() is contained without awaiting it.
  External provider code must still honor cancellation to release its own resources.
- Each pending read/write wait owns and removes its abort listener. It does not
  reuse a forever-pending cancellation promise across frames.
- Per-socket serialized writes are capped at 64MiB pending text; a write waiting
  over 10 seconds terminates the socket even if uplink/Pong traffic is alive.
  Closure settles the active write without relying on its send callback.

## Discovery follow-up

The 2-second publisher used an unconditional `queue.then(publish)` chain. A
blocked protection/write could retain indefinitely many pending refresh closures.
The worker now coalesces concurrent refresh requests into one pending promise and
one trailing refresh intent. Close stops scheduling and waits for the single
worker before withdrawing the discovery file. A 5000-request stalled-protection
case failed on 0.1.4 and now passes; late disable/close behavior stays covered.

## Reproduction and verification

Windows x64, Node 24.21.0. A separate source copy of 0.1.4 was tested without
replacing the working source. Five transport regression cases failed on the old code:
idle/request Peer cleanup, stalled opener cleanup, blocked
read/return cleanup, downlink timeout and pending-byte overflow. Those cases pass
on the corrected source. No build output is substituted for server source tests.
An additional race test checks forced disable/re-enable and idempotent Peer
release, so a late old-socket close cannot dispose a replacement generation.

Final direct test run: 24 passed / 0 failed, comprising 22 server-source cases
and 2 smoke cases against the unchanged existing client bundle. All changed
server modules and the memory script pass `node --check`; `git diff --check`
passes. The legacy `npm test` entry was not invoked because it builds first;
`test:server` and `test:memory` provide source-only verification commands.

`node --expose-gc scripts/memory-check.mjs 1000` used the actual Gateway and
Cordis packages with synthetic events: 20 warmup cycles plus 1000 reconnects,
four 64KiB notifications per cycle, all 1020 Peer scopes released. Every sampled
idle point had zero live Peers and no Gateway event client. Post-GC heap samples:

| Reconnect cycle | Heap MiB |
| --- | ---: |
| Warmed up | 10.29 |
| 200 | 10.97 |
| 400 | 10.83 |
| 600 | 9.62 |
| 800 | 9.60 |
| 1000 | 9.59 |

This shows bounded behavior in the isolated exercised path. It does not prove
that this plugin alone caused the original desktop OOM or that all desktop,
session-cache and other-plugin memory is bounded. Real multi-hour installed
observation or a heap allocation profile is still required for that attribution.
