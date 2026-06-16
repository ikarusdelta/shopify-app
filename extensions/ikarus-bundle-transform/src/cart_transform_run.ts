import type {
  CartTransformRunInput,
  CartTransformRunResult,
} from "../generated/api";

const NO_CHANGES: CartTransformRunResult = {
  operations: [],
};

/**
 * No-op. Bundle presentation (combining the parent + child selected options into
 * one visible line, hiding the child row, and patching the cart count) is handled
 * client-side by the "Ikarus Cart Listener" embed (ikarus-embed.liquid).
 *
 * We intentionally do NOT merge the lines here: a native linesMerge collapses the
 * bundle to the parent variant and loses the child product's selected-option display.
 * The "child is never added without the parent" rule is enforced in the viewer
 * (handleAddToCartPostMessage), not here.
 */
export function cartTransformRun(_input: CartTransformRunInput): CartTransformRunResult {
  return NO_CHANGES;
}
