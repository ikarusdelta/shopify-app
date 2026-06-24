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

    const num = (v) => Number(v ?? 0);

    // Read a line item property value (properties are an array of { name, value }).
    const propVal = (props, name) => {
      const arr = Array.isArray(props) ? props : [];
      const f = arr.find((p) => p?.name === name);
      return f ? f.value : null;
    };

    // Per-line tax = sum of that line's tax_lines[].price (labeled lines only).
    const lineTax = (li) =>
      (Array.isArray(li?.tax_lines) ? li.tax_lines : []).reduce(
        (sum, t) => sum + num(t?.price),
        0,
      );

    // --- Group viewer lines into bundles ---------------------------------------
    // Lines added together as a bundle share a `_bundle_id` property (set by the
    // viewer embed). Lines with no bundle id are standalone (their own group).
    // Order is preserved by first appearance.
    const groups = new Map();
    const order = [];
    for (const li of viewerLines) {
      const bid = propVal(li.properties, "_bundle_id") || `single_${li.id}`;
      if (!groups.has(bid)) {
        groups.set(bid, []);
        order.push(bid);
      }
      groups.get(bid).push(li);
    }

    const bundles = order.map((bid) => {
      const lines = groups.get(bid);
      const isRealBundle = !String(bid).startsWith("single_");
      // The parent line carries the product name; child lines add their options.
      const parent =
        lines.find((li) => propVal(li.properties, "_is_bundle_parent") === "true") || lines[0];
      const ordered = [parent, ...lines.filter((li) => li !== parent)];
      const productTitle = parent.title || parent.name || "";
      const optionParts = ordered.map((li) => li.variant_title).filter(Boolean);
      const title = optionParts.length ? `${productTitle} — ${optionParts.join(" / ")}` : productTitle;

      const items = lines.map((li) => ({
        variant_id: li.variant_id,
        product_id: li.product_id,
        product_title: li.title ?? null,
        variant_title: li.variant_title ?? null,
        is_parent: propVal(li.properties, "_is_bundle_parent") === "true",
        quantity: li.quantity,
        price: li.price,
        line_value: num(li.price) * num(li.quantity),
        tax: lineTax(li),
        tax_lines: Array.isArray(li.tax_lines)
          ? li.tax_lines.map((t) => ({ title: t.title, rate: t.rate, price: t.price }))
          : [],
      }));

      const bLine = items.reduce((s, it) => s + it.line_value, 0);
      const bTax = items.reduce((s, it) => s + it.tax, 0);

      return {
        bundle_id: isRealBundle ? bid : null,
        title, // the name as shown in the cart, e.g. "Solara — Black / … / Heater Gaurd"
        variant_ids: lines.map((li) => li.variant_id),
        quantities: lines.map((li) => li.quantity),
        line_value: bLine,
        tax_value: bTax,
        line_value_with_tax: bLine + bTax,
        items,
      };
    });

    // Overall totals across all labeled bundles.
    const totalLine = bundles.reduce((s, b) => s + b.line_value, 0);
    const totalTax = bundles.reduce((s, b) => s + b.tax_value, 0);

    const record = {
      shop,
      order_id: payload.id,
      order_name: payload.name ?? null,
      currency: payload.currency ?? payload.presentment_currency ?? null,
      created_at: payload.created_at ?? null,
      taxes_included: payload.taxes_included ?? null,
      // Variant ids grouped per bundle: [[v1, v2], [v3, v4], ...]
      variant_ids: bundles.map((b) => b.variant_ids),
      // Totals across all labeled bundles.
      line_value: totalLine,
      tax_value: totalTax,
      line_value_with_tax: totalLine + totalTax,
      // One entry per bundle, each with its title, variant ids, items, and totals.
      bundles,
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
