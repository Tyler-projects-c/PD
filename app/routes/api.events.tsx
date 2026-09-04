import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import db from "../db.server";
import { assignVisitorToExperiment } from "../utils/experiments.server";

/**
 * Raw event ingestion endpoint for the PD web pixel (Phase 1).
 *
 * The pixel POSTs one JSON payload per customer event. This route validates
 * the payload, responds immediately with a fast 200, and persists the event
 * asynchronously. It is intentionally NOT authenticated via Shopify session:
 * the web pixel sandbox has no session cookies, so the only callers are the
 * pixel and direct tests. Payloads are validated and FK-constrained by the
 * events table, so rows can only reference real shops/visitors.
 *
 * Visitor identity: the theme treatment script (extensions/pd-treatment) sets
 * a first-party pd_visitor_id cookie on the shop domain, and the pixel sends
 * events with credentials:"include". When that cookie is present it WINS over
 * the payload's visitor_id — the sandboxed localStorage id is only a fallback
 * for visitors without the cookie. This unification is what links tracked
 * events to the same visitor identity the theme script used to resolve its
 * experiment assignment (the pixel sandbox and the theme cannot see each
 * other's storage).
 */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const EVENT_TYPES = [
  "page_viewed",
  "product_viewed",
  "search_submitted",
  "collection_viewed",
  "product_added_to_cart",
  "checkout_completed",
] as const;

const lineItemSchema = z.object({
  product_id: z.string().min(1).max(255),
  revenue: z.union([z.string(), z.number()]).nullish(),
});

const payloadSchema = z.object({
  event_type: z.enum(EVENT_TYPES),
  // Optional in the payload: when the pd_visitor_id cookie is present it
  // identifies the visitor instead. At least one of the two is required
  // (enforced after parsing).
  visitor_id: z.string().uuid().nullish(),
  shop_domain: z.string().min(1).max(255),
  product_id: z.string().min(1).max(255).nullish(),
  order_id: z.string().min(1).max(255).nullish(),
  revenue: z.union([z.string(), z.number()]).nullish(),
  occurred_at: z.string().nullish(),
  // Present on collection/search events: which surface the visitor is on and
  // what identifies that surface instance (collection id / search query).
  surface: z.enum(["collection", "search"]).nullish(),
  surface_ref: z.string().min(1).max(255).nullish(),
  line_items: z.array(lineItemSchema).max(200).nullish(),
});

type EventPayload = z.infer<typeof payloadSchema>;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export const loader = async (_args: LoaderFunctionArgs) => {
  return jsonResponse({ error: "Method not allowed" }, 405);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  // Pre-flight support in case a browser ever upgrades the pixel request.
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const parsed = payloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    console.warn(
      "[api.events] rejected invalid payload:",
      JSON.stringify(parsed.error.flatten()),
    );
    return jsonResponse({ error: "Invalid event payload" }, 400);
  }

  // Identity resolution: the first-party pd_visitor_id cookie (set by the
  // theme treatment script on the shop domain, forwarded by the pixel's
  // credentialled fetch) wins; the payload's sandboxed localStorage id is the
  // fallback. At least one must be present and be a valid UUID.
  const cookieVisitorId = /(?:^|;\s*)pd_visitor_id=([0-9a-fA-F-]{36})/.exec(
    request.headers.get("cookie") ?? "",
  )?.[1];
  const effectiveVisitorId = cookieVisitorId ?? parsed.data.visitor_id ?? null;
  if (!effectiveVisitorId || !z.string().uuid().safeParse(effectiveVisitorId).success) {
    console.warn(
      "[api.events] rejected payload with no usable visitor identity (no cookie, no valid visitor_id)",
    );
    return jsonResponse({ error: "Invalid event payload" }, 400);
  }

  // Respond immediately — ingestion must stay fast even if the database is
  // slow. Persistence failures are logged server-side instead of being
  // surfaced to the storefront sandbox.
  void persistEvent(parsed.data, effectiveVisitorId).catch((error) => {
    console.error(
      "[api.events] failed to persist event:",
      error instanceof Error ? error.message : error,
    );
  });

  return jsonResponse({ ok: true }, 200);
};

function parseOccurredAt(raw: string | null | undefined): Date {
  if (raw) {
    const parsedDate = new Date(raw);
    if (!Number.isNaN(parsedDate.getTime())) {
      return parsedDate;
    }
  }
  return new Date();
}

function toDecimal(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? String(asNumber) : null;
}

async function ensureVisitor(visitorId: string, shopDomain: string) {
  await db.visitors.upsert({
    where: { visitor_id: visitorId },
    update: {},
    create: { visitor_id: visitorId, shop_domain: shopDomain },
  });
}

async function persistEvent(payload: EventPayload, effectiveVisitorId: string) {
  const occurredAt = parseOccurredAt(payload.occurred_at);

  // shops rows are created ONLY by the real OAuth install flow (auth.$.tsx):
  // "a shops row exists" must mean "this merchant actually installed the app",
  // which billing/churn logic will rely on. No placeholder is created here —
  // if the shop is missing, the visitor upsert below fails the
  // visitors_shop_domain_fkey FK constraint, which the action's catch logs as
  // "[api.events] failed to persist event: ..." so the gap stays loud.
  await ensureVisitor(effectiveVisitorId, payload.shop_domain);

  // Experiment assignment (measurement only — no rendering effect): for
  // collection/search traffic, assign or re-read the visitor's arm for this
  // exact surface instance. Failure here must never drop the event — the row
  // is simply stored without a variant and the error is logged.
  let variant: string | null = null;
  if (payload.surface && payload.surface_ref) {
    try {
      const assignment = await assignVisitorToExperiment(
        effectiveVisitorId,
        payload.shop_domain,
        payload.surface,
        payload.surface_ref,
      );
      variant = assignment?.variant ?? null;
    } catch (error) {
      console.error(
        "[api.events] experiment assignment failed (event still persisted):",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const baseFields = {
    visitor_id: effectiveVisitorId,
    shop_domain: payload.shop_domain,
    event_type: payload.event_type,
    occurred_at: occurredAt,
    surface: payload.surface ?? null,
    surface_ref: payload.surface_ref ?? null,
    variant,
  };

  const lineItems = payload.line_items ?? [];
  if (payload.event_type === "checkout_completed" && lineItems.length > 0) {
    // One row per purchased line item so per-product revenue stays
    // attributable (matches the product_surface_stats design used by later
    // phases). The order total is the sum of the line rows.
    await db.events.createMany({
      data: lineItems.map((lineItem) => ({
        ...baseFields,
        product_id: lineItem.product_id,
        order_id: payload.order_id ?? null,
        revenue: toDecimal(lineItem.revenue),
      })),
    });
    return;
  }

  await db.events.create({
    data: {
      ...baseFields,
      product_id: payload.product_id ?? null,
      order_id: payload.order_id ?? null,
      revenue: toDecimal(payload.revenue),
    },
  });
}