import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const DEFAULT_LAMBDA_URL = "http://localhost:3000/dev";

// ─── v2 bundle-model helpers ────────────────────────────────────────────────

// Fetch ALL variants of a product (paginated; child products are small, parents
// have a single default variant).
async function fetchAllVariants(admin, productGid) {
  const variants = [];
  let cursor = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const res = await admin.graphql(
      `query getVariants($id: ID!, $cursor: String) {
        product(id: $id) {
          variants(first: 250, after: $cursor) {
            nodes { id title price selectedOptions { name value } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { variables: { id: productGid, cursor } },
    );
    const data = await res.json();
    const conn = data.data?.product?.variants;
    variants.push(...(conn?.nodes || []));
    hasNextPage = conn?.pageInfo?.hasNextPage || false;
    cursor = conn?.pageInfo?.endCursor || null;
  }
  return variants;
}

// Set variant prices in chunks of 250 (Shopify's per-call limit). Returns userError string or null.
async function bulkUpdateVariantPrices(admin, productGid, variantsToUpdate) {
  for (let i = 0; i < variantsToUpdate.length; i += 250) {
    const chunk = variantsToUpdate.slice(i, i + 250);
    const res = await admin.graphql(
      `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price }
          userErrors { field message }
        }
      }`,
      { variables: { productId: productGid, variants: chunk } },
    );
    const data = await res.json();
    if (data.errors) return data.errors[0]?.message || "GraphQL error";
    const errs = data.data?.productVariantsBulkUpdate?.userErrors;
    if (errs?.length > 0) return errs.map((e) => e.message).join(", ");
  }
  return null;
}

// From a CHILD product's variants + the attrMapping, build the bundle map for the
// new model. A child = one viewer menu; each variant = one option.
//   returns { menuId, varientMapping: { "<optionId>": { cvid, name } }, priced: [...] }
// `priced` sets each variant's price to its OWN option price (child base = 0).
function buildChildMapping(variants, attrMapping) {
  let menuId = null;
  const varientMapping = {};
  const priced = [];

  const matchForVariant = (variant) => {
    // Prefer option-name match (product has a real option like "Style").
    for (const option of variant.selectedOptions || []) {
      const row = attrMapping.find((r) => r.shopifyOption === option.name);
      const item = row?.items?.find((i) => i.shopifyValue === option.value);
      if (item) return { item, row };
    }
    // Fallback: the virtual "Product Variants" row matches by variant title.
    const vRow = attrMapping.find((r) => r.shopifyOption === "Product Variants");
    const vItem = vRow?.items?.find((i) => i.shopifyValue === variant.title);
    if (vItem) return { item: vItem, row: vRow };
    return { item: null, row: null };
  };

  for (const variant of variants) {
    const { item, row } = matchForVariant(variant);
    const oid = item?.viewerOption?.id;
    if (!item || !oid) continue;

    const cvid = variant.id.split("/").pop();
    varientMapping[oid] = { cvid, name: item.viewerOption.label || variant.title || "" };
    if (row && (row.viewerMenuId || row.viewerMenu)) menuId = row.viewerMenuId || row.viewerMenu;

    priced.push({
      id: variant.id,
      price: (parseFloat(item.price) || 0).toFixed(2),
      inventoryItem: { tracked: false },
    });
  }
  return { menuId, varientMapping, priced };
}

// Per-option display prices for the viewer (written into master.models via the
// Lambda's menuPrices handler). Keyed by viewer menu id → option slug/id → price.
function buildMenuPrices(attrMapping) {
  const menuPrices = {};
  const mapping = {};
  (attrMapping || []).forEach((row) => {
    if (!row.viewerMenu) return;
    mapping[row.shopifyOption] = row.viewerMenu;
    const menuKey = row.viewerMenuId || row.viewerMenu;
    if (!row.items) return;
    if (!menuPrices[menuKey]) menuPrices[menuKey] = {};
    row.items.forEach((item) => {
      if (!item.viewerOption) return;
      const slug =
        item.viewerOption.slug ||
        item.viewerOption.target ||
        item.viewerOption.id ||
        item.viewerOption.label;
      const p = parseFloat(item.price);
      if (slug && !isNaN(p) && p > 0) menuPrices[menuKey][slug] = p;
    });
  });
  return { menuPrices, mapping };
}

export const action = async ({ request }) => {
  const url = new URL(request.url);
  console.log("[API] Incoming request params:", Object.fromEntries(url.searchParams));
  console.log("[API] Auth header:", request.headers.get("Authorization")?.slice(0, 30));

  try {
    const { admin, session } = await authenticate.admin(request);
    
    // Safely extract productId from URL query params
    const productId = url.searchParams.get("productId");
    const productGid = `gid://shopify/Product/${productId}`;
    
    const formData = await request.formData();
    const intent = formData.get("intent")?.toString();

    const settings = await prisma.shopSettings.findUnique({
      where: { shop: session.shop },
    });
    const accessToken = settings?.accessToken || "";
    const lambdaUrl = (process.env.LAMBDA_URL || DEFAULT_LAMBDA_URL).replace(/\/$/, "");
    
    if (process.env.NODE_ENV === "development") {
      console.log(`[API] Using Lambda URL: ${lambdaUrl}`);
    }

    if (intent === "ping") {
      return Response.json({ ok: true });
    }

    // --- Intent: LOAD MENUS ---
    if (intent === "load_menus") {
      const projectId = formData.get("projectId")?.toString().trim();
      const callerProductId = formData.get("productId")?.toString().trim() || productId || "";
      if (!projectId) return Response.json({ error: "No Project ID provided" });
      if (!accessToken) return Response.json({ error: "No Access Token set in Settings" });

      // Check if another product in this project already holds the parent role.
      // Use the numeric productId from the URL param (DB stores numeric IDs, not GIDs).
      let siblingIsParent = false;
      if (projectId && productId) {
        const siblingParent = await prisma.productConfig.findFirst({
          where: {
            shop: session.shop,
            projectId,
            productId: { not: productId },
            isParent: true,
          },
        });
        siblingIsParent = !!siblingParent;
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(`${lambdaUrl}/viewer/${projectId}/options`, {
          headers: { "x-access-token": accessToken },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
          const err = await response.text();
          return Response.json({ error: `API Error: ${response.status} ${err}` });
        }
        const data = await response.json();
        return Response.json({ menuOptions: data.menuOptions || {}, siblingIsParent, shopifyBasePrice: data.shopifyBasePrice ?? null });
      } catch (err) {
        if (err.name === "AbortError") return Response.json({ error: "Load menus timed out (15s)." });
        return Response.json({ error: `Fetch failed: ${err.message}` });
      }
    }

    // --- Intent: SYNC PRICES (v2 bundle model) ---
    // PARENT: set the parent's single variant price = basePrice, store parent identity.
    // CHILD : set each variant's price = its own option price, store childs[] mapping.
    if (intent === "create_variations") {
      const projectId = formData.get("projectId")?.toString().trim();
      const attrMappingRaw = formData.get("attrMapping")?.toString() || "[]";
      let attrMapping = [];
      try { attrMapping = JSON.parse(attrMappingRaw); } catch (e) {}
      const basePrice = parseFloat(formData.get("basePrice")?.toString() || "0") || 0;
      const isParent = formData.get("isParent") === "true";
      const isChild = formData.get("isChild") === "true" && !isParent;

      try {
        const variants = await fetchAllVariants(admin, productGid);
        if (variants.length === 0) {
          return Response.json({ variationError: "No variants found for this product." });
        }

        if (isParent) {
          // Parent = single default variant priced at basePrice.
          const parent = variants[0];
          const err = await bulkUpdateVariantPrices(admin, productGid, [
            { id: parent.id, price: basePrice.toFixed(2), inventoryItem: { tracked: false } },
          ]);
          if (err) return Response.json({ variationError: `Shopify Error: ${err}` });

          const parentVariantId = parent.id.split("/").pop();
          if (projectId && accessToken) {
            await fetch(`${lambdaUrl}/viewer/${projectId}/options`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json", "x-access-token": accessToken },
              body: JSON.stringify({
                shopify: { isParent: true, productId, parentVariantId, basePrice },
              }),
            });
          }
          return Response.json({ variationSuccess: true, variationCount: 1, role: "parent" });
        }

        // CHILD (default): price each option variant + build the oid→variant map.
        const { menuId, varientMapping, priced } = buildChildMapping(variants, attrMapping);
        if (priced.length === 0) {
          return Response.json({ variationError: "No variants matched the option mapping. Map the variants to viewer options first." });
        }

        const err = await bulkUpdateVariantPrices(admin, productGid, priced);
        if (err) return Response.json({ variationError: `Shopify Error: ${err}` });

        if (projectId && accessToken) {
          const { menuPrices, mapping } = buildMenuPrices(attrMapping);
          await fetch(`${lambdaUrl}/viewer/${projectId}/options`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "x-access-token": accessToken },
            body: JSON.stringify({
              menuPrices,
              mapping,
              shopify: { isChild: true, child: { productId, menuId, varientMapping } },
            }),
          });
        }
        return Response.json({
          variationSuccess: true,
          variationCount: priced.length,
          role: "child",
        });
      } catch (err) {
        return Response.json({ variationError: `Sync failed: ${err.message}` });
      }
    }

    // --- Intent: SAVE CONFIG (v2 bundle model) ---
    if (intent === "save_config") {
      const projectId = formData.get("projectId")?.toString().trim() || "";
      const attrMappingRaw = formData.get("attrMapping")?.toString() || "[]";
      let attrMapping = [];
      try { attrMapping = JSON.parse(attrMappingRaw); } catch (e) {
        return Response.json({ saveError: "Failed to parse attribute mapping JSON." });
      }
      const basePrice = parseFloat(formData.get("basePrice")?.toString() || "0") || 0;
      // Parent and Child are mutually exclusive; parent wins if both somehow arrive.
      const isParent = formData.get("isParent") === "true";
      const isChild = formData.get("isChild") === "true" && !isParent;

      // The viewer menu this child maps to (first mapped row).
      const mappedRow = attrMapping.find((r) => r.viewerMenu);
      const menuId = mappedRow ? (mappedRow.viewerMenuId || mappedRow.viewerMenu) : "";

      try {
        await prisma.productConfig.upsert({
          where: { shop_productId: { shop: session.shop, productId } },
          update: { projectId, attrMapping: attrMappingRaw, isParent, isChild, menuId },
          create: { shop: session.shop, productId, projectId, attrMapping: attrMappingRaw, isParent, isChild, menuId },
        });

        // Only one parent per project.
        if (isParent && projectId) {
          await prisma.productConfig.updateMany({
            where: { shop: session.shop, projectId, productId: { not: productId } },
            data: { isParent: false },
          });
        }

        if (projectId && accessToken) {
          const { menuPrices, mapping } = buildMenuPrices(attrMapping);
          let shopifyPayload = null;

          if (isParent) {
            // Parent identity + basePrice. Fetch the default variant for parentVariantId.
            const variants = await fetchAllVariants(admin, productGid);
            const parentVariantId = variants[0]?.id.split("/").pop() || null;
            shopifyPayload = { isParent: true, productId, parentVariantId, basePrice };
          } else if (isChild) {
            // Child bundle map (oid→variant). Build from variants so the viewer works
            // after Save even without a separate Sync (Sync additionally sets prices).
            const variants = await fetchAllVariants(admin, productGid);
            const built = buildChildMapping(variants, attrMapping);
            shopifyPayload = {
              isChild: true,
              child: { productId, menuId: built.menuId || menuId, varientMapping: built.varientMapping },
            };
          }

          try {
            await fetch(`${lambdaUrl}/viewer/${projectId}/options`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json", "x-access-token": accessToken },
              body: JSON.stringify({
                menuPrices,
                mapping,
                ...(shopifyPayload ? { shopify: shopifyPayload } : {}),
              }),
            });
          } catch (err) {
            console.error("Lambda sync failed:", err);
          }
        }

        const metafieldRes = await admin.graphql(
          `mutation setMetafields($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors { field message }
            }
          }`,
          {
            variables: {
              metafields: [
                { ownerId: productGid, namespace: "ikarus_delta", key: "project_id", value: projectId, type: "single_line_text_field" },
                { ownerId: productGid, namespace: "ikarus_delta", key: "mapping", value: JSON.stringify(attrMapping), type: "json" },
                { ownerId: productGid, namespace: "ikarus_delta", key: "role", value: isParent ? "parent" : (isChild ? "child" : ""), type: "single_line_text_field" },
              ],
            },
          }
        );
        const metafieldData = await metafieldRes.json();
        const metafieldErrors = metafieldData?.data?.metafieldsSet?.userErrors;
        if (metafieldErrors?.length > 0) {
          return Response.json({ saveError: `Metafield Error: ${metafieldErrors.map(e => e.message).join(", ")}` });
        }

        return Response.json({ success: true });
      } catch (err) {
        return Response.json({ saveError: `Save failed: ${err.message}` });
      }
    }

    return Response.json({ error: "Unknown intent" });

  } catch (err) {
    console.log("[API] Auth error type:", err?.constructor?.name);
    
    if (err instanceof Response) {
      return Response.json({ error: "SESSION_ESTABLISHING" }, { status: 401 });
    }
    return Response.json({ error: `Unexpected error: ${err.message}` }, { status: 500 });
  }
};