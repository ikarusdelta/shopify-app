import type {
  CartTransformRunInput,
  CartTransformRunResult,
} from "../generated/api";

const NO_CHANGES: CartTransformRunResult = {
  operations: [],
};

/**
 * Merges Ikarus parent + child cart lines that share the same `_bundle_id` into a
 * single bundled cart line, server-side. This is the theme-agnostic, native way to
 * make a parent/child configuration appear as ONE product — in the cart, the cart
 * drawer, and at checkout (where theme JS does not run).
 *
 * Lines are tagged by the storefront embed when added:
 *   _bundle_id        → groups the lines of one configuration
 *   _is_bundle_parent → "true" on the parent line (its variant represents the bundle)
 *
 * The merged line's `title` is set to the parent product name plus every component's
 * options, so even themes that don't render bundle components still show the full
 * configuration on the single line. Checkout additionally lists the components natively.
 * Price is left untouched, so the bundle total = sum of the component line prices.
 */
export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  // Group cart lines by their _bundle_id attribute.
  type Line = (typeof input.cart.lines)[number];
  const bundles = new Map<string, { parent: Line | null; lines: Line[] }>();

  for (const line of input.cart.lines) {
    const bundleId = line.bundleId?.value;
    if (!bundleId) continue;

    let bundle = bundles.get(bundleId);
    if (!bundle) {
      bundle = { parent: null, lines: [] };
      bundles.set(bundleId, bundle);
    }
    bundle.lines.push(line);
    if (line.isBundleParent?.value === "true") bundle.parent = line;
  }

  const variantId = (line: Line): string | null =>
    (line.merchandise as { id?: string })?.id ?? null;

  // The variant title is the option string, e.g. "Sierra Tan / Mixed Species / Harvia Virta".
  const optionTitle = (line: Line): string =>
    ((line.merchandise as { title?: string })?.title || "").trim();

  const operations = [];
  for (const bundle of bundles.values()) {
    const { parent, lines } = bundle;
    if (!parent || lines.length < 2) continue;

    const parentVariantId = variantId(parent);
    if (!parentVariantId) continue;

    // Build a combined title: parent product name + every component's options,
    // parent first, then the children in cart order.
    const productName =
      ((parent.merchandise as { product?: { title?: string } })?.product?.title || "").trim();
    const children = lines.filter((l) => l !== parent);
    const optionParts = [optionTitle(parent), ...children.map(optionTitle)].filter(Boolean);
    const combinedTitle = optionParts.length
      ? `${productName} — ${optionParts.join(" / ")}`
      : productName;

    operations.push({
      linesMerge: {
        parentVariantId,
        cartLines: lines.map((l) => ({ cartLineId: l.id, quantity: l.quantity })),
        title: combinedTitle || undefined,
      },
    });
  }

  if (operations.length === 0) return NO_CHANGES;
  return { operations };
}
