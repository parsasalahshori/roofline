import { createContext, useContext, type AnchorHTMLAttributes, type ComponentType, type ReactNode } from 'react';

export type UiLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };
export type UiLinkComponent = ComponentType<UiLinkProps>;

const UiLinkContext = createContext<UiLinkComponent | null>(null);

/**
 * Tells every UiLink in the tree which component draws a link. The web app passes an adapter
 * around its router's Link (href -> to), so the kit's links navigate without a page load and
 * the kit itself never imports the router.
 */
export function UiLinkProvider({ component, children }: { component: UiLinkComponent; children: ReactNode }) {
  return <UiLinkContext value={component}>{children}</UiLinkContext>;
}

/** A link for use inside the kit: the provided component when there is one, a plain <a> otherwise. */
export function UiLink(props: UiLinkProps) {
  const Component = useContext(UiLinkContext);
  // The component is not created here: it is the one reference the provider was given, so it keeps
  // its identity (and its state) between renders. The rule cannot tell that from a component made inline.
  // eslint-disable-next-line react-hooks/static-components
  return Component ? <Component {...props} /> : <a {...props} />;
}
