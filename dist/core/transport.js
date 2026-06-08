"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Transport = void 0;
const retry_queue_js_1 = require("./retry-queue.js");
const otlp_js_1 = require("./otlp.js");
const TIMEOUT_MS = 5000;
function parseHeadersEnv(raw) {
    if (!raw)
        return {};
    const out = {};
    for (const pair of raw.split(",")) {
        const [k, ...rest] = pair.split("=");
        if (k && rest.length > 0)
            out[k.trim()] = rest.join("=").trim();
    }
    return out;
}
function getOptions() {
    // OTLP/HTTP spec: TRACES_ENDPOINT is the full URL (no append by exporter);
    // ENDPOINT is a base URL the SDK appends /v1/traces to. We treat the
    // value as a full URL — env-bridge maps CLAUDE_PLUGIN_OPTION_ENDPOINT to
    // TRACES_ENDPOINT specifically. For OSS users who set ENDPOINT directly,
    // assume base URL and append /v1/traces.
    const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    let endpoint;
    if (tracesEndpoint) {
        endpoint = tracesEndpoint.replace(/\/+$/, "");
    }
    else if (baseEndpoint) {
        endpoint = baseEndpoint.replace(/\/+$/, "") + "/v1/traces";
    }
    if (!endpoint)
        return null;
    return {
        endpoint,
        headers: parseHeadersEnv(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    };
}
class Transport {
    queue;
    constructor(config) {
        this.queue = new retry_queue_js_1.RetryQueue(config.pluginData);
    }
    /**
     * POST a single payload. On any failure, enqueue it for the next hook to retry.
     * Silent disable when no endpoint is configured.
     */
    async send(payload) {
        const opts = getOptions();
        if (!opts)
            return; // Silent disable when no endpoint configured
        const ok = await this.post(payload, opts);
        if (!ok)
            this.queue.enqueue(payload);
    }
    /**
     * Best-effort drain. Acquires the lock, reads the queue, attempts a single
     * batched POST. On failure, leaves the queue untouched.
     * Silent disable when no endpoint is configured.
     */
    async flush() {
        const opts = getOptions();
        if (!opts)
            return;
        if (!this.queue.tryAcquireLock())
            return;
        try {
            const entries = this.queue.readAll();
            if (entries.length === 0)
                return;
            const merged = (0, otlp_js_1.mergeBatch)(entries.map((e) => e.payload));
            const ok = await this.post(merged, opts);
            if (ok)
                this.queue.rewrite([]);
        }
        finally {
            this.queue.release();
        }
    }
    async post(payload, opts) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
            // opts.endpoint is the full traces URL — no path append.
            const res = await fetch(opts.endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...opts.headers,
                },
                body: JSON.stringify(payload),
                signal: ctrl.signal,
            });
            if (!res.ok) {
                let body = "";
                try {
                    body = (await res.text()).slice(0, 200);
                }
                catch {
                    /* ignore */
                }
                const hint = res.status === 401 || res.status === 403
                    ? " — check OTEL_EXPORTER_OTLP_HEADERS (relay token)"
                    : res.status === 404
                        ? " — check OTEL_EXPORTER_OTLP_TRACES_ENDPOINT path"
                        : res.status >= 500
                            ? " — collector may be down"
                            : "";
                process.stderr.write(`[pinta-copilot] OTLP POST ${res.status} ${opts.endpoint}${hint}${body ? ` body=${body}` : ""}\n`);
                return false;
            }
            return true;
        }
        catch (err) {
            process.stderr.write(`[pinta-copilot] OTLP POST failed: ${err.message ?? String(err)}\n`);
            return false;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
exports.Transport = Transport;
//# sourceMappingURL=transport.js.map