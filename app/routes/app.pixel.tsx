import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * Activates (or re-configures) this app's web pixel on the store so the
 * pd-web-pixel extension starts capturing customer events. Invoked by the
 * "Enable tracking" button on the app home page.
 *
 * The pixel's `settings` receive the ingestion endpoint URL, which the pixel
 * uses for every event POST. A store can only have one web pixel per app, so
 * an existing record is updated instead of created.
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

  const existingResponse = await admin.graphql(`#graphql
    query {
      webPixel {
        id
        settings
      }
    }`);
  const existingJson = await existingResponse.json();

  if (existingJson?.data?.webPixel) {
    const updateResponse = await admin.graphql(
      `#graphql
      mutation webPixelUpdate($id: ID!, $webPixel: WebPixelInput!) {
        webPixelUpdate(id: $id, webPixel: $webPixel) {
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
      {
        variables: {
          id: existingJson.data.webPixel.id,
          webPixel: { settings },
        },
      },
    );
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
      message: "Tracking settings updated — the pixel is active.",
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
    message: "Tracking enabled — the pixel is now active on this store.",
    pixel: createJson.data.webPixelCreate.webPixel,
  };
}