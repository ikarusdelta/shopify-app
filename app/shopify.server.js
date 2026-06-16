import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

/**
 * Registers the Ikarus cart-transform function on the shop so parent/child bundle
 * lines are merged into a single cart line natively (correct cart count + checkout).
 * Idempotent: does nothing if a cart transform is already registered.
 */
async function ensureCartTransform(admin) {
  try {
    const existingRes = await admin.graphql(
      `#graphql
      query { cartTransforms(first: 1) { nodes { id } } }`,
    );
    const existing = await existingRes.json();
    if ((existing?.data?.cartTransforms?.nodes || []).length > 0) return;

    const fnRes = await admin.graphql(
      `#graphql
      query { shopifyFunctions(first: 50) { nodes { id title apiType } } }`,
    );
    const fnData = await fnRes.json();
    const fn = (fnData?.data?.shopifyFunctions?.nodes || []).find(
      (n) => n.apiType === "cart_transform",
    );
    if (!fn) return;

    const createRes = await admin.graphql(
      `#graphql
      mutation CreateCartTransform($functionId: String!) {
        cartTransformCreate(functionId: $functionId) {
          cartTransform { id }
          userErrors { field message }
        }
      }`,
      { variables: { functionId: fn.id } },
    );
    const created = await createRes.json();
    const errs = created?.data?.cartTransformCreate?.userErrors;
    if (errs && errs.length > 0) {
      console.error("[CartTransform] register userErrors:", errs);
    } else {
      console.log("[CartTransform] registered cart transform for shop.");
    }
  } catch (err) {
    console.error("[CartTransform] registration failed:", err?.message || err);
  }
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async ({ admin }) => {
      await ensureCartTransform(admin);
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
