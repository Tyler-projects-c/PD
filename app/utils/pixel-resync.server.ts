/**
 * Web pixel Admin API helpers — shared by the app-home loader (drift re-sync)
 * and the app.pixel action (first-time creation).
 *
 * SERVER-ONLY, and deliberately its own module: React Router's server-only
 * module check rejects a route that both exports a non-route helper AND
 * imports a `.server` module, because the non-route export keeps the whole
 * module in the CLIENT graph (app/utils/logger.server then leaks to the
 * browser and the build fails). Keeping the pixel logic here means
 * app.pixel.tsx exports only `action` (stripped from the client) and
 * app._index.tsx references this module from its loader only — both legal.
 */
import { logError, logInfo, logWarn } from "./logger.server";

const MODULE = "app.pixel";

/** The log prefix preserved from the original call sites. */
const LOG = "[app.pixel]";

export const WEB_PIXEL_UPDATE_MUTATION = `#graphql
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
  }`;

const NO_WEB_PIXEL_ERROR_MESSAGE = "No web pixel was found for this app";

export interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export interface WebPixelRecord {
  id: string;
  settings: string;
}

/**
 * Queries for this app's existing web pixel. Returns null when none exists
 * yet — including when Shopify signals that via the "No web pixel was found
 * for this app" GraphQL error (see the comment at the call site). Any other
 * failure still throws so it surfaces normally.
 */
export async function fetchExistingPixel(
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

export interface PixelResyncResult {
  status: "no-pixel" | "in-sync" | "resynced" | "skipped" | "error";
  apiUrl?: string;
  message?: string;
}

/**
 * Keeps the pixel's stored apiUrl aligned with the app's current URL.
 *
 * `shopify app dev` gets a new Cloudflare tunnel URL on every start, which
 * would silently strand the pixel's stored apiUrl (events POST to a dead
 * URL). This runs from the app-home loader only — it issues a write ONLY
 * when the stored apiUrl actually drifted from the current
 * SHOPIFY_APP_URL, so steady-state loads cost one cheap read (or a skip).
 * First-time creation still happens via the manual "Enable tracking" button.
 *
 * Never throws: callers render the returned status instead of crashing.
 */
export async function resyncPixelApiUrl(
  admin: AdminClient,
): Promise<PixelResyncResult> {
  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!appUrl) {
    return {
      status: "skipped",
      message: "SHOPIFY_APP_URL is not set",
    };
  }
  const expectedApiUrl = `${appUrl.replace(/\/+$/, "")}/api/events`;

  try {
    const existing = await fetchExistingPixel(admin);
    if (!existing) {
      return { status: "no-pixel" };
    }

    const currentApiUrl = extractApiUrl(existing.settings);
    logInfo(
      { module: MODULE },
      `${LOG} resync check: stored apiUrl=${currentApiUrl ?? "(none)"} | expected=${expectedApiUrl}`,
    );
    if (currentApiUrl === expectedApiUrl) {
      return { status: "in-sync", apiUrl: currentApiUrl ?? undefined };
    }

    const updateResponse = await admin.graphql(WEB_PIXEL_UPDATE_MUTATION, {
      variables: {
        id: existing.id,
        webPixel: { settings: { apiUrl: expectedApiUrl } },
      },
    });
    const updateJson = (await updateResponse.json()) as {
      data?: {
        webPixelUpdate?: {
          userErrors?: Array<{ message: string }>;
        };
      };
    };
    const userErrors = updateJson.data?.webPixelUpdate?.userErrors ?? [];
    if (userErrors.length > 0) {
      logWarn(
        { module: MODULE },
        `${LOG} resync rejected by Shopify: ${userErrors
          .map((e) => e.message)
          .join("; ")}`,
      );
      return {
        status: "error",
        message: userErrors.map((e) => e.message).join("; "),
      };
    }
    logInfo(
      { module: MODULE },
      `${LOG} resynced pixel apiUrl: ${currentApiUrl ?? "(none)"} -> ${expectedApiUrl}`,
    );
    return { status: "resynced", apiUrl: expectedApiUrl };
  } catch (error) {
    logError({ module: MODULE }, `${LOG} apiUrl resync failed`, error);
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractApiUrl(settings: string | null | undefined): string | null {
  if (!settings) {
    return null;
  }
  try {
    const parsed = JSON.parse(settings) as { apiUrl?: unknown };
    return typeof parsed.apiUrl === "string" ? parsed.apiUrl : null;
  } catch {
    // Shopify settings strings are not guaranteed to be strict JSON; fall
    // back to a targeted match so a drifted URL is still detected.
    const match = settings.match(/"apiUrl"\s*:\s*"([^"]+)"/);
    return match ? match[1] : null;
  }
}
