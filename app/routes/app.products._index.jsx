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
  let parentSetBySiblingLive = false;
  if (currentProjectId) {
    const siblingParent = await prisma.productConfig.findFirst({
      where: {
        shop: session.shop,
        projectId: currentProjectId,
        productId: { not: productId },
        isParent: true,
      },
    });
    parentSetBySiblingLive = !!siblingParent;
  }

  // v2 model: role is explicit (parent OR child), no auto-defaulting. Most products
  // in a project are children (one per menu); exactly one is the parent.
  const savedIsParent = config?.isParent === true;
  const savedIsChild = config?.isChild === true;

  return {
    type: "detail",
    shop: session.shop,
    product,
    productId,
    productOptions,
    projectId: config?.projectId || "",
    attrMapping: parsedMapping,
    isParent: savedIsParent,
    isChild: savedIsChild,
    parentSetBySiblingLive,
    accessToken: settings?.accessToken || "",
    lambdaUrl: process.env.LAMBDA_URL || DEFAULT_LAMBDA_URL,
  };
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
  const { product, projectId: savedProjectId, attrMapping: savedMapping, productOptions, isParent: savedIsParent, isChild: savedIsChild, parentSetBySiblingLive } = useLoaderData();
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

  // Initialized to "0"; restored from Lambda config (shopifyBasePrice) once load_menus completes.
  // Using the first variant's current price here would cause doubled prices on re-sync.
  const [basePrice, setBasePrice] = useState("0");
  
  // Role: parent XOR child — manual, mutually exclusive.
  const [isParent, setIsParent] = useState(savedIsParent || false);
  const [isChild, setIsChild] = useState(savedIsChild || false);
  const [parentSetBySiblingLiveLive, setParentSetBySiblingLive] = useState(parentSetBySiblingLive);

  // Sync checkbox state when the loader resolves (e.g. refresh).
  useEffect(() => { setIsParent(savedIsParent || false); }, [savedIsParent]);
  useEffect(() => { setIsChild(savedIsChild || false); }, [savedIsChild]);

  // Ticking one role clears the other; ticking the already-checked one clears it (→ neither).
  const selectParent = () => setIsParent((v) => { const nv = !v; if (nv) setIsChild(false); return nv; });
  const selectChild = () => setIsChild((v) => { const nv = !v; if (nv) setIsParent(false); return nv; });

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
  // Parent has no mapping but still needs to sync (sets its base variant price + parent id).
  const canSync = hasMapping || isParent;

  const processMenuOptions = (data) => {
    if (data?.siblingIsParent) setParentSetBySiblingLive(true);
    // Restore the saved project base price for display (only the parent sends it back).
    if (data?.shopifyBasePrice != null) setBasePrice(String(data.shopifyBasePrice));
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
      doManualFetch({ intent: "load_menus", projectId: savedProjectId, productId: product?.id || "" }, setIsLoadingMenus, processMenuOptions);
    }
  }, [savedProjectId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const handleLoadMenus = () => {
    if (!projectId) return;
    doManualFetch({ intent: "load_menus", projectId, productId: product?.id || "" }, setIsLoadingMenus, processMenuOptions, "✅ Viewer menus loaded successfully!");
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
        const bestMenu = viewerMenus[best] || {};
        const menuId   = bestMenu.__id || null;

        const shopifyValues = Array.isArray(opt.values) ? opt.values : [];
        // Filter out __id / __type meta keys added by Lambda
        const vMenuOpts = Object.keys(bestMenu)
          .filter(k => !k.startsWith('__'))
          .map((label) => ({
            id:     bestMenu[label]?.id     || null,
            slug:   bestMenu[label]?.slug   || null,
            target: bestMenu[label]?.target || null,
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

        return { shopifyOption: opt.name, viewerMenu: best, viewerMenuId: menuId, items };
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
        newRows[index].viewerMenuId = null;
        setMapRows(newRows);
        return;
      }

      // Store the menu UUID alongside the label so server actions can use it
      const selectedMenuData = viewerMenus?.[value] || {};
      newRows[index].viewerMenuId = selectedMenuData.__id || null;

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

      // Filter out Lambda meta keys (__id, __type) before iterating options
      const vMenuOpts = Object.keys(selectedMenuData).filter(k => !k.startsWith('__'));
      const items = shopifyValues.map((val, i) => {
        const vOptLabel = vMenuOpts[i];
        const vOpt = vOptLabel ? {
          id:     selectedMenuData[vOptLabel]?.id     || null,
          slug:   selectedMenuData[vOptLabel]?.slug   || null,
          target: selectedMenuData[vOptLabel]?.target || null,
          label:  vOptLabel,
        } : null;

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
            viewerOption: {
              id:     selectedMenuData[label]?.id     || null,
              slug:   selectedMenuData[label]?.slug   || null,
              target: selectedMenuData[label]?.target || null,
              label,
            },
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
                  {/* Parent product — the base product; no option mapping, carries base price. */}
                  <label style={{
                    display: "flex", alignItems: "center", gap: "6px", fontSize: "12px",
                    cursor: "pointer", color: "#2c6ecb", fontWeight: "600", userSelect: "none",
                  }}>
                    <input type="checkbox" checked={isParent} onChange={selectParent} />
                    Parent Product
                  </label>
                  {/* Child product — one viewer menu; map its variants to options. Base price = 0. */}
                  <label style={{
                    display: "flex", alignItems: "center", gap: "6px", fontSize: "12px",
                    cursor: "pointer", color: "#B83D24", fontWeight: "600", userSelect: "none",
                  }}>
                    <input type="checkbox" checked={isChild} onChange={selectChild} />
                    Child Product
                  </label>
                </div>
              </div>
              {/* Base price — parent only. Disabled for child (child cost = its option variant prices). */}
              <div style={{
                display: "flex",
                alignItems: "center",
                background: isChild ? "#f1f2f3" : "#fff",
                border: "1px solid #c9cccf",
                borderRadius: "8px",
                height: "38px",
                padding: "0 12px",
                opacity: isChild ? 0.7 : 1
              }}>
                <span style={{ fontSize: "14px", color: isChild ? "#999" : "#666", marginRight: "8px", fontWeight: "600" }}>$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={isChild ? "0" : basePrice}
                  disabled={isChild}
                  onChange={(e) => setBasePrice(e.target.value)}
                  placeholder={isChild ? "Set on child variants" : "Base price"}
                  style={{
                    width: "100%",
                    border: "none",
                    outline: "none",
                    fontSize: "14px",
                    padding: "0",
                    background: "transparent",
                    color: isChild ? "#999" : "inherit"
                  }}
                />
              </div>
              {isChild && (
                <span style={{ fontSize: "10px", color: "#888" }}>
                  Base price is disabled for child products — each option&apos;s price is set on its variant below.
                </span>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "600px" }}>

              {/* STEP 1: LOAD — child only (a parent product maps nothing) */}
              {isChild && (
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
              )}

            </div>
          </s-stack>
        </s-section>

        {/* STEP 2: ATTRIBUTE MAPPER (child only) + Save (all roles) */}
        <div style={{
          opacity: (!isParent && !viewerMenus) ? 0.5 : 1,
          pointerEvents: (!isParent && !viewerMenus) ? "none" : "auto",
          transition: "opacity 0.3s ease"
        }}>
          <s-section heading="">
            <div style={{
              padding: "20px",
              border: "1px solid #e1e3e5",
              borderRadius: "8px",
              background: "#fff"
            }}>
              {/* Mapping is only for CHILD products — a parent has no options to map. */}
              {isChild && (<>
              <h3 style={{ margin: "0 0 12px 0", fontSize: "18px", display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{ background: !viewerMenus ? "#8c9196" : "#2c6ecb", color: "#fff", borderRadius: "50%", width: "26px", height: "26px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "14px" }}>2</span>
                Attribute Mapper
              </h3>
              <p style={{ margin: "0 0 20px 0", color: "#6d7175", fontSize: "14px" }}>
                Map this child product&apos;s variants to the viewer menu options and set each option&apos;s price.
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
              </>)}

              <div style={{ marginTop: "24px", paddingTop: "20px", borderTop: "1px solid #e1e3e5" }}>
                <form onSubmit={(e) => {
                  e.preventDefault();
                  doManualFetch({
                    intent: "save_config",
                    projectId,
                    attrMapping: JSON.stringify(mapRows),
                    basePrice,
                    isParent: isParent ? "true" : "false",
                    isChild: isChild ? "true" : "false"
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
          opacity: !canSync ? 0.5 : 1,
          pointerEvents: !canSync ? "none" : "auto",
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
                <span style={{ background: !canSync ? "#8c9196" : "#2c6ecb", color: "#fff", borderRadius: "50%", width: "26px", height: "26px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "14px" }}>3</span>
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
                  isParent: isParent ? "true" : "false",
                  isChild: isChild ? "true" : "false"
                }, setIsCreatingVars, (data) => setVariationSuccessMsg(`✅ Done! Synced prices for ${data.variationCount} variant(s) (${data.role || "product"}).`));
              }}>
                <button
                  type="submit"
                  disabled={!canSync || isCreatingVars}
                  style={{
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "1px solid #c9cccf",
                    background: !canSync ? "#f4f6f8" : "#fff",
                    cursor: (!canSync || isCreatingVars) ? "not-allowed" : "pointer",
                    fontWeight: 600,
                    color: !canSync ? "#8c9196" : "#202223",
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