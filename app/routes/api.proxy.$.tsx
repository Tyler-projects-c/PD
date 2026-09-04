import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import db from "../db.server";
import { assignVisitorToExperiment } from "../utils/experiments.server";

/**
 * Storefront-facing experiment assignment endpoint (placeholder treatment phase).
 *
 * Reached via the Shopify app proxy: {shop}/apps/pd/assign →
 * <application_url>/api/proxy/assign (see [app_proxy] in shopify.app.toml).
 * The theme treatment script (extensions/pd-treatment) calls it same-origin,
 * so no CORS handling and no absolute app URL is needed in the theme.
 *
 * It runs the SAME assignment logic as event ingestion —
 * assignVisitorToExperiment() from Prompt 1 (sticky 50/50 split keyed on
 * (visitor_id, surface, surface_ref)) — so the rendering decision and the
 * tracking events resolve to the identical experiment instance.
 *
 * GET (theme script / app proxy) or POST (direct tests) with:
 *   visitor_id, surface ("collection" | "search"), surface_ref, and either
 *   the X-Shopify-Shop-Domain header (set by the real app proxy) or an
 *   explicit shop_domain param for direct/test calls.
 *
 * Returns { variant, experiment_id }; variant is null whenever there is no
 * usable answer (no active experiment for the surface, missing fields, shop
 * not installed, DB error) — the theme script treats that as "default order".
 *
 * NOTE: the real app proxy signs forwarded requests (signature/timestamp
 * params) and sets X-Shopify-Shop-Domain. Verifying that signature is a
 * TODO before this endpoint is production-facing.
 */

const requestSchema = z.object({
  visitor_id: z.string().uuid(),
  shop_domain: z.string().min(1).max(255),
  surface: z.enum(["collection", "search"]),
  surface_ref: z.string().min(1).max(255),
});

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const raw: Record<string, unknown> = {};
  url.searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  if (request.method === "POST") {
    try {
      const body = await request.json();
      if (body && typeof body === "object") {
        Object.assign(raw, body);
      }
    } catch {
      // fall through to schema validation, which reports the failure
    }
  }
  // The real app proxy identifies the shop via this header — it wins over any
  // caller-supplied value.
  const headerShopDomain = request.headers.get("x-shopify-shop-domain");
  if (headerShopDomain) {
    raw.shop_domain = headerShopDomain;
  }

  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(
      "[api.proxy.assign] invalid assignment request:",
      JSON.stringify(parsed.error.flatten()),
    );
    return Response.json({ variant: null, experiment_id: null, error: "invalid_request" });
  }

  try {
    // Same ensureVisitor semantics as /api/events: the visitors row must exist
    // before the assignment (FK). If the shop isn't installed the insert
    // fails the FK and the catch below returns variant null.
    await db.visitors.upsert({
      where: { visitor_id: parsed.data.visitor_id },
      update: {},
      create: { visitor_id: parsed.data.visitor_id, shop_domain: parsed.data.shop_domain },
    });

    const assignment = await assignVisitorToExperiment(
      parsed.data.visitor_id,
      parsed.data.shop_domain,
      parsed.data.surface,
      parsed.data.surface_ref,
    );
    return Response.json({
      variant: assignment?.variant ?? null,
      experiment_id: assignment?.experiment_id ?? null,
    });
  } catch (error) {
    console.error(
      "[api.proxy.assign] assignment failed (returning no variant):",
      error instanceof Error ? error.message : error,
    );
    return Response.json({ variant: null, experiment_id: null, error: "assignment_failed" });
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => handle(request);

export const action = async ({ request }: ActionFunctionArgs) => handle(request);