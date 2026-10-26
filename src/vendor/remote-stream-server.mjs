// Vendored from @deepseek-ai/dsh-api-gateway 0.2.1-rc.2, MIT, Copyright (c) 2026 DeepSeek.
// Changes: public protocol import, bounded concurrency, cancellation ownership,
// sanitized logging. See THIRD_PARTY_NOTICES.txt.
/** Host WebSocket owner for multiplexed Typert Remote streams. */
import { Deque } from '@deepseek-ai/dsh-deque';
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import WebSocket, { WebSocketServer } from 'ws';
import { parseRemoteStreamClientMessage, } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
const MAX_MISSED_HEARTBEATS = 2;
/** Own the no-server WebSocket acceptor and every active logical stream. */
export class RemoteStreamMuxServer {
    open;
    failure;
    heartbeatIntervalMs;
    streamInboxBytes;
    server = new WebSocketServer({ noServer: true });
    connections = new Set();
    missedHeartbeats = new WeakMap();
    heartbeatTimer;
    writeLimits;
    /**
     * @param open - Gateway stream dispatcher.
     * @param failure - Gateway error-to-wire mapper.
     * @param heartbeatIntervalMs - interval between WebSocket Ping control frames.
     * @param streamInboxBytes - buffered uplink frame bytes one logical stream may hold before it fails.
     */
    constructor(open, failure, heartbeatIntervalMs, streamInboxBytes, writeLimits = {}) {
        this.open = open;
        this.failure = failure;
        this.heartbeatIntervalMs = heartbeatIntervalMs;
        this.streamInboxBytes = streamInboxBytes;
        this.writeLimits = { maxPendingBytes: 64 * 1024 * 1024, timeoutMs: 10_000, ...writeLimits };
    }
    /**
     * Upgrade one admitted request and begin serving its logical streams. Every
     * stream the socket opens speaks for the Peer admitted at upgrade, and the
     * socket closes when that Peer's scope is disposed.
     * @param req - authenticated HTTP upgrade request.
     * @param socket - carrier socket transferred to the WebSocket server.
     * @param head - bytes already read after the HTTP upgrade headers.
     * @param peer - Peer the upgrade was admitted as.
     */
    handleUpgrade(req, socket, head, peer) {
        this.server.handleUpgrade(req, socket, head, (websocket) => {
            const release = bindPeer(websocket, peer);
            if (release === undefined)
                return;
            const alive = () => { this.missedHeartbeats.set(websocket, 0); };
            alive();
            this.startHeartbeat();
            const bound = (endpoint, payload, uplink, control, window) => this.open(endpoint, payload, uplink, peer, control, window);
            const connection = new RemoteStreamMuxConnection(websocket, bound, this.failure, this.streamInboxBytes, alive, this.writeLimits);
            const done = connection.run().catch((error) => {
                // Transport failure is contained; never log request or error payloads.
            }).then(async () => { await release(); }).catch((error) => {
                // Cleanup failure is contained; never log private error payloads.
            });
            this.connections.add(done);
            void done.then(() => { this.connections.delete(done); });
        });
    }
    /** Terminate all sockets and wait until every iterator has returned. */
    async close() {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        for (const socket of this.server.clients)
            socket.terminate();
        const closed = Promise.withResolvers();
        this.server.close((error) => {
            if (error === undefined)
                closed.resolve();
            else
                closed.reject(error);
        });
        await closed.promise;
        await Promise.all(this.connections);
    }
    /** Start one `unref()` timer after the first upgrade; it spans empty-client periods until close(). */
    startHeartbeat() {
        if (this.heartbeatTimer !== undefined)
            return;
        this.heartbeatTimer = setInterval(() => {
            for (const socket of this.server.clients) {
                if (socket.readyState !== WebSocket.OPEN)
                    continue;
                const missed = this.missedHeartbeats.get(socket);
                if (missed >= MAX_MISSED_HEARTBEATS) {
                    setImmediate(() => {
                        if (this.missedHeartbeats.get(socket) >= MAX_MISSED_HEARTBEATS) {
                            socket.terminate();
                        }
                    });
                    continue;
                }
                this.missedHeartbeats.set(socket, missed + 1);
                socket.ping();
            }
        }, this.heartbeatIntervalMs);
        this.heartbeatTimer.unref();
    }
}
class RemoteStreamMuxConnection {
    socket;
    open;
    failure;
    streamInboxBytes;
    alive;
    streams = new Map();
    writes = Promise.resolve();
    pendingBytes = 0;
    writeLimits;
    constructor(socket, open, failure, streamInboxBytes, alive, writeLimits) {
        this.socket = socket;
        this.open = open;
        this.failure = failure;
        this.streamInboxBytes = streamInboxBytes;
        this.alive = alive;
        this.writeLimits = writeLimits;
    }
    /**
     * Serve frames until the socket closes. A Pong, any received frame, and a
     * downlink write that waited in the local send buffer and then completed
     * count as peer activity, so a congested link that delays the Pong behind
     * data keeps its socket. A write that completes at once proves nothing
     * about the peer and does not count.
     */
    async run() {
        const closed = new Promise((resolve) => {
            this.socket.once('close', resolve);
            this.socket.once('error', () => { this.socket.terminate(); });
            this.socket.on('pong', this.alive);
            this.socket.on('message', (data, isBinary) => {
                this.alive();
                if (isBinary) {
                    this.socket.close(1003, 'text messages required');
                    return;
                }
                try {
                    this.receive(rawText(data));
                }
                catch {
                    this.socket.close(1008, 'invalid Remote stream request');
                }
            });
        });
        await closed;
        const active = [...this.streams.values()];
        for (const stream of active)
            stream.stop(new Error('Remote stream socket closed'));
        await Promise.all(active.map(stream => stream.done));
    }
    /**
     * Dispatch one frame. `item`, `end`, and `cancel` for a stream this connection
     * no longer owns are dropped: a finished stream leaves the table while the
     * Client's in-flight frames are still arriving. A duplicate `open` is the one
     * protocol violation that closes the socket.
     */
    receive(text) {
        const message = parseRemoteStreamClientMessage(text);
        switch (message.type) {
            case 'open': {
                this.openStream(message);
                return;
            }
            case 'item': {
                this.streams.get(message.streamId)?.inbox.push(message.value, Buffer.byteLength(text, 'utf8'));
                return;
            }
            case 'end': {
                this.streams.get(message.streamId)?.inbox.end();
                return;
            }
            case 'cancel': {
                this.streams.get(message.streamId)?.stop(new Error('Remote stream cancelled'));
                return;
            }
            /* v8 ignore next 4 -- parseRemoteStreamClientMessage admits only the four frame types above. */
            default: {
                const unknown = message;
                throw new Error(`api gateway: unknown Remote stream client message ${JSON.stringify(unknown)}`);
            }
        }
    }
    openStream(message) {
        if (this.streams.size >= 128 || this.streams.has(message.streamId)) {
            throw new Error(`api gateway: duplicate Remote stream id ${JSON.stringify(message.streamId)}`);
        }
        const abort = new AbortController();
        // Created before the opener resolves so items the Client sends right
        // after `open` wait in the inbox instead of being lost.
        const inbox = new UplinkInbox(this.streamInboxBytes, message.endpoint, (error) => { abort.abort(error); });
        const active = {
            abort,
            inbox,
            stop: (reason) => {
                abort.abort(reason);
                inbox.fail(reason);
            },
            done: Promise.resolve(),
        };
        this.streams.set(message.streamId, active);
        const done = this.pump(message.streamId, message.endpoint, message.payload, active);
        active.done = done;
        const remove = () => { this.streams.delete(message.streamId); };
        void done.then(remove, remove);
    }
    async pump(streamId, endpoint, payload, active) {
        let outcome;
        let iterator;
        let ended = false;
        try {
            const opening = Promise.resolve(this.open(endpoint, payload, active.inbox, active.abort, {
                maxBytes: this.streamInboxBytes,
                frameOverheadBytes: Buffer.byteLength(JSON.stringify({ type: 'item', streamId, value: null }), 'utf8') - 'null'.length,
            }));
            const source = await untilAbort(opening, active.abort.signal).catch(error => {
                // A provider may finish opening after its client has left.
                if (active.abort.signal.aborted) void opening.then(returnSource, () => {});
                throw error;
            });
            iterator = source[Symbol.asyncIterator]?.() ?? source[Symbol.iterator]();
            while (!active.abort.signal.aborted) {
                const next = await untilAbort(Promise.resolve().then(() => iterator.next()), active.abort.signal);
                if (next.done) { ended = true; break; }
                await untilAbort(this.send({ type: 'item', streamId, value: next.value }), active.abort.signal);
            }
            outcome = { failed: false };
        }
        catch (error) {
            outcome = { failed: true, error };
        }
        // Unblock uplink reads before asking a provider to return. Never retain
        // a dead socket while awaiting an uncooperative provider's next/return.
        active.inbox.fail(new Error('Remote stream ended'));
        if (iterator !== undefined && !ended) {
            void Promise.resolve().then(() => iterator.return?.()).catch(() => {});
        }
        try {
            if (active.abort.signal.aborted) {
                // Protocol/uplink failures retain their terminal failure frame.
                const reason = active.abort.signal.reason;
                if (remoteErrorOf(reason) !== undefined)
                    await this.sendFailure(streamId, reason);
                return;
            }
            if (outcome.failed) {
                await this.sendFailure(streamId, outcome.error);
                return;
            }
            try {
                await this.send({ type: 'end', streamId });
            }
            catch (error) {
                await this.sendFailure(streamId, error);
            }
        }
        finally {
            active.stop(new Error('Remote stream ended'));
        }
    }
    async sendFailure(streamId, error) {
        if (this.socket.readyState !== WebSocket.OPEN)
            return;
        try {
            await this.send({ type: 'error', streamId, error: this.failure(error) });
        }
        catch {
            // A terminal frame that cannot be encoded or written leaves the
            // logical stream ambiguous, so fail the physical generation.
            this.socket.close(1011, 'Remote stream failure could not be delivered');
        }
    }
    send(message) {
        let text;
        try {
            text = JSON.stringify(message);
        }
        catch (cause) {
            return Promise.reject(new Error('api gateway: Remote stream item is not JSON serializable', { cause }));
        }
        const bytes = Buffer.byteLength(text);
        if (this.pendingBytes + bytes > this.writeLimits.maxPendingBytes) {
            this.socket.terminate();
            return Promise.reject(new Error('Remote stream downlink buffer exceeded'));
        }
        this.pendingBytes += bytes;
        const delivery = this.writes.then(() => new Promise((resolve, reject) => {
            if (this.socket.readyState !== WebSocket.OPEN) {
                reject(new Error('api gateway: Remote stream socket is closed'));
                return;
            }
            const closed = () => { finish(new Error('Remote stream socket closed')); };
            const finish = (error) => {
                clearTimeout(deadline);
                this.socket.off('close', closed);
                if (error) reject(error);
                else resolve();
            };
            // Pongs/uplink activity must not hide a stalled downlink forever.
            const deadline = setTimeout(() => {
                finish(new Error('Remote stream downlink stalled'));
                this.socket.terminate();
            }, this.writeLimits.timeoutMs);
            deadline.unref();
            this.socket.once('close', closed);
            let queued = false;
            try { this.socket.send(text, (error) => {
                if (error) {
                    finish(error);
                    return;
                }
                if (queued)
                    this.alive();
                finish();
            }); } catch (error) { finish(error); }
            // Read after send(): bytes still buffered mean the local send buffer was
            // full, so their completion requires the peer to acknowledge data.
            queued = this.socket.bufferedAmount > 0;
        })).finally(() => { this.pendingBytes -= bytes; });
        this.writes = delivery.catch(() => undefined);
        return delivery;
    }
}

/** Each wait owns its listener: a reused pending race promise leaks reactions. */
async function untilAbort(promise, signal) {
    if (signal.aborted) {
        void Promise.resolve(promise).catch(() => {});
        throw signal.reason;
    }
    let abort;
    const cancelled = new Promise((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([promise, cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
}

function returnSource(source) {
    void Promise.resolve().then(() => {
        const iterator = source[Symbol.asyncIterator]?.() ?? source[Symbol.iterator]();
        return iterator.return?.();
    }).catch(() => {});
}
const UPLINK_DONE = { value: undefined, done: true };
/**
 * Bounded single-consumer uplink queue of one logical stream, the source the
 * Host method reads through `invocation.uplink()`. Buffered frame bytes are
 * capped: overflow, and an item after the Client's `end`, fail the queue and
 * report a Remote failure that the connection uses to fail the logical stream.
 */
class UplinkInbox {
    maxBytes;
    endpoint;
    onViolation;
    queue = new Deque();
    bytes = 0;
    ended = false;
    closed = false;
    taken = false;
    failure;
    wake;
    constructor(maxBytes, endpoint, onViolation) {
        this.maxBytes = maxBytes;
        this.endpoint = endpoint;
        this.onViolation = onViolation;
    }
    push(value, frameBytes) {
        if (this.failure !== undefined || this.closed)
            return;
        if (this.ended) {
            this.violate(new RemoteError('gateway/protocol', 'api gateway: Remote stream uplink item after end', { endpoint: this.endpoint }));
            return;
        }
        if (this.bytes + frameBytes > this.maxBytes) {
            this.violate(new RemoteError('gateway/uplink-overflow', `api gateway: Remote stream uplink exceeded ${String(this.maxBytes)} buffered bytes`, { endpoint: this.endpoint }));
            return;
        }
        this.queue.pushBack({ value, bytes: frameBytes });
        this.bytes += frameBytes;
        this.signal();
    }
    /** Client half-close; idempotent. */
    end() {
        if (this.ended)
            return;
        this.ended = true;
        this.signal();
    }
    /** End the consumer's next read with `error`; idempotent, drops buffered items. */
    fail(error) {
        if (this.failure !== undefined)
            return;
        this.failure = error;
        this.queue.clear();
        this.bytes = 0;
        this.signal();
    }
    [Symbol.asyncIterator]() {
        if (this.taken)
            throw new Error('api gateway: Remote stream uplink inbox already has a consumer');
        this.taken = true;
        return this;
    }
    async next() {
        while (true) {
            if (this.closed)
                return UPLINK_DONE;
            const entry = this.queue.popFront();
            if (entry !== undefined) {
                this.bytes -= entry.bytes;
                return { value: entry.value, done: false };
            }
            if (this.failure !== undefined)
                throw this.failure;
            if (this.ended)
                return UPLINK_DONE;
            if (this.wake !== undefined)
                throw new Error('api gateway: Remote stream uplink inbox has one pending read');
            await new Promise((resolve) => { this.wake = resolve; });
        }
    }
    /** Consumer stopped reading: later items are dropped, a pending read ends. */
    return() {
        this.closed = true;
        this.queue.clear();
        this.bytes = 0;
        this.signal();
        return Promise.resolve(UPLINK_DONE);
    }
    violate(error) {
        this.fail(error);
        this.onViolation(error);
    }
    signal() {
        const wake = this.wake;
        this.wake = undefined;
        wake?.();
    }
}
/**
 * Close the socket when the Peer's scope is disposed. A scope that is already
 * disposed leaves no Peer for the socket to speak for, so the socket closes now.
 * @returns the registration's disposer, or `undefined` when the socket was closed.
 */
function bindPeer(websocket, peer) {
    try {
        return peer.ctx.effect(() => () => { websocket.close(1001, 'peer left'); }, 'api-gateway: Remote stream socket bound to its Peer');
    }
    catch {
        websocket.close(1001, 'peer left');
        return undefined;
    }
}
function rawText(data) {
    if (Array.isArray(data))
        return Buffer.concat(data).toString('utf8');
    if (data instanceof ArrayBuffer)
        return Buffer.from(data).toString('utf8');
    return Buffer.from(data).toString('utf8');
}
/**
 * Reject an upgrade without transferring socket ownership to ws.
 * @param socket - carrier socket that receives the HTTP rejection.
 * @param status - authentication or browser-trust rejection status.
 */
export function rejectRemoteStreamUpgrade(socket, status) {
    const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Conflict';
    const body = reason.toLowerCase();
    socket.end([
        `HTTP/1.1 ${String(status)} ${reason}`,
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        `Content-Length: ${String(Buffer.byteLength(body))}`,
        '',
        body,
    ].join('\r\n'));
}
//# sourceMappingURL=stream-server.js.map
