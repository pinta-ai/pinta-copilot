import { mergeBatch, type GuardResult, type OtlpAttribute, type OtlpPayload } from "@pinta-ai/core";
import { type RawEvent } from "./types.js";
import type { Surface } from "./surface.js";
export { mergeBatch };
export type { OtlpPayload, OtlpAttribute };
export declare function buildOtlpPayload(args: {
    event: RawEvent;
    traceId: string;
    surface: Surface;
    now?: number;
    guard?: GuardResult | null;
}): OtlpPayload;
