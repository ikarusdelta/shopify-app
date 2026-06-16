import type {
  CartTransformRunInput,
  CartTransformRunResult,
} from "../generated/api";

const NO_CHANGES: CartTransformRunResult = {
  operations: [],
};

/**
 * Merges Ikarus parent + child cart lines that share the same `_bundle_id`
 * into a single bundled cart line. This makes the cart count, the line list,
 * and checkout treat a parent/child configuration as ONE item.
 *
 * The lines are tagged by the storefront embed when added:
 *   _bundle_id          → groups the lines of one configuration
 *   _is_bundle_parent   → "true" on the parent line (its variant represents the bundle)
 *
 * Price is left untouched, so the merged line total is the sum of its components
 * (parent variant price + child variant prices).
 */
export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  // Group cart lines by their _bundle_id attribute.
  const bundles = new Map<
    string,
    { parentVariantId: string | null; lines: Array<{ cartLineId: string; quantity: number }> }
  >();

  for (const line of input.cart.lines) {
    const bundleId = line.bundleId?.value;
    if (!bundleId) continue;

    let bundle = bundles.get(bundleId);
    if (!bundle) {
      bundle = { parentVariantId: null, lines: [] };
      bundles.set(bundleId, bundle);
    }

    bundle.lines.push({ cartLineId: line.id, quantity: line.quantity });

    if (line.isBundleParent?.value === "true") {
      const variantId = (line.merchandise as { id?: string })?.id;
      if (variantId) bundle.parentVariantId = variantId;
    }
  }

  // Emit a merge operation for every bundle that has a parent and 2+ components.
  const operations = [];
  for (const bundle of bundles.values()) {
    if (!bundle.parentVariantId || bundle.lines.length < 2) continue;
    operations.push({
      linesMerge: {
        cartLines: bundle.lines,
        parentVariantId: bundle.parentVariantId,
      },
    });
  }

  if (operations.length === 0) return NO_CHANGES;
  return { operations };
}
