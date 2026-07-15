import { unauthenticated } from "../shopify.server";
import prisma from "../db.server";

/**
 * Vercel Cron (see vercel.json) — once a day, pulls yesterday's Online Store
 * views per shop via ShopifyQL (total_sessions — the closest metric Shopify's
 * Admin API exposes to page views) and forwards it to the Lambda, which
 * stores it in the same DynamoDB item as total revenue (STORE_REVENUE_TABLE).
 *
 * Needs read_analytics scope + an offline session per shop (stored by
 * PrismaSessionStorage on install — see shopify.server.js).
 */
export const loader = async ({ request }) => {
  const auth = request.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const lambdaUrl = process.env.LAMBDA_URL;
  if (!lambdaUrl) return new Response("LAMBDA_URL not configured", { status: 500 });

  const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10); // yesterday, UTC

  const shops = await prisma.session.findMany({ where: { isOnline: false } });
  const results = [];

  for (const { shop } of shops) {
    try {
      const { admin } = await unauthenticated.admin(shop);

      // TEMP: introspect the real field names on ShopifyqlTableData instead of guessing.
      const introRes = await admin.graphql(
        `#graphql
        query { __type(name: "ShopifyqlTableData") { fields { name type { name kind ofType { name kind } } } } }`,
      );
      const introJson = await introRes.json();
      results.push({ shop, introspection: introJson?.data?.__type });
      continue; // TODO: remove this probe + continue once field names are confirmed
    } catch (err) {
      console.error(`[cron/sessions] ${shop} failed:`, err?.message || err);
      results.push({ shop, error: err?.message || String(err) });
    }
  }

  return Response.json({ date, results });
};
