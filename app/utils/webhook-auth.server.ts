/**
 * Webhook authentication wrapper — HMAC failures must be VISIBLE, not silent.
 *
 * `authenticate.webhook(request)` (the Shopify library, see ../shopify.server)
 * verifies X-Shopify-Hmac-Sha256 with a timing-safe comparison and, on a bad or
 * missing signature, throws a bare `Response` (401 Unauthorized) — it is not an
 * Error. Because every route called it OUTSIDE its own try/catch, an HMAC
 * failure produced only a 401 back to Shopify plus a debug-level line in the
 * library's internal logger: no structured log, no Sentry alert, nothing a
 * human would ever see.
 *
 * That is a bad blind spot for this app specifically. A webhook failing HMAC is
 * either (a) a misconfigured/rotated SHOPIFY_API_SECRET, in which case EVERY
 * webhook is silently dead — no orders/paid revenue verification, no product
 * sync, no GDPR redaction — or (b) a forgery attempt. Both deserve a human.
 *
 * ALERTING ONLY: this wrapper logs the failure and reports it to Sentry, then
 * rethrows the ORIGINAL error object untouched, so the 401 (or whatever status
 * the library chose) still reaches Shopify exactly as before. It never retries,
 * repairs, or self-heals.
 */
import { authenticate } from "../shopify.server";
import { logError } from "./logger.server";

export type WebhookContext = Awaited<ReturnType<typeof authenticate.webhook>>;

/**
 * Header-only routing hints. These headers are UNVERIFIED at this point (the
 * signature is exactly what failed), so they are reported as diagnostics only
 * and are never trusted for data decisions — note the `unverified_` prefix.
 */
function unverifiedHints(request: Request) {
  return {
    topic: request.headers.get("x-shopify-topic") ?? undefined,
    shop: request.headers.get("x-shopify-shop-domain") ?? undefined,
    webhook_id: request.headers.get("x-shopify-webhook-id") ?? undefined,
  };
}

export async function authenticateWebhook(
  request: Request,
  module: string,
): Promise<WebhookContext> {
  try {
    return await authenticate.webhook(request);
  } catch (error) {
    const hints = unverifiedHints(request);
    const status = error instanceof Response ? error.status : undefined;
    const reason =
      error instanceof Response
        ? error.statusText || `HTTP ${error.status}`
        : error instanceof Error
          ? error.message
          : String(error);
    // logError fans out to Sentry (alerting only) — the message is stable so
    // repeated failures group into ONE issue instead of one per request.
    logError(
      {
        module,
        shop_domain: hints.shop,
        extra: {
          auth_failure: "webhook_hmac",
          status,
          reason,
          unverified_topic: hints.topic,
          unverified_webhook_id: hints.webhook_id,
        },
      },
      `[${module}] WEBHOOK AUTHENTICATION FAILED (HMAC/signature verification): ` +
        `status=${status ?? "-"} reason=${reason} unverified_shop=${hints.shop ?? "-"}`,
      error instanceof Error ? error : undefined,
    );
    throw error; // unchanged status/response to Shopify
  }
}
