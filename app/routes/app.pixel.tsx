import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  fetchExistingPixel,
  WEB_PIXEL_UPDATE_MUTATION,
} from "../utils/pixel-resync.server";

/**
 * Activates (or re-configures) this app's web pixel on the store so the
 * pd-web-pixel extension starts capturing customer events. Invoked by the
 * "Enable tracking" button on the app home page.
 *
 * The pixel's `settings` receive the ingestion endpoint URL, which the pixel
 * uses for every event POST. A store can only have one web pixel per app, so
 * an existing record is updated instead of created.
 *
 * NOTE: this route intentionally exports `action` and nothing else. The
 * drift re-sync helper lives in app/utils/pixel-resync.server.ts â€” exporting
 * a non-route helper from here would keep this module (and its server-only
 * imports) in the CLIENT graph, which React Router rejects at build time.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!appUrl) {
    return {
      ok: false as const,
      message:
        "SHOPIFY_APP_URL is not set, so the pixel cannot be pointed at the event ingestion endpoint.",
    };
  }

  const apiUrl = `${appUrl.replace(/\/+$/, "")}/api/events`;
  const settings = { apiUrl };

  // One web pixel exists per app per store. The webPixel query throws a
  // GraphQL-level error when none exists yet (verified against the live Admin
  // API: HTTP 200 with errors[{message: "No web pixel was found for this
  // app.", extensions.code: "RESOURCE_NOT_FOUND"}] and data.webPixel: null;
  // shopify-api v13's GraphqlClient.request() rethrows that as
  // GraphqlQueryError whose message is the first GraphQL error message), so
  // treat that specific error as "none exists" and fall through to create.
  const existingPixel = await fetchExistingPixel(admin);

  if (existingPixel) {
    const updateResponse = await admin.graphql(WEB_PIXEL_UPDATE_MUTATION, {
      variables: {
        id: existingPixel.id,
        webPixel: { settings },
      },
    });
    const updateJson = await updateResponse.json();
    const userErrors = updateJson?.data?.webPixelUpdate?.userErrors ?? [];
    if (userErrors.length > 0) {
      return {
        ok: false as const,
        message: `Shopify rejected the pixel update: ${userErrors
          .map((error: { message: string }) => error.message)
          .join("; ")}`,
      };
    }
    return {
      ok: true as const,
      message: "Tracking settings updated â€” the pixel is active.",
      pixel: updateJson.data.webPixelUpdate.webPixel,
    };
  }

  const createResponse = await admin.graphql(
    `#graphql
    mutation webPixelCreate($webPixel: WebPixelInput!) {
      webPixelCreate(webPixel: $webPixel) {
        webPixel {
          id
          settings
        }
        userErrors {
          field
          message
        }
      }
    }`,
    { variables: { webPixel: { settings } } },
  );
  const createJson = await createResponse.json();
  const userErrors = createJson?.data?.webPixelCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    return {
      ok: false as const,
      message: `Shopify rejected the pixel: ${userErrors
        .map((error: { message: string }) => error.message)
        .join("; ")}`,
    };
  }
  return {
    ok: true as const,
    message: "Tracking enabled â€” the pixel is now active on this store.",
    pixel: createJson.data.webPixelCreate.webPixel,
  };
}

