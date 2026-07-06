import { useEffect, useState } from 'react';
import {
  reactExtension,
  useApi,
  AdminBlock,
  BlockStack,
  InlineStack,
  Divider,
  Badge,
  Checkbox,
  Text,
} from '@shopify/ui-extensions-react/admin';

const TARGET = 'admin.order-details.block.render';

export default reactExtension(TARGET, () => <OrderSummary />);

// Turn a line item's customAttributes ([{key,value}]) into a plain lookup.
function attrsToMap(customAttributes) {
  const map = {};
  (customAttributes || []).forEach((a) => {
    if (a && a.key != null) map[a.key] = a.value;
  });
  return map;
}

function OrderSummary() {
  const { data, query } = useApi(TARGET);
  const [state, setState] = useState({ loading: true, error: '', bundles: [], others: [] });
  const [showAll, setShowAll] = useState(true);

  useEffect(() => {
    const orderId = data?.selected?.[0]?.id;
    if (!orderId) {
      setState({ loading: false, error: '', bundles: [], others: [] });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await query(
          `query OrderSummary($id: ID!) {
            order(id: $id) {
              lineItems(first: 250) {
                nodes {
                  title
                  quantity
                  variantTitle
                  discountedTotalSet { presentmentMoney { amount currencyCode } }
                  customAttributes { key value }
                }
              }
            }
          }`,
          { variables: { id: orderId } },
        );

        const nodes = res?.data?.order?.lineItems?.nodes || [];
        const groups = {}; // _bundle_id -> { id, label, parent, children[] }
        const others = []; // non-bundle line items

        for (const li of nodes) {
          const a = attrsToMap(li.customAttributes);
          const money = li.discountedTotalSet?.presentmentMoney;
          const row = {
            title: li.title,
            option: li.variantTitle || '',
            qty: li.quantity,
            amount: money?.amount != null ? Number(money.amount) : null,
            currency: money?.currencyCode || '',
          };

          const bundleId = a._bundle_id;
          if (!bundleId) {
            others.push(row);
            continue;
          }
          if (!groups[bundleId]) {
            groups[bundleId] = { id: bundleId, label: a._bundle || 'Build', parent: null, children: [] };
          }
          if (a._is_bundle_parent === 'true') groups[bundleId].parent = row;
          else groups[bundleId].children.push(row);
        }

        if (!cancelled) {
          setState({ loading: false, error: '', bundles: Object.values(groups), others });
        }
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: String(e?.message || e), bundles: [], others: [] });
      }
    })();

    return () => { cancelled = true; };
  }, [data, query]);

  const { loading, error, bundles, others } = state;

  if (loading) {
    return <AdminBlock title="IkarusDelta Order Summary"><Text>Loading…</Text></AdminBlock>;
  }
  if (error) {
    return <AdminBlock title="IkarusDelta Order Summary"><Text>Couldn&apos;t load: {error}</Text></AdminBlock>;
  }

  const money = (amount, currency) =>
    amount == null ? '' : `${currency ? currency + ' ' : ''}${amount.toFixed(2)}`;

  const hasBundles = bundles.length > 0;
  const hasOthers = others.length > 0;
  const nothingToShow = !hasBundles && (!showAll || !hasOthers);

  const summaryParts = [];
  if (hasBundles) summaryParts.push(`${bundles.length} bundle${bundles.length === 1 ? '' : 's'}`);
  if (hasOthers) summaryParts.push(`${others.length} other product${others.length === 1 ? '' : 's'}`);
  const collapsedSummary = summaryParts.join(' · ') || 'No products';

  return (
    <AdminBlock title="IkarusDelta Order Summary" collapsedSummary={collapsedSummary}>
      <BlockStack gap="base">
        <Checkbox
          checked={showAll}
          onChange={(value) => setShowAll(value)}
          label="Show all products (off = only configured bundles)"
        />

        <BlockStack gap="base">
            {nothingToShow && (
              <Text>{hasBundles ? '' : 'No configured (3D viewer) products in this order.'}</Text>
            )}

            {/* Configured bundles: parent with children nested */}
            {bundles.map((b, i) => {
              const rows = [b.parent, ...b.children].filter(Boolean);
              const currency = (rows.find((r) => r.currency) || {}).currency || '';
              const total = rows.reduce((sum, r) => sum + (r.amount || 0), 0);

              return (
                <BlockStack key={b.id} gap="base">
                  {i > 0 && <Divider />}
                  <InlineStack gap="base" inlineAlignment="space-between" blockAlignment="center">
                    <InlineStack gap="base" blockAlignment="center">
                      <Badge tone="info">{b.label}</Badge>
                      <Text fontWeight="bold">{b.parent ? b.parent.title : 'Bundle'}</Text>
                    </InlineStack>
                    <Text fontWeight="bold">{money(total, currency)}</Text>
                  </InlineStack>

                  {b.parent && (
                    <InlineStack gap="base" inlineAlignment="space-between">
                      <Text>{b.parent.title} — base</Text>
                      <Text>{money(b.parent.amount, b.parent.currency)}</Text>
                    </InlineStack>
                  )}

                  {b.children.map((c, j) => (
                    <InlineStack key={j} gap="base" inlineAlignment="space-between">
                      <Text>{' ┗ '}{c.title}{c.option ? ` — ${c.option}` : ''}{c.qty > 1 ? ` ×${c.qty}` : ''}</Text>
                      <Text>{money(c.amount, c.currency)}</Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              );
            })}

            {/* Other (non-bundle) products — only when "Show all" is on */}
            {showAll && hasOthers && (
              <BlockStack gap="base">
                {hasBundles && <Divider />}
                <Text fontWeight="bold">Other products</Text>
                {others.map((o, i) => (
                  <InlineStack key={i} gap="base" inlineAlignment="space-between">
                    <Text>{o.title}{o.option ? ` — ${o.option}` : ''}{o.qty > 1 ? ` ×${o.qty}` : ''}</Text>
                    <Text>{money(o.amount, o.currency)}</Text>
                  </InlineStack>
                ))}
              </BlockStack>
            )}
        </BlockStack>
      </BlockStack>
    </AdminBlock>
  );
}
