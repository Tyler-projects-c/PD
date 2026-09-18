/**
 * Structured logging — one JSON line per call.
 *
 * Replaces ad-hoc string interpolation
 * (`console.warn(`[x] ${shop} ...`)`) with structured fields: timestamp,
 * level, module, shop_domain (when known), message, and extra data.
 *
 * Loud-on-failure behavior is preserved: warn/error still print, and
 * error-level calls ALSO forward to Sentry (alerting only) via
 * reportError — when no DSN is configured that forward is a silent no-op.
 *
 * This module is safe for pure server utils: it has no Prisma/runtime
 * imports beyond ./sentry.server, so the verify harnesses can import it
 * directly under type stripping. `@sentry/node` itself stays lazily loaded
 * inside sentry.server (a missing/broken install degrades to console-only,
 * and with no DSN every report call is a silent no-op anyway).
 */
import { reportError, reportMessage } from "./sentry.server.ts";

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  module: string;
  shop_domain?: string;
  extra?: Record<string, unknown>;
  /**
   * Test double — scripts/verify-error-tracking.mjs injects a fake Sentry
   * client (typed as unknown here so this module stays decoupled from the
   * Sentry SDK's types; forwarded opaquely to reportError/reportMessage).
   */
  sentryClient?: unknown;
}

/**
 * `sentryEventId` is the Sentry event id the call fanned out to (undefined
 * when no DSN/client is configured, or nothing was fanned out). It is
 * returned so live checks can print a real, verifiable event id/link instead
 * of asserting delivery.
 */
export interface LogResult {
  sentryEventId?: string;
}

function errToExtra(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { error_name: error.name, error_message: error.message };
  }
  return { error_message: String(error) };
}

function emit(
  level: LogLevel,
  fields: LogFields,
  message: string,
  error?: unknown,
): LogResult {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    module: fields.module,
    message,
  };
  if (fields.shop_domain) line.shop_domain = fields.shop_domain;
  if (fields.extra) Object.assign(line, fields.extra);
  if (error !== undefined) Object.assign(line, errToExtra(error));
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
  // Sentry fan-out (alerting only): errors as exceptions, revenue-grade
  // warnings as messages. No-DSN => silent no-op inside report*.
  if (level === "error") {
    try {
      const eventId = reportError(error ?? new Error(message), {
        shop_domain: fields.shop_domain,
        module: fields.module,
        extra: fields.extra,
      }, fields.sentryClient as never);
      return eventId ? { sentryEventId: eventId } : {};
    } catch {
      // Silent: the JSON line above already recorded this.
      return {};
    }
  }
  return {};
}

export function logInfo(fields: LogFields, message: string): LogResult {
  return emit("info", fields, message);
}

export function logWarn(
  fields: LogFields,
  message: string,
  opts?: { extra?: Record<string, unknown>; sentry?: boolean },
): LogResult {
  const merged: LogFields = {
    ...fields,
    extra: { ...(fields.extra ?? {}), ...(opts?.extra ?? {}) },
  };
  const result = emit("warn", merged, message);
  // Warnings reach Sentry ONLY when the caller opts in (revenue
  // mismatches, invalid webhook HMACs) — normal warn traffic stays
  // console-only by default so the dashboard is not buried.
  if (opts?.sentry) {
    try {
      const eventId = reportMessage(message, {
        shop_domain: fields.shop_domain,
        module: fields.module,
        extra: merged.extra,
      }, fields.sentryClient as never);
      return eventId ? { sentryEventId: eventId } : result;
    } catch {
      // Silent: the JSON line above already recorded this.
    }
  }
  return result;
}

export function logError(
  fields: LogFields,
  message: string,
  error?: unknown,
): LogResult {
  return emit("error", fields, message, error);
}
