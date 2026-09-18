/**
 * Sentry error tracking — alerting only, never automation.
 *
 * HUMAN-IN-THE-LOOP: Sentry captures failure signals (exceptions, webhook
 * failures, revenue mismatches) so they are visible in a dashboard instead of
 * a terminal nobody watches. There is deliberately NO automated remediation,
 * auto-restart, or self-healing wired here — a human reviews every alert and
 * decides on any fix.
 *
 * WIRING: initSentry() is called once from app/entry.server.tsx (the server
 * entrypoint). The DSN comes from the SENTRY_DSN env var; when unset, every
 * function in this module is a silent no-op so local dev and the verify
 * harnesses never need network access or a Sentry project.
 */
import type * as SentryTypes from "@sentry/node";
import { createRequire } from "node:module";

// The server bundle is ESM (package.json "type": "module"), where a bare
// `require` is a ReferenceError — and every loadRealClient()/initSentry()
// failure is swallowed by a try/catch, so Sentry would silently never
// activate in production. createRequire gives a real require() in ESM, which
// resolves the CommonJS Sentry entrypoint the SDK ships.
const require = createRequire(import.meta.url);

export type SentryClient = Pick<
  typeof SentryTypes,
  "captureException" | "captureMessage"
>;

let realClient: SentryClient | null = null;
let initAttempted = false;
let handlersInstalled = false;

function loadModule(): typeof SentryTypes {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@sentry/node") as typeof SentryTypes;
}

function loadRealClient(): SentryClient | null {
  try {
    const mod = loadModule();
    if (
      typeof mod.captureException === "function" &&
      typeof mod.captureMessage === "function"
    ) {
      return {
        captureException: mod.captureException.bind(mod),
        captureMessage: mod.captureMessage.bind(mod),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * True when the SDK has an active client WITHOUT this module having called
 * initSentry() (e.g. an instrumentation file loaded first). Without this
 * guard, captureException on an UNinitialized SDK is a silent no-op that only
 * emits an SDK warning — noise dressed up as alerting.
 */
function isInitializedExternally(): boolean {
  try {
    const mod = loadModule() as typeof SentryTypes & {
      getClient?: () => unknown;
    };
    return typeof mod.getClient === "function" && Boolean(mod.getClient());
  } catch {
    return false;
  }
}

export interface SentryInitOptions {
  dsn?: string;
  environment?: string;
  client?: SentryClient | null;
  skipGlobalHandlers?: boolean;
}

export function initSentry(options: SentryInitOptions = {}): boolean {
  if (initAttempted) return realClient !== null;
  initAttempted = true;
  if (options.client !== undefined) {
    realClient = options.client;
    if (!options.skipGlobalHandlers) installGlobalHandlers();
    return realClient !== null;
  }
  const dsn = options.dsn ?? process.env.SENTRY_DSN ?? "";
  if (!dsn) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require("@sentry/node") as typeof SentryTypes;
    Sentry.init({
      dsn,
      environment: options.environment ?? process.env.NODE_ENV ?? "dev",
      tracesSampleRate: 0,
      sendDefaultPii: false,
    });
    realClient = {
      captureException: Sentry.captureException.bind(Sentry),
      captureMessage: Sentry.captureMessage.bind(Sentry),
    };
  } catch {
    realClient = null;
    return false;
  }
  if (!options.skipGlobalHandlers) installGlobalHandlers();
  return true;
}

export function isSentryActive(): boolean {
  return realClient !== null;
}

export function __resetSentryForTests(): void {
  realClient = null;
  initAttempted = false;
  handlersInstalled = false;
}

export interface ReportContext {
  shop_domain?: string;
  module?: string;
  extra?: Record<string, unknown>;
}

function toExtra(
  context: ReportContext | undefined,
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const extra: Record<string, unknown> = {};
  if (context.shop_domain) extra.shop_domain = context.shop_domain;
  if (context.module) extra.module = context.module;
  if (context.extra) Object.assign(extra, context.extra);
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function activeClient(
  override?: SentryClient | null,
): SentryClient | null {
  if (override !== undefined) return override;
  if (realClient) return realClient;
  // Only fall back to the SDK when something actually initialized it —
  // capturing on an uninitialized SDK would be a silent, warning-only no-op.
  if (isInitializedExternally()) return loadRealClient();
  return null;
}

/**
 * Capture an exception. RETURNS the Sentry event id (or undefined when no
 * client/DSN is configured). The id is what makes a live check verifiable —
 * it can be looked up at https://<org>.sentry.io/events/<id>/ instead of
 * taking "it should have been sent" on faith.
 */
export function reportError(
  error: unknown,
  context?: ReportContext,
  client?: SentryClient | null,
): string | undefined {
  try {
    const target = activeClient(client);
    if (!target) return undefined;
    const err = error instanceof Error ? error : new Error(String(error));
    return target.captureException(err, { extra: toExtra(context) });
  } catch {
    // Silent: the structured log line already recorded this.
    return undefined;
  }
}

/**
 * Capture a message (used for revenue-grade warnings that are not exceptions
 * — see the MISMATCH path in order-verification.server.ts). Returns the
 * Sentry event id, or undefined when no client/DSN is configured.
 */
export function reportMessage(
  message: string,
  context?: ReportContext,
  client?: SentryClient | null,
): string | undefined {
  try {
    const target = activeClient(client);
    if (!target) return undefined;
    return target.captureMessage(message, {
      level: "warning",
      extra: toExtra(context),
    });
  } catch {
    // Silent: the structured log line already recorded this.
    return undefined;
  }
}

export function installGlobalHandlers(client?: SentryClient | null): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const target = client !== undefined ? client : realClient;
  process.on("uncaughtException", (error) => {
    try {
      (target ?? activeClient())?.captureException(error, {
        extra: { kind: "uncaughtException" },
      });
    } catch {
      // Last-resort path — never throw from here.
    }
  });
  process.on("unhandledRejection", (reason) => {
    try {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      (target ?? activeClient())?.captureException(err, {
        extra: { kind: "unhandledRejection" },
      });
    } catch {
      // Last-resort path — never throw from here.
    }
  });
}
