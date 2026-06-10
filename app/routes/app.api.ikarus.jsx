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
      if (!projectId) return Response.json({ error: "No Project ID provided" });
      if (!accessToken) return Response.json({ error: "No Access Token set in Settings" });

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
        return Response.json({ menuOptions: data.menuOptions || {} });
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
        const existingRes = await admin.graphql(
          `query getVariants($id: ID!) {
            product(id: $id) {
              variants(first: 100) {
                nodes { id title price selectedOptions { name value } }
              }
            }
          }`,
          { variables: { id: productGid } }
        );
        const existingData = await existingRes.json();
        const variants = existingData.data?.product?.variants?.nodes || [];

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
          return { id: variant.id, price: (basePrice + attributeAddonPrice).toFixed(2) };
        });

        const res = await admin.graphql(
          `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants { id price }
              userErrors { field message }
            }
          }`,
          { variables: { productId: productGid, variants: variantsToUpdate } }
        );
        const data = await res.json();
        const errors = data.data?.productVariantsBulkUpdate?.userErrors;
        if (errors?.length > 0) {
          return Response.json({ variationError: `Shopify Error: ${errors.map(e => e.message).join(", ")}` });
        }

        const updatedVariants = data.data?.productVariantsBulkUpdate?.productVariants || [];

        // Build Multi-Product Token Maps
        const variantMapping = {};
        const menuSlotsSet = new Set();

        for (const variant of variants) {
          const keyTokens = [];
          for (const option of variant.selectedOptions) {
            const matchedRow = attrMapping.find((row) => row.shopifyOption === option.name);
            if (matchedRow?.viewerMenu && matchedRow?.items) {
              menuSlotsSet.add(matchedRow.viewerMenu);
              const matchedItem = matchedRow.items.find((item) => item.shopifyValue === option.value);
              if (matchedItem?.viewerOption?.label) {
                keyTokens.push(`${matchedRow.viewerMenu}:${matchedItem.viewerOption.label}`);
              }
            }
          }
          const variantRow = attrMapping.find((row) => row.shopifyOption === "Product Variants");
          if (variantRow?.viewerMenu && variantRow?.items) {
            menuSlotsSet.add(variantRow.viewerMenu);
            const matchedItem = variantRow.items.find((item) => item.shopifyValue === variant.title);
            if (matchedItem?.viewerOption?.label) {
              keyTokens.push(`${variantRow.viewerMenu}:${matchedItem.viewerOption.label}`);
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
            await fetch(`${lambdaUrl}/viewer/${projectId}/options`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json", "x-access-token": accessToken },
              body: JSON.stringify({ 
                menuPrices, 
                mapping, 
                shopify: { 
                  basePrice,
                  products: [{
                    productId: productId,
                    isParent: isParent,
                  }]
                },
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