import { useEffect, useState } from 'react';
import {
  reactExtension,
  useApi,
  AdminBlock,
  BlockStack,
  InlineStack,
  Divider,
  Badge,
  Text,
} from '@shopify/ui-extensions-react/admin';

const TARGET = 'admin.order-details.block.render';

export default reactExtension(TARGET, () => <OrderBundles />);

// Turn a line item's customAttributes ([{key,value}]) into a plain lookup.
function attrsToMap(customAttributes) {
  const map = {};
  (customAttributes || []).forEach((a) => {
    if (a && a.key != null) map[a.key] = a.value;
  });
  return map;
}

function OrderBundles() {
  const { data, query } = useApi(TARGET);
  const [state, setState] = useState({ loading: true, error: '', bundles: [] });

  useEffect(() => {
    const orderId = data?.selected?.[0]?.id;
    if (!orderId) {
      setState({ loading: false, error: '', bundles: [] });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await query(
          `query OrderBundles($id: ID!) {
            order(id: $id) {
              lineItems(first: 100) {
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

        for (const li of nodes) {
          const a = attrsToMap(li.customAttributes);
          const bundleId = a._bundle_id;
          if (!bundleId) continue; // only IkarusDelta bundle lines

          if (!groups[bundleId]) {
            groups[bundleId] = { id: bundleId, label: a._bundle || 'Build', parent: null, children: [] };
          }
          const money = li.discountedTotalSet?.presentmentMoney;
          const row = {
            title: li.title,
            option: li.variantTitle || '',
            qty: li.quantity,
            amount: money?.amount != null ? Number(money.amount) : null,
            currency: money?.currencyCode || '',
          };
          if (a._is_bundle_parent === 'true') groups[bundleId].parent = row;
          else groups[bundleId].children.push(row);
        }

        if (!cancelled) setState({ loading: false, error: '', bundles: Object.values(groups) });
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: String(e?.message || e), bundles: [] });
      }
    })();

    return () => { cancelled = true; };
  }, [data, query]);

  const { loading, error, bundles } = state;

  if (loading) {
    return (
      <AdminBlock title="IkarusDelta Bundles">
        <Text>Loading…</Text>
      </AdminBlock>
    );
  }
  if (error) {
    return (
      <AdminBlock title="IkarusDelta Bundles">
        <Text>Couldn&apos;t load bundles: {error}</Text>
      </AdminBlock>
    );
  }
  if (bundles.length === 0) {
    return (
      <AdminBlock title="IkarusDelta Bundles">
        <Text>No configured (3D viewer) products in this order.</Text>
      </AdminBlock>
    );
  }

  const money = (amount, currency) =>
    amount == null ? '' : `${currency ? currency + ' ' : ''}${amount.toFixed(2)}`;

  return (
    <AdminBlock title="IkarusDelta Bundles">
      <BlockStack gap="base">
        {bundles.map((b, i) => {
          const rows = [b.parent, ...b.children].filter(Boolean);
          const currency = (rows.find((r) => r.currency) || {}).currency || '';
          const total = rows.reduce((sum, r) => sum + (r.amount || 0), 0);

          return (
            <BlockStack key={b.id} gap="base">
              {i > 0 && <Divider />}

              {/* Bundle header: label + parent name + total */}
              <InlineStack gap="base" inlineAlignment="space-between" blockAlignment="center">
                <InlineStack gap="base" blockAlignment="center">
                  <Badge tone="info">{b.label}</Badge>
                  <Text fontWeight="bold">{b.parent ? b.parent.title : 'Bundle'}</Text>
                </InlineStack>
                <Text fontWeight="bold">{money(total, currency)}</Text>
              </InlineStack>

              {/* Parent (base) row */}
              {b.parent && (
                <InlineStack gap="base" inlineAlignment="space-between">
                  <Text>{b.parent.title} — base</Text>
                  <Text>{money(b.parent.amount, b.parent.currency)}</Text>
                </InlineStack>
              )}

              {/* Child rows, visually nested under the parent */}
              {b.children.map((c, j) => (
                <InlineStack key={j} gap="base" inlineAlignment="space-between">
                  <Text>{' ┗ '}{c.title}{c.option ? ` — ${c.option}` : ''}{c.qty > 1 ? ` ×${c.qty}` : ''}</Text>
                  <Text>{money(c.amount, c.currency)}</Text>
                </InlineStack>
              ))}
            </BlockStack>
          );
        })}
      </BlockStack>
    </AdminBlock>
  );
}
