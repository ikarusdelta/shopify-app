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
      const res = await admin.graphql(
        `#graphql
        query { shopifyqlQuery(query: "FROM sessions SHOW total_sessions SINCE -1d UNTIL today") {
          tableData { rows columns { name dataType } }
          parseErrors { code message }
        } }`,
      );
      const json = await res.json();
      if (json.errors) throw new Error(JSON.stringify(json.errors));
      const row = json?.data?.shopifyqlQuery?.tableData?.rows?.[0];
      const views = Number(row?.[0] ?? 0);

      await fetch(`${lambdaUrl.replace(/\/$/, "")}/analytics/views`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, date, views }),
      });
      results.push({ shop, views });
    } catch (err) {
      console.error(`[cron/sessions] ${shop} failed:`, err?.message || err);
      results.push({ shop, error: err?.message || String(err) });
    }
  }

  return Response.json({ date, results });
};
