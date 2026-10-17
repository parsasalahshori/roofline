/**
 * What a visit is, without the customer after it. A visit is titled "Roof inspection: Kevin Hall" and a block on the grid shows the
 * customer on a line of its own, so its first line is only "Roof inspection" and the name is never cut in the middle. A title that
 * does not end with its customer ("Roof inspection for the clubhouse") is left whole.
 */
export function visitKind(title: string, customerName: string | null): string {
  if (customerName === null || customerName === '') return title;
  const suffix = `: ${customerName}`;
  return title.length > suffix.length && title.endsWith(suffix) ? title.slice(0, title.length - suffix.length) : title;
}
