import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const DEFAULT_LAMBDA_URL = "http://localhost:3000/dev";

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

    // --- Intent: SYNC VARIANT PRICES & GENERATE NEW ARRAYS ---
    if (intent === "create_variations") {
      const projectId = formData.get("projectId")?.toString().trim();
      const attrMappingRaw = formData.get("attrMapping")?.toString() || "[]";
      let attrMapping = [];
      try { attrMapping = JSON.parse(attrMappingRaw); } catch (e) {}
      const basePrice = parseFloat(formData.get("basePrice")?.toString() || "0") || 0;
      const useAsAttributes = formData.get("useAsAttributes") === "true";
      const isParent = formData.get("isParent") === "true";
      
      console.log(`[API] CREATE_VARIATIONS -> isParent string: "${formData.get("isParent")}", parsed boolean: ${isParent}`);

      try {
        // Paginate through ALL variants — products can exceed 100 variants
        // (e.g. 6 colors × 9 interior × 5 heater = 270). Fetching only the first
        // page would leave later variants un-priced (stuck at their old value).
        const variants = [];
        let cursor = null;
        let hasNextPage = true;
        while (hasNextPage) {
          const existingRes = await admin.graphql(
            `query getVariants($id: ID!, $cursor: String) {
              product(id: $id) {
                variants(first: 250, after: $cursor) {
                  nodes { id title price selectedOptions { name value } }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }`,
            { variables: { id: productGid, cursor } }
          );
          const existingData = await existingRes.json();
          const conn = existingData.data?.product?.variants;
          variants.push(...(conn?.nodes || []));
          hasNextPage = conn?.pageInfo?.hasNextPage || false;
          cursor = conn?.pageInfo?.endCursor || null;
        }

        if (variants.length === 0) {
          return Response.json({ variationError: "No variants found for this product." });
        }

        const variantsToUpdate = variants.map((variant) => {
          let attributeAddonPrice = 0;
          for (const option of variant.selectedOptions) {
            const matchedRow = attrMapping.find((row) => row.shopifyOption === option.name);
            if (matchedRow?.items) {
              const matchedItem = matchedRow.items.find((item) => item.shopifyValue === option.value);
              if (matchedItem) attributeAddonPrice += parseFloat(matchedItem.price) || 0;
            }
          }
          const variantRow = attrMapping.find((row) => row.shopifyOption === "Product Variants");
          if (variantRow?.items) {
            const matchedItem = variantRow.items.find((item) => item.shopifyValue === variant.title);
            if (matchedItem) attributeAddonPrice += parseFloat(matchedItem.price) || 0;
          }
          // Child products carry only their own option prices — basePrice belongs to the parent only
          const finalPrice = isParent
            ? (basePrice + attributeAddonPrice).toFixed(2)
            : attributeAddonPrice.toFixed(2);
          return {
            id: variant.id,
            price: finalPrice,
            inventoryItem: { tracked: false }
          };
        });

        // productVariantsBulkUpdate accepts at most 250 variants per call — chunk it.
        const updatedVariants = [];
        for (let i = 0; i < variantsToUpdate.length; i += 250) {
          const chunk = variantsToUpdate.slice(i, i + 250);
          const res = await admin.graphql(
            `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                productVariants { id price }
                userErrors { field message }
              }
            }`,
            { variables: { productId: productGid, variants: chunk } }
          );
          const data = await res.json();

          if (data.errors) {
            console.error("GraphQL Schema Error:", data.errors);
            return Response.json({ variationError: `Shopify GraphQL Error: ${data.errors[0].message}` });
          }

          const errors = data.data?.productVariantsBulkUpdate?.userErrors;
          if (errors?.length > 0) {
            return Response.json({ variationError: `Shopify Error: ${errors.map(e => e.message).join(", ")}` });
          }

          updatedVariants.push(...(data.data?.productVariantsBulkUpdate?.productVariants || []));
        }

        // Build Multi-Product Token Maps
        const variantMapping = {};
        const menuSlotsSet = new Set();

        for (const variant of variants) {
          const keyTokens = [];
          for (const option of variant.selectedOptions) {
            const matchedRow = attrMapping.find((row) => row.shopifyOption === option.name);
            if (matchedRow?.viewerMenu && matchedRow?.items) {
              const menuId = matchedRow.viewerMenuId || matchedRow.viewerMenu;
              menuSlotsSet.add(menuId);
              const matchedItem = matchedRow.items.find((item) => item.shopifyValue === option.value);
              const optId = matchedItem?.viewerOption?.id;
              if (matchedItem && menuId && optId) {
                keyTokens.push(`${menuId}:${optId}`);
              }
            }
          }
          const variantRow = attrMapping.find((row) => row.shopifyOption === "Product Variants");
          if (variantRow?.viewerMenu && variantRow?.items) {
            const menuId = variantRow.viewerMenuId || variantRow.viewerMenu;
            menuSlotsSet.add(menuId);
            const matchedItem = variantRow.items.find((item) => item.shopifyValue === variant.title);
            const optId = matchedItem?.viewerOption?.id;
            if (matchedItem && menuId && optId) {
              keyTokens.push(`${menuId}:${optId}`);
            }
          }
          if (keyTokens.length > 0) {
            variantMapping[keyTokens.sort().join(',')] = variant.id.split('/').pop();
          }
        }

        const menuSlots = Array.from(menuSlotsSet);

        // FIXED: Pack mapping configurations securely inside the 'products' array block
        if (projectId && accessToken && Object.keys(variantMapping).length > 0) {
          try {
            await fetch(`${lambdaUrl}/viewer/${projectId}/options`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json", "x-access-token": accessToken },
              body: JSON.stringify({
                shopify: {
                  basePrice: basePrice,
                  products: [
                    {
                      productId: productId,
                      menuSlots: menuSlots,
                      varientMapping: variantMapping,
                      isParent: isParent
                    }
                  ]
                },
                "use as attributes of product": useAsAttributes
              }),
            });
          } catch (err) {
            console.error("Variant mapping sync failed:", err);
          }
        }

        return Response.json({
          variationSuccess: true,
          variationCount: variants.length,
          updatedCount: updatedVariants.length,
        });
      } catch (err) {
        return Response.json({ variationError: `Sync failed: ${err.message}` });
      }
    }

    // --- Intent: SAVE CONFIG ---
    if (intent === "save_config") {
      const projectId = formData.get("projectId")?.toString().trim() || "";
      const attrMappingRaw = formData.get("attrMapping")?.toString() || "[]";
      let attrMapping = [];
      try { attrMapping = JSON.parse(attrMappingRaw); } catch (e) {
        return Response.json({ saveError: "Failed to parse attribute mapping JSON." });
      }
      const basePrice = parseFloat(formData.get("basePrice")?.toString() || "0") || 0;
      const useAsAttributes = formData.get("useAsAttributes") === "true";
      const isParent = formData.get("isParent") === "true";
      
      console.log(`[API] SAVE_CONFIG -> isParent string: "${formData.get("isParent")}", parsed boolean: ${isParent}`);

      try {
        await prisma.productConfig.upsert({
          where: { shop_productId: { shop: session.shop, productId } },
          update: { projectId, attrMapping: attrMappingRaw, useAsAttributes, isParent },
          create: { shop: session.shop, productId, projectId, attrMapping: attrMappingRaw, useAsAttributes, isParent },
        });

        // When this product becomes parent, clear the role from all siblings so only one product
        // per project holds isParent:true at a time.
        if (isParent && projectId) {
          await prisma.productConfig.updateMany({
            where: { shop: session.shop, projectId, productId: { not: productId } },
            data: { isParent: false },
          });
        }

        if (projectId && accessToken) {
          const menuPrices = {};
          const mapping = {};
          attrMapping.forEach((row) => {
            if (!row.viewerMenu) return;
            mapping[row.shopifyOption] = row.viewerMenu;
            if (!row.items) return;
            if (!menuPrices[row.viewerMenu]) menuPrices[row.viewerMenu] = {};
            row.items.forEach((item) => {
              if (item.viewerOption) {
                const key = item.viewerOption.id || item.viewerOption.label;
                if (key) menuPrices[row.viewerMenu][key] = parseFloat(item.price) || 0;
              }
            });
          });

          try {
            const lambdaShopify = {
              // Only the parent product owns the project-level basePrice.
              // Sending it from a child would overwrite the parent's saved value.
              ...(isParent ? { basePrice } : {}),
              products: [{
                productId: productId,
                isParent: isParent,
              }]
            };
            await fetch(`${lambdaUrl}/viewer/${projectId}/options`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json", "x-access-token": accessToken },
              body: JSON.stringify({
                menuPrices,
                mapping,
                shopify: lambdaShopify,
                "use as attributes of product": useAsAttributes
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
                { ownerId: productGid, namespace: "ikarus_delta", key: "use_as_attributes", value: useAsAttributes ? "true" : "false", type: "single_line_text_field" },
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