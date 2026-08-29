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

  // One web pixel exists per app per store. The webPixel query throws a
  // GraphQL-level error when none exists yet (verified against the live Admin
  // API: HTTP 200 with errors[{message: "No web pixel was found for this
  // app.", extensions.code: "RESOURCE_NOT_FOUND"}] and data.webPixel: null;
  // shopify-api v13's GraphqlClient.request() rethrows that as
  // GraphqlQueryError whose message is the first GraphQL error message), so
  // treat that specific error as "none exists" and fall through to create.
  const existingPixel = await fetchExistingPixel(admin);

  if (existingPixel) {
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
          id: existingPixel.id,
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

const NO_WEB_PIXEL_ERROR_MESSAGE = "No web pixel was found for this app";

interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

interface WebPixelRecord {
  id: string;
  settings: string;
}

/**
 * Queries for this app's existing web pixel. Returns null when none exists
 * yet — including when Shopify signals that via the "No web pixel was found
 * for this app" GraphQL error (see the comment at the call site). Any other
 * failure still throws so it surfaces normally.
 */
async function fetchExistingPixel(
  admin: AdminClient,
): Promise<WebPixelRecord | null> {
  try {
    const existingResponse = await admin.graphql(`#graphql
      query {
        webPixel {
          id
          settings
        }
      }`);
    const existingJson = (await existingResponse.json()) as {
      data?: { webPixel?: WebPixelRecord | null };
      errors?: Array<{ message?: string }>;
    };

    // Defensive: if a future client version ever stops throwing on GraphQL
    // errors and returns them in the body instead, handle that shape here.
    if (existingJson.errors?.length) {
      if (
        existingJson.errors.some((entry) =>
          String(entry.message).includes(NO_WEB_PIXEL_ERROR_MESSAGE),
        )
      ) {
        return null;
      }
      throw new Error(
        `webPixel query failed: ${existingJson.errors
          .map((entry) => String(entry.message))
          .join("; ")}`,
      );
    }

    return existingJson.data?.webPixel ?? null;
  } catch (error) {
    if (!isNoWebPixelError(error)) {
      throw error;
    }
    return null;
  }
}

function isNoWebPixelError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.message.includes(NO_WEB_PIXEL_ERROR_MESSAGE)) {
    return true;
  }
  // GraphqlQueryError from @shopify/shopify-api carries the full response
  // body on .body — match against it as a fallback.
  const body = (error as { body?: unknown }).body;
  return JSON.stringify(body ?? "").includes(NO_WEB_PIXEL_ERROR_MESSAGE);
}