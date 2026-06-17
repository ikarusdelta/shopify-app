import type {
  CartTransformRunInput,
  CartTransformRunResult,
} from "../generated/api";

const NO_CHANGES: CartTransformRunResult = {
  operations: [],
};

/**
 * Merges each Ikarus parent + child cart line (sharing the same `_bundle_id`) into a
 * single bundled line, server-side. After this runs, cart.items contains ONE line per
 * bundle (the child is folded in as a component), so the theme renders a single parent
 * row, the cart count is correct, and it works for any number of bundles — no theme
 * edits or DOM manipulation required.
 *
 * Lines are tagged by the storefront embed when added:
 *   _bundle_id          → groups the lines of one configuration
 *   _is_bundle_parent   → "true" on the parent line (its variant represents the bundle)
 *
 * We set the merged line `title` to the parent + child variant options joined, so the
 * single line still shows BOTH products' selected options where the theme renders it.
 * Price is left untouched → merged total = parent price + child price.
 *
 * "Child never added without the parent" is enforced in the viewer, not here.
 */
export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  type Line = { id: string; quantity: number; variantId: string | null; variantTitle: string; productTitle: string };
  const bundles = new Map<
    string,
    { parent: Line | null; lines: Line[] }
  >();

  for (const line of input.cart.lines) {
    const bundleId = line.bundleId?.value;
    if (!bundleId) continue;

    const variant = line.merchandise as { id?: string; title?: string; product?: { title?: string } };
    const info: Line = {
      id: line.id,
      quantity: line.quantity,
      variantId: variant?.id ?? null,
      variantTitle: variant?.title ?? "",
      productTitle: variant?.product?.title ?? "",
    };

    let bundle = bundles.get(bundleId);
    if (!bundle) {
      bundle = { parent: null, lines: [] };
      bundles.set(bundleId, bundle);
    }
    bundle.lines.push(info);
    if (line.isBundleParent?.value === "true") bundle.parent = info;
  }

  const operations = [];
  for (const bundle of bundles.values()) {
    if (!bundle.parent || !bundle.parent.variantId || bundle.lines.length < 2) continue;

    // Parent options first, then each non-parent (child) line's options.
    const parts: string[] = [];
    if (bundle.parent.variantTitle) parts.push(bundle.parent.variantTitle);
    for (const l of bundle.lines) {
      if (l === bundle.parent) continue;
      if (l.variantTitle) parts.push(l.variantTitle);
    }
    const combinedOptions = parts.filter(Boolean).join(" / ");
    const title = bundle.parent.productTitle && combinedOptions
      ? `${bundle.parent.productTitle} - ${combinedOptions}`
      : (combinedOptions || bundle.parent.productTitle || undefined);

    operations.push({
      linesMerge: {
        parentVariantId: bundle.parent.variantId,
        cartLines: bundle.lines.map((l) => ({ cartLineId: l.id, quantity: l.quantity })),
        ...(title ? { title } : {}),
      },
    });
  }

  if (operations.length === 0) return NO_CHANGES;
  return { operations };
}
