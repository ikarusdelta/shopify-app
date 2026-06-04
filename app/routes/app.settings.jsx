import { useState } from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const settings = await prisma.shopSettings.findUnique({
    where: { shop: session.shop },
  });
  return { accessToken: settings?.accessToken || "" };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const accessToken = formData.get("accessToken")?.toString().trim() || "";

  await prisma.shopSettings.upsert({
    where:  { shop: session.shop },
    update: { accessToken },
    create: { shop: session.shop, accessToken },
  });

  return { success: true };
};

export default function SettingsPage() {
  const { accessToken: savedToken } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";
  const [token, setToken] = useState(savedToken);
  const [showToken, setShowToken] = useState(false);

  return (
    <s-page heading="IkarusDelta Settings">
      {actionData?.success && (
        <s-banner tone="success" title="Settings saved." />
      )}
      <s-section heading="Ikarus Access Token">
        <s-paragraph>
          Your Ikarus account access token. One token covers all your products
          on this store — enter it once and it is stored securely on the server.
        </s-paragraph>
        <Form method="post">
          <s-stack direction="block" gap="base">
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <label style={{ fontSize: "13px", fontWeight: "600", color: "#202223" }}>Access Token</label>
              <div style={{ display: "flex", alignItems: "center", position: "relative" }}>
                <input
                  name="accessToken"
                  type={showToken ? "text" : "password"}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="your-ikarus-access-token"
                  style={{
                    flex: 1,
                    padding: "8px 40px 8px 12px",
                    borderRadius: "6px",
                    border: "1px solid #c9cccf",
                    fontSize: "14px",
                    width: "100%",
                    boxSizing: "border-box",
                    height: "36px"
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  style={{
                    position: "absolute",
                    right: "4px",
                    background: "transparent",
                    border: "none",
                    padding: "8px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#637381"
                  }}
                  title={showToken ? "Hide Token" : "Show Token"}
                >
                  {showToken ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                      <circle cx="12" cy="12" r="3"></circle>
                    </svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                      <line x1="1" y1="1" x2="23" y2="23"></line>
                    </svg>
                  )}
                </button>
              </div>
            </div>
            <s-stack direction="inline">
              <s-button
                variant="primary"
                type="submit"
                {...(isSaving ? { loading: true } : {})}
              >
                Save
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}
