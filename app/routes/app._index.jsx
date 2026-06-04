import { useEffect } from "react";
import { useFetcher, useSearchParams, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  
  const settings = await prisma.shopSettings.findUnique({
    where: { shop: session.shop },
  });

  // 1. Fetch current product IDs from Shopify to verify existence
  const shopifyRes = await admin.graphql(`
    query {
      products(first: 250) {
        edges {
          node { id }
        }
      }
    }
  `);
  const shopifyData = await shopifyRes.json();
  const activeShopifyIds = (shopifyData.data?.products?.edges || []).map(
    (e) => e.node.id.split("/").pop()
  );

  // 2. Fetch all configs from DB
  const allConfigs = await prisma.productConfig.findMany({
    where: { shop: session.shop },
  });

  // 3. Filter: Product must exist in Shopify AND be fully configured
  const productCount = allConfigs.filter(config => {
    // Check existence
    if (!activeShopifyIds.includes(config.productId)) return false;
    
    // Check configuration
    if (!config.projectId || config.projectId === "") return false;
    try {
      const mapping = JSON.parse(config.attrMapping || "[]");
      return mapping.some(row => 
        row.viewerMenu && 
        row.viewerMenu !== "" && 
        row.items?.some(item => item.shopifyValue && item.shopifyValue !== "")
      );
    } catch (e) {
      return false;
    }
  }).length;

  return { 
    isConfigured: !!settings?.accessToken,
    productCount 
  };
};

export const action = async ({ request }) => {
  return null;
};

export default function Index() {
  const navigate = useNavigate();
  const { isConfigured, productCount } = useLoaderData();
  const shopify = useAppBridge();
  const [searchParams] = useSearchParams();
  const searchStr = searchParams.toString();
  const queryString = searchStr ? `?${searchStr}` : "";

  const viewerCode = `{% assign project_id = product.metafields.ikarus_delta.project_id.value %}
{% if project_id != blank %}
  <div style="width:100%; height:600px;">
    <iframe
      src="https://viewer.ikarus3d.com?projectId={{ project_id }}"
      style="width:100%; height:100%; border:none;"
      allow="fullscreen"
    ></iframe>
  </div>
{% endif %}`;

  const copyCode = () => {
    navigator.clipboard.writeText(viewerCode);
    shopify.toast.show("Code copied to clipboard");
  };

  return (
    <s-page heading="Ikarus Delta Dashboard">
      <style>{`
        @keyframes pulse-green {
          0% { box-shadow: 0 0 0 0 rgba(0, 128, 96, 0.4); }
          70% { box-shadow: 0 0 0 10px rgba(0, 128, 96, 0); }
          100% { box-shadow: 0 0 0 0 rgba(0, 128, 96, 0); }
        }
        .status-pulse {
          animation: pulse-green 2s infinite;
        }
        .hero-section {
          background: linear-gradient(135deg, #f9fafb 0%, #f3f4f6 100%);
          border: 1px solid #e5e7eb;
        }
        .workflow-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 16px;
          padding: 8px 0;
          width: 100%;
          box-sizing: border-box;
        }
        .step-mini-card {
          background: white;
          border: 1px solid #e1e3e5;
          border-radius: 16px;
          padding: 20px;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
          display: flex;
          flex-direction: column;
          height: 100%;
          box-sizing: border-box;
          min-width: 0; /* Critical for grid overflow */
        }
        .step-mini-card:hover {
          border-color: #008060;
          box-shadow: 0 8px 24px rgba(0,0,0,0.08);
          transform: translateY(-2px);
        }
        .step-icon-box {
          width: 44px;
          height: 44px;
          background: #f0f1f3;
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #008060;
          margin-bottom: 16px;
          flex-shrink: 0;
        }
        .path-breadcrumb {
          display: inline-flex;
          flex-wrap: wrap; /* Allow wrapping on small screens */
          align-items: center;
          gap: 4px;
          background: #f4f6f8;
          padding: 4px 10px;
          border-radius: 6px;
          border: 1px solid #e5e7eb;
          margin-top: 12px;
          align-self: flex-start;
          max-width: 100%;
          box-sizing: border-box;
        }
        .path-item {
          font-size: 11px;
          font-weight: 600;
          color: #4b5563;
        }
        .path-divider {
          color: #9ca3af;
          font-size: 10px;
        }
        .code-block-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: #2a2a2a;
          padding: 12px 20px;
          border-top-left-radius: 14px;
          border-top-right-radius: 14px;
          color: #e5e7eb;
          font-size: 12px;
          font-weight: 600;
        }
        .code-block-body {
          background: #111;
          color: #9cdcfe;
          padding: 24px;
          border-bottom-left-radius: 14px;
          border-bottom-right-radius: 14px;
          font-family: 'JetBrains Mono', 'Fira Code', monospace;
          font-size: 13px;
          line-height: 1.7;
          overflow-x: auto;
          border: 1px solid #2a2a2a;
          border-top: none;
        }
        .btn-copy {
          background: #008060;
          color: white;
          border: none;
          padding: 6px 16px;
          border-radius: 8px;
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          transition: transform 0.1s;
        }
        .btn-copy:active {
          transform: scale(0.95);
        }
        .btn-primary {
          background: #008060;
          color: white;
          border: 1px solid #008060;
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        }
        .btn-primary:hover {
          background: #006e52;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .btn-secondary {
          background: white;
          color: #202223;
          border: 1px solid #c9cccf;
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        }
        .btn-secondary:hover {
          background: #f4f6f8;
          border-color: #8c9196;
        }
      `}</style>
      
      <s-button slot="primary-action" variant="primary" onClick={() => navigate(`/app/products${queryString}`)}>
        Manage Products
      </s-button>

      <s-stack direction="block" gap="large">
        
        {/* Hero Section */}
        <s-card className="hero-section">
          <s-box padding="large">
            <s-stack direction="inline" align="center" gap="loose">
              <div style={{ flex: 1 }}>
                <s-stack direction="block" gap="tight">
                  <s-heading size="large">Ikarus Delta</s-heading>
                  <s-paragraph>
                    Connect your product catalog with high-fidelity 3D configurations. 
                    Synchronize pricing, manage viewer attributes, and deploy immersive shopping experiences.
                  </s-paragraph>
                  <div style={{ display: "flex", gap: "12px", marginTop: "8px" }}>
                    <button className="btn-primary" onClick={() => navigate(`/app/products${queryString}`)}>
                      Manage Products
                    </button>
                    <button className="btn-secondary" onClick={() => navigate(`/app/settings${queryString}`)}>
                      Setup API
                    </button>
                  </div>
                </s-stack>
              </div>
              <div style={{ padding: "24px", background: "white", boxShadow: "0 10px 25px rgba(0,0,0,0.04)", borderRadius: "20px" }}>
                <img src="/logo/image.png" alt="Branding" style={{ maxWidth: "160px", height: "auto" }} />
              </div>
            </s-stack>
          </s-box>
        </s-card>

        {/* Status Dashboard */}
        <s-stack direction="inline" gap="base">
          <s-card style={{ flex: 1 }}>
            <s-box padding="base">
              <s-stack direction="inline" gap="base" align="center">
                <div style={{ background: isConfigured ? "#eaf4f0" : "#fff4f4", padding: "14px", borderRadius: "14px", color: isConfigured ? "#008060" : "#D82C0D", display: "flex" }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
                </div>
                <s-stack direction="block" gap="extra-tight" style={{ flex: 1 }}>
                  <s-text color="subdued" size="small" weight="bold">API CONNECTION</s-text>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <s-text weight="bold" size="large">{isConfigured ? "Authenticated" : "Not Linked"}</s-text>
                    {isConfigured && <div className="status-pulse" style={{ width: 10, height: 10, background: "#008060", borderRadius: "50%" }}></div>}
                  </div>
                </s-stack>
              </s-stack>
            </s-box>
          </s-card>
          <s-card style={{ flex: 1 }}>
            <s-box padding="base">
              <s-stack direction="inline" gap="base" align="center">
                <div style={{ background: "#f3f4f6", padding: "14px", borderRadius: "14px", color: "#374151", display: "flex" }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline></svg>
                </div>
                <s-stack direction="block" gap="extra-tight" style={{ flex: 1 }}>
                  <s-text color="subdued" size="small" weight="bold">SYNCED PRODUCTS</s-text>
                  <s-text weight="bold" size="large">{productCount} Active</s-text>
                </s-stack>
                <button 
                  onClick={() => navigate(`/app/products${queryString}`)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#2c6ecb",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    padding: "4px 8px"
                  }}
                >
                  Explore &rarr;
                </button>
              </s-stack>
            </s-box>
          </s-card>
        </s-stack>

        {/* Grid Installation Flow */}
        <s-section heading="Quick Setup Guide">
          <style>{`
            .workflow-grid {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 20px;
              width: 100%;
            }
            .step-sub-list {
              margin: 12px 0 0 0;
              padding: 0;
              list-style: none;
            }
            .step-sub-item {
              display: flex;
              gap: 8px;
              font-size: 12px;
              color: #4b5563;
              margin-bottom: 6px;
              align-items: flex-start;
            }
            .step-dot {
              width: 6px;
              height: 6px;
              background: #1a1a1a;
              border-radius: 50%;
              margin-top: 6px;
              flex-shrink: 0;
            }
          `}</style>
          <div className="workflow-grid">
            {/* Step 1 */}
            <div className="step-mini-card">
              <div className="step-icon-box" style={{ color: "#1a1a1a" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
              </div>
              <s-text weight="bold">1. Set your Access Token</s-text>
              <ul className="step-sub-list">
                <li className="step-sub-item"><div className="step-dot"></div><span>Go to the <strong>Settings</strong> tab</span></li>
                <li className="step-sub-item"><div className="step-dot"></div><span>Enter your Ikarus API Token</span></li>
                <li className="step-sub-item"><div className="step-dot"></div><span>Click <strong>Save</strong> to authenticate</span></li>
              </ul>
              <div className="path-breadcrumb">
                <span className="path-item">App</span>
                <span className="path-divider">/</span>
                <span className="path-item">Settings</span>
              </div>
            </div>

            {/* Step 2 */}
            <div className="step-mini-card">
              <div className="step-icon-box" style={{ color: "#1a1a1a" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m7.5 4.27 9 5.15"></path><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"></path></svg>
              </div>
              <s-text weight="bold">2. Configure your Product</s-text>
              <ul className="step-sub-list">
                <li className="step-sub-item"><div className="step-dot"></div><span>Navigate to the <strong>Products</strong> page</span></li>
                <li className="step-sub-item"><div className="step-dot"></div><span>Enter Project ID &amp; map options</span></li>
                <li className="step-sub-item"><div className="step-dot"></div><span>Click <strong>Sync</strong> to update variants</span></li>
              </ul>
              <div className="path-breadcrumb">
                <span className="path-item">App</span>
                <span className="path-divider">/</span>
                <span className="path-item">Products</span>
              </div>
            </div>

            {/* Step 3 */}
            <div className="step-mini-card">
              <div className="step-icon-box" style={{ color: "#1a1a1a" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M3 9h18"></path></svg>
              </div>
              <s-text weight="bold">3. Add Iframe to Product Page</s-text>
              <ul className="step-sub-list">
                <li className="step-sub-item"><div className="step-dot"></div><span>Open <strong>Theme Editor</strong> (Customize)</span></li>
                <li className="step-sub-item"><div className="step-dot"></div><span>Add <strong>Ikarus Viewer</strong> block</span></li>
                <li className="step-sub-item"><div className="step-dot"></div><span>Drag to your preferred position</span></li>
              </ul>
              <div className="path-breadcrumb">
                <span className="path-item">Editor</span>
                <span className="path-divider">/</span>
                <span className="path-item">Product Info</span>
              </div>
            </div>

            {/* Step 4 */}
            <div className="step-mini-card">
              <div className="step-icon-box" style={{ color: "#1a1a1a" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"></path><path d="M3 6h18"></path></svg>
              </div>
              <s-text weight="bold">4. Enable Ikarus Cart Listener</s-text>
              <ul className="step-sub-list">
                <li className="step-sub-item"><div className="step-dot"></div><span>Go to <strong>App Embeds</strong> in sidebar</span></li>
                <li className="step-sub-item"><div className="step-dot"></div><span>Find <strong>Ikarus Cart Listener</strong></span></li>
                <li className="step-sub-item"><div className="step-dot"></div><span>Toggle to <strong>On</strong> and Save</span></li>
              </ul>
              <div className="path-breadcrumb">
                <span className="path-item">Themes</span>
                <span className="path-divider">/</span>
                <span className="path-item">App Embeds</span>
              </div>
            </div>
          </div>
        </s-section>

        {/* Technical Resources */}
        <s-section heading="Developer & Technical Resources">
          <s-card>
            <s-box padding="base">
              <s-stack direction="block" gap="loose">
                <div>
                  <s-text weight="bold">Theme Snippet Code</s-text>
                  <s-paragraph size="small">Insert this Liquid code block directly into your theme templates for precise 3D Viewer positioning:</s-paragraph>
                  <div style={{ marginTop: "16px" }}>
                    <div className="code-block-header">
                      <span>snippet-viewer.liquid</span>
                      <button className="btn-copy" onClick={copyCode}>Copy Liquid</button>
                    </div>
                    <div className="code-block-body">
                      <pre style={{ margin: 0 }}><code>{viewerCode}</code></pre>
                    </div>
                  </div>
                </div>
                
                <s-divider />
                
                <s-stack direction="inline" gap="base" align="start">
                  <div style={{ color: "#2563eb", display: "flex", alignItems: "center", marginTop: "20px" }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{margin:"0 10px 0  0 "}}><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>
                    <s-text weight="bold">Variant Sync Policy</s-text>
                  </div>
                  <s-stack direction="block" gap="extra-tight">
                    <s-paragraph size="small">Price synchronization is irreversible. We recommend testing on a development product before performing a store-wide sync to avoid unintended pricing updates.</s-paragraph>
                  </s-stack>
                </s-stack>
              </s-stack>
            </s-box>
          </s-card>
        </s-section>

      </s-stack>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
