import { useState, useEffect } from "react";
import { Form, useActionData, useLoaderData, useNavigation, useFetcher, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Fallback if LAMBDA_URL is not in .env
const DEFAULT_LAMBDA_URL = "http://localhost:3000/dev";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  // If no productId, fetch the product list
  if (!productId) {
    const response = await admin.graphql(`
      query {
        products(first: 50, sortKey: TITLE) {
          edges {
            node {
              id
              title
              status
              featuredImage { url altText }
              variants(first: 1) { edges { node { price } } }
            }
          }
        }
      }
    `);
    const data = await response.json();
    return { type: "list", products: data.data.products.edges.map(e => e.node) };
  }

  // Otherwise, fetch specific product configuration
  const productGid = `gid://shopify/Product/${productId}`;

  // 1. Fetch Shopify Product Data
  const productResponse = await admin.graphql(
    `query getProduct($id: ID!) {
      product(id: $id) {
        id
        title
        options { name values }
        variants(first: 100) {
          nodes {
            id
            title
            price
            selectedOptions { name value }
          }
        }
      }
    }`,
    { variables: { id: productGid } },
  );

  const productData = await productResponse.json();
  const product = productData.data.product;
  if (!product) throw new Response("Product not found", { status: 404 });

  // Add a virtual "Product Variants" option to the list safely
  const productOptions = [
    ...(product.options || []),
    { name: "Product Variants", values: (product.variants?.nodes || []).map((v) => v.title) },
  ];

  // 2. Fetch Ikarus Access Token from Shop Settings
  const settings = await prisma.shopSettings.findUnique({
    where: { shop: session.shop },
  });

  // 3. Fetch Product Config from Database
  const config = await prisma.productConfig.findUnique({
    where: { shop_productId: { shop: session.shop, productId } },
  });

  // Safely parse JSON to prevent crashes if DB string is malformed
  let parsedMapping = [];
  try {
    parsedMapping = JSON.parse(config?.attrMapping || "[]");
    if (!Array.isArray(parsedMapping)) parsedMapping = [];
  } catch (e) {
    parsedMapping = [];
  }

  // Check if a sibling product (same projectId, same shop) already holds the parent role
  const currentProjectId = config?.projectId || "";
  let parentSetBySibling = false;
  if (currentProjectId) {
    const siblingParent = await prisma.productConfig.findFirst({
      where: {
        shop: session.shop,
        projectId: currentProjectId,
        productId: { not: productId },
        isParent: true,
      },
    });
    parentSetBySibling = !!siblingParent;
  }

  // Auto-parent: if no sibling holds the parent role, default this product to parent
  const savedIsParent = config?.isParent === true;
  const effectiveIsParent = savedIsParent || !parentSetBySibling;

  return {
    type: "detail",
    shop: session.shop,
    product,
    productId,
    productOptions,
    projectId: config?.projectId || "",
    attrMapping: parsedMapping,
    // Safely cast database row value to explicit boolean flag
    useAsAttributes: config?.useAsAttributes === true,
    isParent: effectiveIsParent,
    parentSetBySibling,
    accessToken: settings?.accessToken || "",
    lambdaUrl: process.env.LAMBDA_URL || DEFAULT_LAMBDA_URL,
  };
};

export const action = async ({ request }) => {
  const isFetcherRequest = request.headers.get("Accept")?.includes("application/json") === true
    || request.headers.get("X-Remix-Prevent-Reloads") != null
    || request.headers.get("X-React-Router") != null;

  try {
    const { admin, session } = await authenticate.admin(request);
    const url = new URL(request.url);
    const productId = url.searchParams.get("productId");
    const productGid = `gid://shopify/Product/${productId}`;
    const formData = await request.formData();
    const intent = formData.get("intent")?.toString();

    // Fetch access token for API calls
    const settings = await prisma.shopSettings.findUnique({
      where: { shop: session.shop },
    });
    const accessToken = settings?.accessToken || "";
    const lambdaUrl = (process.env.LAMBDA_URL || DEFAULT_LAMBDA_URL).replace(/\/$/, "");

    // --- Intent: LOAD MENUS ---
    if (intent === "load_menus") {
      const projectId = formData.get("projectId")?.toString().trim();
      if (!projectId) return { error: "No Project ID provided" };
      if (!accessToken) return { error: "No Access Token set in Settings" };

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
          return { error: `API Error: ${response.status} ${err}` };
        }

        const data = await response.json();
        return { menuOptions: data.menuOptions || {} };
      } catch (err) {
        if (err.name === "AbortError") return { error: "Load menus timed out (15s). Check your Lambda URL and access token." };
        return { error: `Fetch failed: ${err.message}` };
      }
    }

    // --- Intent: SYNC / COMPUTE VARIATION PRICES & GENERATE MAPPINGS ---
    if (intent === "create_variations") {
      const projectId = formData.get("projectId")?.toString().trim();
      const attrMappingRaw = formData.get("attrMapping")?.toString() || "[]";
      let attrMapping = [];
      try { attrMapping = JSON.parse(attrMappingRaw); } catch (e) { }

      const basePriceRaw = formData.get("basePrice")?.toString() || "0";
      const basePrice = parseFloat(basePriceRaw) || 0;
      const useAsAttributes = formData.get("useAsAttributes") === "true";
      const isParent = formData.get("isParent") === "true";

      try {
        console.log(`[Ikarus Sync] Starting bulk price sync for base price: $${basePrice}`);

        const existingRes = await admin.graphql(
          `query getVariants($id: ID!) {
          product(id: $id) {
            variants(first: 100) {
              nodes {
                id
                title
                price
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
        }`,
          { variables: { id: productGid } }
        );

        const existingData = await existingRes.json();
        const variants = existingData.data?.product?.variants?.nodes || [];

        if (variants.length === 0) {
          return { variationError: "No variants found for this product in Shopify." };
        }

        const variantsToUpdate = variants.map((variant) => {
          let attributeAddonPrice = 0;

          for (const option of variant.selectedOptions) {
            const matchedRow = attrMapping.find((row) => row.shopifyOption === option.name);
            if (matchedRow && matchedRow.items) {
              const matchedItem = matchedRow.items.find((item) => item.shopifyValue === option.value);
              if (matchedItem) {
                attributeAddonPrice += parseFloat(matchedItem.price) || 0;
              }
            }
          }

          const variantRow = attrMapping.find((row) => row.shopifyOption === "Product Variants");
          if (variantRow && variantRow.viewerMenu && variantRow.items) {
            const matchedItem = variantRow.items.find((item) => item.shopifyValue === variant.title);
            if (matchedItem) {
              attributeAddonPrice += parseFloat(matchedItem.price) || 0;
            }
          }

          // Child products carry only their own option prices — basePrice belongs to the parent only
          const finalCalculatedPrice = isParent
            ? (basePrice + attributeAddonPrice).toFixed(2)
            : attributeAddonPrice.toFixed(2);

          return {
            id: variant.id,
            price: finalCalculatedPrice
          };
        });

        console.log(`[Ikarus Sync] Sending Bulk Update Payload to Shopify:`, JSON.stringify(variantsToUpdate, null, 2));

        const res = await admin.graphql(
          `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id price }
            userErrors { field message }
          }
        }`,
          {
            variables: {
              productId: productGid,
              variants: variantsToUpdate
            }
          }
        );

        const data = await res.json();
        const errors = data.data?.productVariantsBulkUpdate?.userErrors;

        if (errors && errors.length > 0) {
          console.error("[Ikarus Sync] Shopify Bulk Update Error:", errors);
          return { variationError: `Shopify Error: ${errors.map((e) => e.message).join(", ")}` };
        }

        const updatedVariants = data.data?.productVariantsBulkUpdate?.productVariants || [];
        console.log(`[Ikarus Sync] Successfully updated ${updatedVariants.length} variants.`);

        const nk = (s) => (s || '').trim().toLowerCase();

        const variantMapping = {};
        const priceMapping = {};

        for (const variant of variants) {
          const keyTokens = [];

          for (const option of variant.selectedOptions) {
            const matchedRow = attrMapping.find((row) => row.shopifyOption === option.name);
            if (matchedRow && matchedRow.viewerMenu && matchedRow.items) {
              const matchedItem = matchedRow.items.find((item) => item.shopifyValue === option.value);
              if (matchedItem?.viewerOption?.label) {
                keyTokens.push(`${nk(matchedRow.viewerMenu)}:${nk(matchedItem.viewerOption.label)}`);
              }
            }
          }

          const variantRow = attrMapping.find((row) => row.shopifyOption === "Product Variants");
          if (variantRow && variantRow.viewerMenu && variantRow.items) {
            const matchedItem = variantRow.items.find((item) => item.shopifyValue === variant.title);
            if (matchedItem?.viewerOption?.label) {
              keyTokens.push(`${nk(variantRow.viewerMenu)}:${nk(matchedItem.viewerOption.label)}`);
            }
          }

          if (keyTokens.length > 0) {
            const mappingKey = keyTokens.sort().join(',');
            const cleanVariantId = variant.id.split('/').pop();
            variantMapping[mappingKey] = cleanVariantId;
          }
        }

        // priceMapping: variantId → calculated price (exact price Shopify will charge)
        for (const v of variantsToUpdate) {
          const cleanId = v.id.split('/').pop();
          priceMapping[cleanId] = parseFloat(v.price);
        }

        console.log(`[Ikarus Sync] Constructed Variant Mapping:`, variantMapping);
        console.log(`[Ikarus Sync] Constructed Price Mapping:`, priceMapping);

        if (projectId && accessToken && Object.keys(variantMapping).length > 0) {
          try {
            const menuSlots = Array.from(new Set(attrMapping.map(row => row.viewerMenu).filter(Boolean)));

            const response = await fetch(`${lambdaUrl}/viewer/${projectId}/options`, {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
                "x-access-token": accessToken,
              },
              body: JSON.stringify({
                shopify: {
                  basePrice: basePrice,
                  products: [{
                    productId: productId,
                    menuSlots: menuSlots,
                    varientMapping: variantMapping,
                    priceMapping: priceMapping,
                    isParent: isParent
                  }]
                }
              }),
            });

            if (!response.ok) {
              console.error("Ikarus API Variant Mapping Sync returned error:", await response.text());
            } else {
              console.log(`[Ikarus Sync] Successfully pushed varientMapping configuration to master.json`);
            }
          } catch (err) {
            console.error("Ikarus API Variant Mapping Sync network request failed:", err);
          }
        }

        return {
          variationSuccess: true,
          variationCount: variants.length,
          updatedCount: updatedVariants.length,
          createdCount: 0,
        };
      } catch (err) {
        if (err instanceof Response && !isFetcherRequest) throw err;
        if (err instanceof Response) return { variationError: "Session expired. Please reload the page and try again." };
        console.error("[Ikarus Sync] Fatal Action Error:", err);
        return { variationError: `Price computation sync failed: ${err.message}` };
      }
    }

    // --- Intent: SAVE CONFIG ---
    const projectId = formData.get("projectId")?.toString().trim() || "";
    const attrMappingRaw = formData.get("attrMapping")?.toString() || "[]";
    let attrMapping = [];
    try { attrMapping = JSON.parse(attrMappingRaw); } catch (e) {
      return { saveError: "Failed to parse attribute mapping JSON. Please try again." };
    }

    const basePriceRaw = formData.get("basePrice")?.toString() || "0";
    const basePrice = parseFloat(basePriceRaw) || 0;
    const useAsAttributes = formData.get("useAsAttributes") === "true";
    const isParent = formData.get("isParent") === "true";

    console.log(`[Ikarus Save] Saving config for product ${productId}, useAsAttributes: ${useAsAttributes}`);

    try {
      // 1. Save to Local Database
      await prisma.productConfig.upsert({
        where: { shop_productId: { shop: session.shop, productId } },
        update: { projectId, attrMapping: attrMappingRaw, useAsAttributes, isParent },
        create: { shop: session.shop, productId, projectId, attrMapping: attrMappingRaw, useAsAttributes, isParent },
      });

      console.log(`[Ikarus Save] DB upsert successful.`);

      // 2. Push to Ikarus Lambda API (Cleaned: useAsAttributes completely excluded from payload as requested)
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
              if (key) {
                menuPrices[row.viewerMenu][key] = parseFloat(item.price) || 0;
              }
            }
          });
        });

        try {
          const response = await fetch(`${lambdaUrl}/viewer/${projectId}/options`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "x-access-token": accessToken,
            },
            body: JSON.stringify({
              menuPrices,
              mapping,
              shopify: {
                basePrice,
                products: [{
                  productId: productId,
                  isParent: isParent,
                }]
              }
            }),
          });

          if (!response.ok) {
            const errText = await response.text();
            console.error("[Ikarus Save] Lambda API Sync returned error:", errText);
          } else {
            console.log(`[Ikarus Save] Lambda API Sync successful.`);
          }
        } catch (err) {
          console.error("[Ikarus Save] Lambda API Sync fetch failed:", err);
        }
      }

      // 3. Write project ID and Mapping to Shopify Metafields
      const metafieldRes = await admin.graphql(
        `mutation setMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }`,
        {
          variables: {
            metafields: [
              {
                ownerId: productGid,
                namespace: "ikarus_delta",
                key: "project_id",
                value: projectId,
                type: "single_line_text_field",
              },
              {
                ownerId: productGid,
                namespace: "ikarus_delta",
                key: "mapping",
                value: JSON.stringify(attrMapping),
                type: "json",
              },
              {
                ownerId: productGid,
                namespace: "ikarus_delta",
                key: "use_as_attributes",
                value: useAsAttributes ? "true" : "false",
                type: "single_line_text_field",
              },
            ],
          },
        },
      );

      const metafieldData = await metafieldRes.json();
      const metafieldErrors = metafieldData?.data?.metafieldsSet?.userErrors;
      if (metafieldErrors && metafieldErrors.length > 0) {
        const errMsg = metafieldErrors.map((e) => `[${e.field}] ${e.message}`).join(", ");
        console.error("[Ikarus Save] Metafield userErrors:", errMsg);
        return { saveError: `Shopify Metafield Error: ${errMsg}` };
      }

      console.log(`[Ikarus Save] Metafields saved successfully.`);
      return { success: true };

    } catch (err) {
      if (err instanceof Response && !isFetcherRequest) throw err;
      if (err instanceof Response) return { saveError: "Session expired. Please reload the page and try again." };
      console.error("[Ikarus Save] Fatal save error:", err);
      return { saveError: `Save failed: ${err.message}` };
    }

  } catch (outerErr) {
    if (outerErr instanceof Response && !isFetcherRequest) throw outerErr;
    if (outerErr instanceof Response) {
      return { error: "Session expired. Please reload the page and try again.", saveError: "Session expired. Please reload the page and try again." };
    }

    console.error("[Ikarus Action] Unhandled top-level error:", outerErr);
    return { error: `Unexpected error: ${outerErr.message}`, saveError: `Unexpected error: ${outerErr.message}` };
  }
};

function ProductListView({ products }) {
  const [searchParams, setSearchParams] = useSearchParams();

  return (
    <s-page heading="Products">
      <s-section heading="Configure 3D Viewer">
        <s-paragraph>
          Select a product to set its IkarusDelta Project ID and configure
          attribute prices for the 3D viewer.
        </s-paragraph>
        {products.length === 0 ? (
          <s-paragraph>No products found in your store.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {products.map((product) => {
              const numericId = product.id.replace("gid://shopify/Product/", "");
              const price = product.variants.edges[0]?.node.price;
              return (
                <s-box key={product.id} padding="base" borderWidth="base" borderRadius="base">
                  <s-stack direction="inline">
                    {product.featuredImage && (
                      <img src={product.featuredImage.url} alt={product.title} width={40} height={40} style={{ objectFit: "cover", borderRadius: 4, flexShrink: 0 }} />
                    )}
                    <s-stack direction="block" gap="none" style={{ flex: 1 }}>
                      <s-text>{product.title}</s-text>
                      {price && <s-text tone="subdued">From ${price}</s-text>}
                    </s-stack>
                    <div style={{margin:"0 20px"}}>
                      <s-button onClick={() => {
                        setSearchParams((prev) => {
                          const next = new URLSearchParams(prev);
                          next.set('productId', numericId);
                          return next;
                        });
                      }}>Configure</s-button>
                    </div>
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export default function ProductsPage() {
  const data = useLoaderData();
  if (data.type === "list") return <ProductListView products={data.products} />;
  return <ProductConfigPage />;
}

function ProductConfigPage() {
  const { product, projectId: savedProjectId, attrMapping: savedMapping, productOptions, useAsAttributes: savedUseAsAttributes, isParent: savedIsParent, parentSetBySibling } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const [isLoadingMenus, setIsLoadingMenus] = useState(false);
  const [isCreatingVars, setIsCreatingVars] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [variationSuccessMsg, setVariationSuccessMsg] = useState("");

  const [toast, setToast] = useState(null);

  const doManualFetch = async (payload, setLoading, onSuccess, successMsg, isRetry = false) => {
    setLoading(true);
    if (!isRetry) {
      setToast(null);
      setVariationSuccessMsg("");
    }
    try {
      const token = await window.shopify.idToken();
      const formData = new FormData();
      Object.keys(payload).forEach(k => formData.append(k, payload[k]));

      const url = new URL("/app/api/ikarus", window.location.origin);
      
      const currentParams = new URLSearchParams(window.location.search);
      currentParams.forEach((value, key) => {
        url.searchParams.set(key, value);
      });

      const res = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
        },
        body: formData
      });

      console.log("Status:", res.status, "| URL:", res.url);
      const contentType = res.headers.get("content-type") || "";

      if (!contentType.includes("application/json")) {
        const text = await res.text();
        console.error("Non-JSON body:", text.slice(0, 800));
        setToast({ message: `❌ Server error (${res.status}). Check console.`, type: "error" });
        return;
      }

      const data = await res.json();

      if (data.error === "SESSION_ESTABLISHING" && !isRetry) {
        console.log("[IKD] Session establishing, retrying in 1s...");
        await new Promise(resolve => setTimeout(resolve, 1000));
        return doManualFetch(payload, setLoading, onSuccess, successMsg, true);
      }

      if (data.error || data.saveError || data.variationError) {
        setToast({ message: `❌ ${data.error || data.saveError || data.variationError}`, type: "error" });
      } else {
        if (successMsg) setToast({ message: successMsg, type: "success" });
        if (onSuccess) onSuccess(data);
      }
    } catch (err) {
      setToast({ message: `❌ Network error: ${err.message}`, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const [searchParams] = useSearchParams();
  const searchStr = searchParams.toString();
  const queryString = searchStr ? `?${searchStr}` : "";

  const [projectId, setProjectId] = useState(savedProjectId || "");
  const [mapRows, setMapRows] = useState(Array.isArray(savedMapping) ? savedMapping : []);
  const [viewerMenus, setViewerMenus] = useState(null);

  const initialBasePrice = product?.variants?.nodes?.[0]?.price || "0";
  const [basePrice, setBasePrice] = useState(initialBasePrice);
  
  const [useAsAttributes, setUseAsAttributes] = useState(savedUseAsAttributes || false);
  const [isParent, setIsParent] = useState(savedIsParent || false);

  // FIXED: Sync React UI checkbox values when the database loader resolves upon refresh
  useEffect(() => {
    setUseAsAttributes(savedUseAsAttributes);
  }, [savedUseAsAttributes]);

  useEffect(() => {
    setIsParent(savedIsParent || false);
  }, [savedIsParent]);

  useEffect(() => {
    const warmUpSession = async () => {
      try {
        const token = await window.shopify.idToken();
        const currentParams = new URLSearchParams(window.location.search);
        const url = new URL("/app/api/ikarus", window.location.origin);
        currentParams.forEach((value, key) => url.searchParams.set(key, value));
        url.searchParams.set("ping", "1");

        await fetch(url.toString(), {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/json",
          },
          body: (() => { const f = new FormData(); f.append("intent", "ping"); return f; })()
        });
      } catch (e) { }
    };
    warmUpSession();
  }, []);

  const hasMapping = Array.isArray(mapRows) && mapRows.some((r) => r?.viewerMenu && r.viewerMenu.trim() !== "");

  const processMenuOptions = (data) => {
    if (data?.menuOptions) {
      setViewerMenus(data.menuOptions);
      setMapRows((currentRows) => {
        const safeRows = Array.isArray(currentRows) ? currentRows : [];
        const existingMap = {};
        safeRows.forEach((r) => { if (r?.shopifyOption) existingMap[r.shopifyOption] = r; });
        const safeOptions = Array.isArray(productOptions) ? productOptions : [];
        return safeOptions.map((opt) => {
          if (opt?.name && existingMap[opt.name]) return existingMap[opt.name];
          return { shopifyOption: opt?.name || "", viewerMenu: "", items: [] };
        });
      });
    }
  };

  useEffect(() => {
    if (savedProjectId && !viewerMenus && !isLoadingMenus) {
      doManualFetch({ intent: "load_menus", projectId: savedProjectId }, setIsLoadingMenus, processMenuOptions);
    }
  }, [savedProjectId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const handleLoadMenus = () => {
    if (!projectId) return;
    doManualFetch({ intent: "load_menus", projectId }, setIsLoadingMenus, processMenuOptions, "✅ Viewer menus loaded successfully!");
  };

  const strSimilarity = (a, b) => {
    if (!a || !b) return 0;
    const norm = (s) => s.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
    const na = norm(a), nb = norm(b);
    if (na === nb) return 1;
    const wa = na.split(" "), wb = nb.split(" ");
    const common = wa.filter((w) => wb.includes(w)).length;
    return common / Math.max(wa.length, wb.length);
  };

  const autoMap = () => {
    if (!viewerMenus) return;
    const vNames = Object.keys(viewerMenus);
    const usedV = [];

    const safeOptions = Array.isArray(productOptions) ? productOptions : [];
    const newRows = safeOptions.map((opt) => {
      let best = null, bestScore = 0;

      vNames.forEach((vName) => {
        if (usedV.includes(vName)) return;
        const score = strSimilarity(opt.name, vName);
        if (score > bestScore) {
          bestScore = score;
          best = vName;
        }
      });

      if (best && bestScore >= 0.4) {
        usedV.push(best);

        const shopifyValues = Array.isArray(opt.values) ? opt.values : [];
        const vMenuOpts = Object.keys(viewerMenus[best] || {}).map((label) => ({
          id: viewerMenus[best][label]?.id || null,
          label,
        }));

        const usedVOpts = [];
        const items = shopifyValues.map((sVal) => {
          let bestOpt = null, bestOptScore = -1;

          vMenuOpts.forEach((v) => {
            if (usedVOpts.includes(v.label)) return;
            const score = strSimilarity(sVal, v.label);
            if (score > bestOptScore) {
              bestOptScore = score;
              bestOpt = v;
            }
          });

          if (bestOpt) usedVOpts.push(bestOpt.label);

          const matchingVariant = product?.variants?.nodes?.find((v) =>
            v.selectedOptions?.some((so) => so.name === opt.name && so.value === sVal)
          );

          return {
            shopifyValue: sVal,
            shopifyPrice: matchingVariant?.price || "0",
            price: "0",
            viewerOption: bestOpt,
          };
        });

        vMenuOpts.forEach((v) => {
          if (!usedVOpts.includes(v.label)) {
            items.push({
              shopifyValue: "",
              shopifyPrice: "0",
              price: "0",
              viewerOption: v,
            });
          }
        });

        return { shopifyOption: opt.name, viewerMenu: best, items };
      }

      return { shopifyOption: opt.name, viewerMenu: "", items: [] };
    });

    setMapRows(newRows);
  };

  const updateRow = (index, field, value) => {
    const newRows = [...mapRows];
    if (!newRows[index]) return;

    newRows[index][field] = value;

    if (field === "viewerMenu") {
      const selectedSource = newRows[index].shopifyOption;
      if (!selectedSource || !value) {
        newRows[index].items = [];
        setMapRows(newRows);
        return;
      }

      let shopifyValues = [];
      let sourceData = [];

      if (selectedSource === "Product Variants") {
        sourceData = (product?.variants?.nodes || []).map((v) => ({ value: v.title, price: v.price }));
        shopifyValues = sourceData.map((s) => s.value);
      } else {
        const shopifyOpt = (product?.options || []).find((o) => o.name === selectedSource);
        shopifyValues = shopifyOpt?.values || [];
        sourceData = shopifyValues.map((val) => {
          const matchingVariant = (product?.variants?.nodes || []).find((v) =>
            v.selectedOptions?.some((so) => so.name === selectedSource && so.value === val)
          );
          return { value: val, price: matchingVariant?.price || "0" };
        });
      }

      const vMenuOpts = viewerMenus && viewerMenus[value] ? Object.keys(viewerMenus[value]) : [];
      const items = shopifyValues.map((val, i) => {
        const vOptLabel = vMenuOpts[i];
        const vOpt = vOptLabel
          ? { id: viewerMenus[value][vOptLabel]?.id || null, label: vOptLabel }
          : null;

        return {
          shopifyValue: val,
          shopifyPrice: sourceData[i]?.price || "0",
          price: "0",
          viewerOption: vOpt,
        };
      });

      if (vMenuOpts.length > shopifyValues.length) {
        for (let i = shopifyValues.length; i < vMenuOpts.length; i++) {
          const label = vMenuOpts[i];
          items.push({
            shopifyValue: "",
            shopifyPrice: "0",
            price: "0",
            viewerOption: { id: viewerMenus[value][label]?.id || null, label },
          });
        }
      }

      newRows[index].items = items;
    }

    setMapRows(newRows);
  };

  const updateItemPrice = (rowIndex, itemIndex, price) => {
    const newRows = [...mapRows];
    if (newRows[rowIndex]?.items?.[itemIndex]) {
      newRows[rowIndex].items[itemIndex].price = price;
      setMapRows(newRows);
    }
  };

  const moveViewerOption = (rowIndex, itemIndex, direction) => {
    const newRows = [...mapRows];
    if (!newRows[rowIndex]?.items) return;

    const items = [...newRows[rowIndex].items];
    const targetIndex = direction === "up" ? itemIndex - 1 : itemIndex + 1;

    if (targetIndex < 0 || targetIndex >= items.length) return;

    const temp = items[itemIndex].viewerOption;
    items[itemIndex].viewerOption = items[targetIndex].viewerOption;
    items[targetIndex].viewerOption = temp;

    newRows[rowIndex].items = items;
    setMapRows(newRows);
  };

  return (
    <s-page heading={product?.title || "Product Configuration"}>
      <s-button onClick={() => {
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete('productId');
          return next;
        });
      }}>← Back to Products</s-button>

      {toast && (
        <div style={{
          position: "fixed",
          bottom: "24px",
          right: "24px",
          zIndex: 9999,
          padding: "14px 20px",
          borderRadius: "10px",
          background: toast.type === "success" ? "#008060" : "#d72c0d",
          color: "#fff",
          fontWeight: 600,
          fontSize: "14px",
          boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          maxWidth: "420px",
          animation: "ikarus-toast-in 0.25s ease",
        }}>
          <span style={{ flex: 1 }}>{toast.message}</span>
          <button
            onClick={() => setToast(null)}
            style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: "18px", lineHeight: 1, padding: 0 }}
          >×</button>
        </div>
      )}
      <style>{`@keyframes ikarus-toast-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }`}</style>

      <s-stack direction="block" gap="base">
        <s-section heading="Project Settings">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Ikarus Project ID"
              value={projectId}
              placeholder="your-project-id"
              onInput={(e) => setProjectId(e.target.value)}
            />

            <div style={{ marginBottom: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                <label style={{ fontSize: "12px", fontWeight: "600", color: "#444" }}>
                  Base Product Price
                </label>
                <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
                  {/* Parent Product checkbox */}
                  <label style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    fontSize: "12px",
                    cursor: parentSetBySibling ? "not-allowed" : "pointer",
                    color: "#2c6ecb",
                    fontWeight: "600",
                    opacity: parentSetBySibling ? 0.45 : 1,
                    userSelect: "none",
                  }}>
                    <input
                      type="checkbox"
                      checked={isParent}
                      disabled={parentSetBySibling}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setIsParent(checked);
                        if (checked) setUseAsAttributes(false);
                      }}
                    />
                    Parent Product
                    {parentSetBySibling && (
                      <span style={{ fontSize: "10px", color: "#888", fontWeight: "400" }}>(set by sibling)</span>
                    )}
                  </label>
                  {/* Use as Attribute checkbox */}
                  <label style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    fontSize: "12px",
                    cursor: (isParent || parentSetBySibling) ? "not-allowed" : "pointer",
                    color: "#B83D24",
                    fontWeight: "600",
                    opacity: (isParent || parentSetBySibling) ? 0.45 : 1,
                    userSelect: "none",
                  }}>
                    <input
                      type="checkbox"
                      checked={useAsAttributes}
                      disabled={isParent || parentSetBySibling}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setUseAsAttributes(checked);
                        if (checked) {
                          setBasePrice("0");
                          setIsParent(false);
                        }
                      }}
                    />
                    Use Product as attribute
                  </label>
                </div>
              </div>
              <div style={{
                display: "flex",
                alignItems: "center",
                background: useAsAttributes ? "#f1f2f3" : "#fff",
                border: "1px solid #c9cccf",
                borderRadius: "8px",
                height: "38px",
                padding: "0 12px",
                opacity: useAsAttributes ? 0.7 : 1
              }}>
                <span style={{ fontSize: "14px", color: useAsAttributes ? "#999" : "#666", marginRight: "8px", fontWeight: "600" }}>$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={basePrice}
                  disabled={useAsAttributes}
                  onChange={(e) => setBasePrice(e.target.value)}
                  style={{
                    width: "100%",
                    border: "none",
                    outline: "none",
                    fontSize: "14px",
                    padding: "0",
                    background: "transparent",
                    color: useAsAttributes ? "#999" : "inherit"
                  }}
                />
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "600px" }}>

              {/* STEP 1: LOAD */}
              <div style={{
                padding: "16px",
                border: "1px solid #e1e3e5",
                borderRadius: "8px",
                background: "#fff",
                opacity: hasMapping ? 0.5 : 1,
                transition: "opacity 0.3s ease"
              }}>
                <h3 style={{ margin: "0 0 8px 0", fontSize: "16px", display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ background: hasMapping ? "#8c9196" : "#2c6ecb", color: "#fff", borderRadius: "50%", width: "24px", height: "24px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "14px" }}>1</span>
                  Load Menus
                </h3>
                <p style={{ margin: "0 0 12px 0", color: "#6d7175", fontSize: "14px" }}>
                  Fetch the latest viewer menus required to begin mapping.
                </p>
                <s-button onClick={handleLoadMenus} disabled={hasMapping || isLoadingMenus} {...(isLoadingMenus ? { loading: true } : {})}>
                  {isLoadingMenus ? "Loading..." : "Load Viewer Menus"}
                </s-button>
              </div>

            </div>
          </s-stack>
        </s-section>

        {/* STEP 2: ATTRIBUTE MAPPER */}
        <div style={{
          opacity: !viewerMenus ? 0.5 : 1,
          pointerEvents: !viewerMenus ? "none" : "auto",
          transition: "opacity 0.3s ease"
        }}>
          <s-section heading="">
            <div style={{
              padding: "20px",
              border: "1px solid #e1e3e5",
              borderRadius: "8px",
              background: "#fff"
            }}>
              <h3 style={{ margin: "0 0 12px 0", fontSize: "18px", display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{ background: !viewerMenus ? "#8c9196" : "#2c6ecb", color: "#fff", borderRadius: "50%", width: "26px", height: "26px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "14px" }}>2</span>
                Attribute Mapper
              </h3>
              <p style={{ margin: "0 0 20px 0", color: "#6d7175", fontSize: "14px" }}>
                Automatically match loaded menus to attributes, or map them manually. Set add-on prices, or link this product to a specific viewer option.
              </p>

              <div style={{ display: "flex", gap: "16px", alignItems: "center", marginBottom: "24px", padding: "16px", background: "#f9fafb", borderRadius: "8px", border: "1px solid #e1e3e5" }}>
                <s-button onClick={autoMap} disabled={hasMapping || !viewerMenus}>
                  Auto Map Attributes
                </s-button>
                <span style={{ color: "#d72c0d", fontSize: "13px", fontWeight: "500" }}>* Please review and save your changes before proceeding to Step 3.</span>
              </div>

              <s-stack direction="block" gap="loose">
            {(mapRows || []).map((row, rowIndex) => (
              <s-card key={rowIndex}>
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="base">
                    <div style={{ flex: 1 }}>
                      <label style={{ display: "block", fontSize: "12px", marginBottom: "6px", fontWeight: "600", color: "#444" }}>
                        Shopify Option
                      </label>
                      <div style={{ width: "100%", height: "38px", padding: "0 12px", border: "1px solid #c9cccf", borderRadius: "8px", background: "#f6f6f7", fontSize: "14px", display: "flex", alignItems: "center", color: "#5c5f62", boxSizing: "border-box" }}>
                        {row?.shopifyOption || ""}
                      </div>
                    </div>

                    <div style={{ flex: 1 }}>
                      <label style={{ display: "block", fontSize: "12px", marginBottom: "6px", fontWeight: "600", color: "#444" }}>
                        Viewer Menu
                      </label>
                      <select
                        value={row?.viewerMenu || ""}
                        onChange={(e) => updateRow(rowIndex, "viewerMenu", e.target.value)}
                        disabled={!viewerMenus}
                        style={{ width: "100%", height: "38px", padding: "0 12px", border: "1px solid #c9cccf", borderRadius: "8px", background: "#fff", fontSize: "14px", cursor: viewerMenus ? "pointer" : "not-allowed", boxSizing: "border-box", appearance: "auto" }}
                      >
                        <option value="">— Select Menu —</option>
                        {!viewerMenus && row?.viewerMenu && (
                          <option value={row.viewerMenu}>{row.viewerMenu}</option>
                        )}
                        {viewerMenus &&
                          Object.keys(viewerMenus).map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                      </select>
                    </div>
                  </s-stack>

                  {row?.items?.length > 0 && (
                    <div style={{ display: "flex", gap: "16px", border: "1px solid #ddd", borderRadius: "4px", padding: "12px", background: "#fcfcfc" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: "11px", fontWeight: "700", color: "#888", textTransform: "uppercase", marginBottom: "8px", borderBottom: "1px solid #eee", paddingBottom: "4px" }}>
                          Shopify Values
                        </div>

                        <s-stack direction="block" gap="none">
                          {row.items.map((item, itemIndex) => {
                            return (
                              <div key={itemIndex} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px", minHeight: "44px", marginBottom: "4px" }}>
                                <div style={{ width: "14px" }}></div>

                                <div style={{ flex: 1, fontSize: "13px", padding: "6px 12px", border: "1px solid #c9cccf", borderRadius: "8px", background: "#f6f6f7", color: "#5c5f62", minHeight: "38px", display: "flex", alignItems: "center" }}>
                                  <span>{item?.shopifyValue || <em style={{ color: "#ccc" }}>(extra)</em>}</span>
                                </div>

                                <div style={{ display: "flex", alignItems: "center", gap: "6px", background: "#fff", padding: "4px 8px", border: "1px solid #c9cccf", borderRadius: "8px", height: "38px", boxSizing: "border-box" }}>
                                  <span style={{ fontSize: "13px", color: "#666", fontWeight: "600" }}>$</span>
                                  <input
                                    type="number"
                                    value={item?.price || 0}
                                    step="0.01"
                                    min="0"
                                    onChange={(e) => updateItemPrice(rowIndex, itemIndex, e.target.value)}
                                    style={{ width: "80px", border: "none", padding: "0", fontSize: "13px", fontWeight: "600", outline: "none", textAlign: "left" }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </s-stack>
                      </div>

                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: "11px", fontWeight: "700", color: "#888", textTransform: "uppercase", marginBottom: "8px", borderBottom: "1px solid #eee", paddingBottom: "4px" }}>
                          Viewer Options
                        </div>

                        <s-stack direction="block" gap="none">
                          {row.items.map((item, itemIndex) => {
                            const vPrice =
                              (row.viewerMenu &&
                                item?.viewerOption?.label &&
                                viewerMenus?.[row.viewerMenu]?.[item.viewerOption.label]?.price) ?? null;

                            return (
                              <div
                                key={itemIndex}
                                draggable
                                onDragStart={(e) => {
                                  e.dataTransfer.setData("text/plain", `${rowIndex},${itemIndex}`);
                                  e.currentTarget.style.opacity = "0.4";
                                }}
                                onDragEnd={(e) => {
                                  e.currentTarget.style.opacity = "1";
                                }}
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  const data = e.dataTransfer.getData("text/plain");
                                  if (!data) return;
                                  const [dragRow, dragItem] = data.split(",").map(Number);
                                  if (dragRow !== rowIndex) return;

                                  const newRows = [...mapRows];
                                  const items = [...newRows[rowIndex].items];
                                  const temp = items[dragItem].viewerOption;
                                  items[dragItem].viewerOption = items[itemIndex].viewerOption;
                                  items[itemIndex].viewerOption = temp;
                                  newRows[rowIndex].items = items;
                                  setMapRows(newRows);
                                }}
                                style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px", border: "1px solid #eee", borderRadius: "4px", background: "#fff", marginBottom: "4px", cursor: "grab", minHeight: "44px" }}
                              >
                                <span style={{ color: "#bbb", fontSize: "14px", cursor: "grab" }}>⠿</span>

                                <div style={{ flex: 1, fontSize: "13px", padding: "6px 12px", border: "1px solid #c9cccf", borderRadius: "8px", background: "#fff", color: item?.viewerOption ? "#333" : "#999", minHeight: "38px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <span>
                                      {item?.viewerOption ? item.viewerOption.label : <em style={{ color: "#ccc" }}>— No Option —</em>}
                                    </span>
                                    {vPrice !== null && (
                                      <span style={{ fontSize: "11px", color: "#008060", fontWeight: "600" }}>
                                        ${vPrice}
                                      </span>
                                    )}
                                  </div>
                                </div>

                                <s-button-group>
                                  <s-button variant="plain" onClick={() => moveViewerOption(rowIndex, itemIndex, "up")} disabled={itemIndex === 0}>
                                    ▲
                                  </s-button>
                                  <s-button variant="plain" onClick={() => moveViewerOption(rowIndex, itemIndex, "down")} disabled={itemIndex === row.items.length - 1}>
                                    ▼
                                  </s-button>
                                </s-button-group>
                              </div>
                            );
                          })}
                        </s-stack>
                      </div>
                    </div>
                  )}
                </s-stack>
              </s-card>
            ))}
          </s-stack>

              <div style={{ marginTop: "24px", paddingTop: "20px", borderTop: "1px solid #e1e3e5" }}>
                <form onSubmit={(e) => {
                  e.preventDefault();
                  doManualFetch({
                    intent: "save_config",
                    projectId,
                    attrMapping: JSON.stringify(mapRows),
                    basePrice,
                    // Explicitly format to string type for backend evaluation compatibility
                    useAsAttributes: useAsAttributes ? "true" : "false",
                    isParent: isParent ? "true" : "false"
                  }, setIsSaving, null, "✅ Configuration saved successfully!");
                }} id="save-config-form">
                  <s-stack direction="inline">
                    <button
                      type="submit"
                      disabled={isSaving}
                      style={{
                        background: isSaving ? "#a4e8d1" : "#008060",
                        color: "#fff",
                        border: "none",
                        padding: "10px 16px",
                        borderRadius: "8px",
                        cursor: isSaving ? "not-allowed" : "pointer",
                        fontWeight: 600,
                        transition: "background 0.2s ease",
                      }}
                    >
                      {isSaving ? "Saving..." : "Save All Changes"}
                    </button>
                  </s-stack>
                </form>
              </div>
            </div>
          </s-section>
        </div>

        {/* STEP 3: SYNC */}
        <div style={{
          opacity: !hasMapping ? 0.5 : 1,
          pointerEvents: !hasMapping ? "none" : "auto",
          transition: "opacity 0.3s ease"
        }}>
          <s-section heading="">
            <div style={{
              padding: "20px",
              border: "1px solid #e1e3e5",
              borderRadius: "8px",
              background: "#fff"
            }}>
              <h3 style={{ margin: "0 0 12px 0", fontSize: "18px", display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{ background: !hasMapping ? "#8c9196" : "#2c6ecb", color: "#fff", borderRadius: "50%", width: "26px", height: "26px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "14px" }}>3</span>
                Sync Variant Prices
              </h3>
              <p style={{ margin: "0 0 16px 0", color: "#6d7175", fontSize: "14px" }}>
                Save and sync the new prices based on your attribute map.
              </p>

              <form onSubmit={(e) => {
                e.preventDefault();
                doManualFetch({
                  intent: "create_variations",
                  attrMapping: JSON.stringify(mapRows),
                  basePrice,
                  projectId,
                  useAsAttributes: useAsAttributes ? "true" : "false",
                  isParent: isParent ? "true" : "false"
                }, setIsCreatingVars, (data) => setVariationSuccessMsg(`✅ Done! Prices synced for ${data.updatedCount} variants based on your attribute map.`));
              }}>
                <button
                  type="submit"
                  disabled={!hasMapping || isCreatingVars}
                  style={{
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "1px solid #c9cccf",
                    background: !hasMapping ? "#f4f6f8" : "#fff",
                    cursor: (!hasMapping || isCreatingVars) ? "not-allowed" : "pointer",
                    fontWeight: 600,
                    color: !hasMapping ? "#8c9196" : "#202223",
                    transition: "all 0.2s ease"
                  }}
                >
                  {isCreatingVars ? "Syncing..." : "Sync Variant Prices"}
                </button>
              </form>

              {/* Success Message */}
              {variationSuccessMsg && (
                <div style={{ marginTop: "16px" }}>
                  <s-banner tone="success" title={variationSuccessMsg} />
                </div>
              )}
            </div>
          </s-section>
        </div>
      </s-stack>
    </s-page>
  );
}