import type {
  CartTransformRunInput,
  CartTransformRunResult,
} from "../generated/api";

const NO_CHANGES: CartTransformRunResult = {
  operations: [],
};

/**
 * No-op. The Ikarus `cart-items` app block is bundle-aware and renders the bundle
 * itself (groups parent + child lines by `_bundle_id`, shows the combined options,
 * hides the child rows). We must NOT merge here: a server-side merge folds the child
 * line into the parent, removing the line the block needs to read the child's options.
 *
 * "Child never added without the parent" is enforced in the viewer, not here.
 */
export function cartTransformRun(_input: CartTransformRunInput): CartTransformRunResult {
  return NO_CHANGES;
}
