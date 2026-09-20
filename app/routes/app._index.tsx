import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import type { action as activatePixelAction } from "./app.pixel";
// Server-only: referenced from the loader below, never from the component,
// so React Router strips it from the client bundle (see the module doc).
import { resyncPixelApiUrl } from "../utils/pixel-resync.server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // Dev tunnels change on every `npm run dev`, which would silently strand
  // the web pixel's stored apiUrl (events would POST to a dead URL). Re-sync
  // it on app-home load - this is the main loader only (not every route),
  // and the helper writes ONLY when the stored URL actually drifted.
  // First-time pixel creation still uses the manual "Enable tracking" button.
  const pixelResync = await resyncPixelApiUrl(admin);

  return { pixelResync };
};
export default function Index() {
  const { pixelResync } = useLoaderData<typeof loader>();
  const pixelFetcher = useFetcher<typeof activatePixelAction>();
  const isPixelLoading =
    ["loading", "submitting"].includes(pixelFetcher.state) &&
    pixelFetcher.formMethod === "POST";

  const enableTracking = () =>
    pixelFetcher.submit(
      { intent: "activate_pixel" },
      { method: "POST", action: "/app/pixel" },
    );

  return (
    <s-page heading="PD">
      <s-section heading="Event tracking">
        <s-paragraph>
          Enable the PD web pixel to start capturing raw storefront events
          (page views, product views, searches, collection views, add-to-cart
          and purchases) into the events table.
        </s-paragraph>
        {pixelResync.status === "no-pixel" && (
          <s-paragraph>
            The PD web pixel is not registered on this store yet - click{" "}
            &quot;Enable tracking&quot; below to create it (this also registers
            it so the storefront can start sending events).
          </s-paragraph>
        )}
        {pixelResync.status === "resynced" && (
          <s-paragraph>
            Pixel apiUrl was automatically re-synced to the current app URL (
            <s-text>{pixelResync.apiUrl}</s-text>) - no action needed.
          </s-paragraph>
        )}
        {pixelResync.status === "error" && (
          <s-paragraph>
            Could not automatically re-sync the pixel apiUrl:{" "}
            {pixelResync.message}
          </s-paragraph>
        )}
        <s-stack direction="inline" gap="base">
          <s-button
            onClick={enableTracking}
            {...(isPixelLoading ? { loading: true } : {})}
          >
            Enable tracking
          </s-button>
        </s-stack>
        {pixelFetcher.data && (
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              <code>{JSON.stringify(pixelFetcher.data, null, 2)}</code>
            </pre>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}
