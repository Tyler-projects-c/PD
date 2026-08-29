
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { encryptToken } from "../utils/crypto.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Register the store in our own database. The events/visitors tables carry
  // FK constraints on shops.shop_domain, so no raw event data can be captured
  // until a shops row exists. This also revives a store that previously
  // uninstalled the app (clearing uninstalled_at).
  // The access token is encrypted at rest (AES-256-GCM, see crypto.server.ts).
  const accessToken = encryptToken(session.accessToken ?? "");

  await db.shops.upsert({
    where: { shop_domain: session.shop },
    update: {
      access_token: accessToken,
      scopes: session.scope ?? "",
      uninstalled_at: null,
    },
    create: {
      shop_domain: session.shop,
      access_token: accessToken,
      scopes: session.scope ?? "",
      uninstalled_at: null,
    },
  });

  return null;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
