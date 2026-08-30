import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import db from "../db.server";
import { encryptToken } from "../utils/crypto.server";

/**
 * Raw event ingestion endpoint for the PD web pixel (Phase 1).
 *
 * The pixel POSTs one JSON payload per customer event. This route validates
 * the payload, responds immediately with a fast 200, and persists the event
 * asynchronously. It is intentionally NOT authenticated via Shopify session:
 * the web pixel sandbox has no session cookies, so the only callers are the
 * pixel and direct tests. Payloads are validated and FK-constrained by the
 * events table, so rows can only reference real shops/visitors.
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
  visitor_id: z.string().uuid(),
  shop_domain: z.string().min(1).max(255),
  product_id: z.string().min(1).max(255).nullish(),
  order_id: z.string().min(1).max(255).nullish(),
  revenue: z.union([z.string(), z.number()]).nullish(),
  occurred_at: z.string().nullish(),
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

  // Respond immediately — ingestion must stay fast even if the database is
  // slow. Persistence failures are logged server-side instead of being
  // surfaced to the storefront sandbox.
  void persistEvent(parsed.data).catch((error) => {
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

async function ensureShop(shopDomain: string) {
  // events/visitors carry FK constraints on shops.shop_domain. Normally the
  // auth callback creates the shop row on install; if a real event arrives
  // first (e.g. a dev store right after a DB reset), create a placeholder so
  // ingestion never silently drops data. Stored encrypted at rest; auth.$.tsx
  // replaces it with the real encrypted token on the next install/auth.
  await db.shops.upsert({
    where: { shop_domain: shopDomain },
    update: {},
    create: {
      shop_domain: shopDomain,
      access_token: encryptToken(""),
      scopes: "",
    },
  });
}

async function ensureVisitor(visitorId: string, shopDomain: string) {
  await db.visitors.upsert({
    where: { visitor_id: visitorId },
    update: {},
    create: { visitor_id: visitorId, shop_domain: shopDomain },
  });
}

async function persistEvent(payload: EventPayload) {
  const occurredAt = parseOccurredAt(payload.occurred_at);
  await ensureShop(payload.shop_domain);
  await ensureVisitor(payload.visitor_id, payload.shop_domain);

  const baseFields = {
    visitor_id: payload.visitor_id,
    shop_domain: payload.shop_domain,
    event_type: payload.event_type,
    occurred_at: occurredAt,
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