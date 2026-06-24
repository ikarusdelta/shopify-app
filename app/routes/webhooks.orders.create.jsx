import { authenticate } from "../shopify.server";

const VIEWER_SOURCE = "3d_viewer";

/**
 * orders/create webhook — attributes viewer-sourced purchases.
 *
 * Cart lines added from the 3D viewer carry hidden properties
 * `_source: '3d_viewer'` + `_added_at` (set in ikarus-embed.liquid). Those
 * properties persist onto the order line item, so here we scan the order,
 * pick out the viewer-sourced lines, and forward an attribution record to the
 * Lambda which writes it to S3 keyed by order_id (idempotent on retries).
 *
 * Contract with Shopify:
 *   - authenticate.webhook() verifies the HMAC against the app secret and
 *     rejects (401) anything that fails — we never see a forged call.
 *   - We return 200 ONLY after the record is safely handed to the Lambda.
 *   - On a genuine downstream failure we return 500 so Shopify retries
 *     (delivery is at-least-once; the Lambda write is idempotent on order_id,
 *     so retries overwrite rather than double-count).
 */
export const action = async ({ request }) => {
  let shop, topic, payload;
  try {
    ({ shop, topic, payload } = await authenticate.webhook(request));
  } catch (err) {
    // HMAC mismatch / unparseable Shopify request — let the library's 401 stand.
    console.error("[orders/create] webhook authentication failed:", err);
    throw err;
  }

  try {
    const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];

    // Properties come back as an array of { name, value } objects, NOT a map.
    const hasViewerProp = (props) =>
      Array.isArray(props) &&
      props.some((p) => p?.name === "_source" && p?.value === VIEWER_SOURCE);

    const viewerLines = lineItems.filter((li) => hasViewerProp(li?.properties));

    if (viewerLines.length === 0) {
      console.log(
        `[orders/create] ${shop} order ${payload?.id}: no viewer-sourced lines, skipping.`,
      );
      return new Response(null, { status: 200 });
    }

    // Per-line tax = sum of that line's tax_lines[].price. Scoped to the labeled
    // (viewer-sourced) lines only, so the totals reflect the bundle/viewer products
    // — not the whole order.
    const lineTax = (li) =>
      (Array.isArray(li?.tax_lines) ? li.tax_lines : []).reduce(
        (sum, t) => sum + Number(t?.price ?? 0),
        0,
      );

    const viewerSubtotal = viewerLines.reduce(
      (sum, li) => sum + Number(li.price ?? 0) * Number(li.quantity ?? 0),
      0,
    );
    const viewerTax = viewerLines.reduce((sum, li) => sum + lineTax(li), 0);

    const record = {
      shop,
      order_id: payload.id,
      order_name: payload.name ?? null,
      currency: payload.currency ?? payload.presentment_currency ?? null,
      created_at: payload.created_at ?? null,
      taxes_included: payload.taxes_included ?? null,
      variant_ids: viewerLines.map((li) => li.variant_id),
      quantities: viewerLines.map((li) => li.quantity),
      // Pre-tax sum of the labeled lines (unchanged for back-compat).
      line_value: viewerSubtotal,
      // Tax on the labeled lines, and their tax-inclusive total.
      tax_value: viewerTax,
      line_value_with_tax: viewerSubtotal + viewerTax,
      items: viewerLines.map((li) => ({
        variant_id: li.variant_id,
        product_id: li.product_id,
        quantity: li.quantity,
        price: li.price,
        line_value: Number(li.price ?? 0) * Number(li.quantity ?? 0),
        tax: lineTax(li),
        tax_lines: Array.isArray(li.tax_lines)
          ? li.tax_lines.map((t) => ({ title: t.title, rate: t.rate, price: t.price }))
          : [],
      })),
    };

    const lambdaUrl = process.env.LAMBDA_URL;
    if (!lambdaUrl) {
      console.error("[orders/create] LAMBDA_URL is not set; cannot forward.");
      return new Response("LAMBDA_URL not configured", { status: 500 });
    }

    const endpoint = `${lambdaUrl.replace(/\/$/, "")}/attribution/orders`;

    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      });
    } catch (err) {
      // Network / tunnel down — retryable.
      console.error("[orders/create] Lambda request failed:", err);
      return new Response("Lambda unreachable", { status: 500 });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[orders/create] Lambda returned ${res.status} for order ${record.order_id}: ${body}`,
      );
      return new Response("Lambda write failed", { status: 500 });
    }

    console.log(
      `[orders/create] ${shop} order ${record.order_id}: attributed ${viewerLines.length} viewer line(s).`,
    );
    return new Response(null, { status: 200 });
  } catch (err) {
    // Malformed payload or any unexpected error — log and let Shopify retry.
    console.error(`[orders/create] handler error (topic ${topic}):`, err);
    return new Response("Internal error", { status: 500 });
  }
};
