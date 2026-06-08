import type { GuardResult } from "./guard.js";
import { type RawEvent } from "./types.js";
import type { Surface } from "./surface.js";
export interface OtlpAttribute {
    key: string;
    value: {
        stringValue: string;
    } | {
        intValue: number;
    } | {
        doubleValue: number;
    } | {
        boolValue: boolean;
    };
}
export interface OtlpSpan {
    traceId: string;
    spanId: string;
    name: string;
    kind: number;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    attributes: OtlpAttribute[];
}
export interface ResourceSpans {
    resource: {
        attributes: OtlpAttribute[];
    };
    scopeSpans: Array<{
        scope: {
            name: string;
            version: string;
        };
        spans: OtlpSpan[];
    }>;
}
export interface OtlpPayload {
    resourceSpans: ResourceSpans[];
}
/**
 * Convert a 26-char Crockford ULID into 32 lowercase hex chars (16 bytes)
 * suitable for an OTLP traceId.
 */
export declare function ulidToTraceId(ulid: string): string;
/** Generate a fresh 16-hex-char (8-byte) span ID. */
export declare function newSpanId(): string;
export declare function buildOtlpPayload(args: {
    event: RawEvent;
    traceId: string;
    surface: Surface;
    now?: number;
    guard?: GuardResult | null;
}): OtlpPayload;
/** Concatenate per-hook payloads' resourceSpans into one OTLP payload. */
export declare function mergeBatch(payloads: OtlpPayload[]): OtlpPayload;
