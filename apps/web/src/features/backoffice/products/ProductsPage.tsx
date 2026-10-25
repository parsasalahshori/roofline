import type { ProductCatalog } from '@roofline/shared';
import { Banner, Button, EmptyState, Icon, Segmented, Skeleton, Tag, useToast } from '@roofline/ui';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client.ts';
import { backoffice as copy } from '../../../copy/backoffice.ts';
import { SaveBar } from '../../settings/SaveBar.tsx';
import { useCatalog, useSaveCatalog } from '../api.ts';
import { BackofficePage } from '../BackofficePage.tsx';
import { AccessoriesSection } from './AccessoriesSection.tsx';
import { emptyProduct, ruleLabel, sectionOf, validateCatalog } from './catalog.ts';
import type { Draft } from './draft.ts';
import { EditContext } from './fields.tsx';
import { OptionsSection } from './OptionsSection.tsx';
import { PriceCheck } from './PriceCheck.tsx';
import { ProductSheet } from './ProductSheet.tsx';
import styles from './products.module.css';
import { RulesSection } from './RulesSection.tsx';

const t = copy.products;
type Section = 'products' | 'options' | 'accessories' | 'rules' | 'check';

/** Products & pricing: the price book. Owner and office edit it and save it in one go; a rep looks. */
export function ProductsPage() {
  return (
    <BackofficePage tab="products" subtitle={copy.descriptions.products}>
      {({ canEdit }) => (
        <EditContext value={canEdit}>
          <Editor canEdit={canEdit} />
        </EditContext>
      )}
    </BackofficePage>
  );
}

function Editor({ canEdit }: { canEdit: boolean }) {
  const catalog = useCatalog();
  const save = useSaveCatalog();
  const toast = useToast();
  const [edited, setEdited] = useState<ProductCatalog | null>(null);
  const [section, setSection] = useState<Section>('products');
  const [openId, setOpenId] = useState<string | null>(null);

  if (catalog.isPending) return <Skeleton lines={4} />;
  if (catalog.isError) return <Banner tone="danger">{copy.loadFailed}</Banner>;

  const current = edited ?? catalog.data;
  const errors = validateCatalog(current);
  const dirty = edited !== null && JSON.stringify(edited) !== JSON.stringify(catalog.data);
  const draft: Draft = { catalog: current, errors, change: (edit) => setEdited((previous) => edit(previous ?? catalog.data)) };
  const countIn = (name: Section) => [...errors.keys()].filter((key) => sectionOf(key) === name).length;
  const saveError = save.error instanceof ApiError ? save.error.message : save.isError ? copy.saveFailed : null;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || errors.size > 0 || !edited) return;
    save.mutate(edited, {
      onSuccess: (saved) => {
        setEdited(null);
        toast.show(t.savedVersion(saved.version), 'success');
      },
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className={styles.page}>
      {canEdit ? null : <Banner tone="info">{t.readOnly}</Banner>}
      <div className={styles.switch}>
        <Segmented<Section>
          label={t.sectionsLabel}
          value={section}
          onChange={setSection}
          options={[
            { value: 'products', label: t.sections.products, count: countIn('products') || undefined },
            { value: 'options', label: t.sections.options, count: countIn('options') || undefined },
            { value: 'accessories', label: t.sections.accessories, count: countIn('accessories') || undefined },
            { value: 'rules', label: t.sections.rules, count: countIn('rules') || undefined },
            { value: 'check', label: t.sections.check },
          ]}
        />
        <span className="bo-foot">{t.version(current.version)}</span>
      </div>

      {section === 'products' ? <ProductList draft={draft} canEdit={canEdit} onOpen={setOpenId} /> : null}
      {section === 'options' ? <OptionsSection draft={draft} /> : null}
      {section === 'accessories' ? <AccessoriesSection draft={draft} /> : null}
      {section === 'rules' ? <RulesSection draft={draft} /> : null}
      {section === 'check' ? <PriceCheck draft={draft} /> : null}

      {saveError ? <Banner tone="danger">{saveError}</Banner> : null}
      {errors.size > 0 && dirty ? <Banner tone="warning">{t.fixFirst(errors.size)}</Banner> : null}
      <ProductSheet draft={draft} productId={openId} onClose={() => setOpenId(null)} />
      <SaveBar dirty={dirty} saving={save.isPending} saveLabel={t.save} saveDisabled={errors.size > 0} onDiscard={() => setEdited(null)} />
    </form>
  );
}

function ProductList({ draft, canEdit, onOpen }: { draft: Draft; canEdit: boolean; onOpen: (id: string) => void }) {
  const products = draft.catalog.products;
  const edit = (id: string, archived: boolean) =>
    draft.change((catalog) => ({ ...catalog, products: catalog.products.map((p) => (p.id === id ? { ...p, archived } : p)) }));
  return (
    <section aria-label={t.productsTitle}>
      {products.length === 0 ? (
        <div className="bo-group">
          <EmptyState title={t.productsEmpty} body={t.productsEmptyBody} />
        </div>
      ) : (
        <ul className="bo-group">
          {products.map((product) => (
            <li key={product.id}>
              <div className="bo-row" data-archived={product.archived || undefined}>
                <span className="bo-row-main">
                  <b>{product.name}</b>
                  <small className="bo-foot">{t.productLine(t.kinds[product.kind], ruleLabel(product), t.openingsCount(product.openings.length))}</small>
                </span>
                {product.archived ? <Tag tone="neutral">{t.archivedTag}</Tag> : null}
                {canEdit ? (
                  <Button variant="ghost" aria-label={product.archived ? t.restoreFor(product.name) : t.archiveFor(product.name)} onClick={() => edit(product.id, !product.archived)}>
                    {product.archived ? t.restore : t.archive}
                  </Button>
                ) : null}
                <Button variant="ghost" aria-label={t.editFor(product.name)} onClick={() => onOpen(product.id)}>
                  {canEdit ? t.edit : t.view}
                  <Icon name="chev" size={16} />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="bo-foot bo-groupfoot">{t.archivedHelp}</p>
      {canEdit ? (
        <div className={styles.addRow}>
          <Button
            variant="ghost"
            onClick={() => {
              const product = emptyProduct();
              draft.change((catalog) => ({ ...catalog, products: [...catalog.products, product] }));
              onOpen(product.id);
            }}
          >
            <Icon name="plus" size={16} />
            {t.addProduct}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
