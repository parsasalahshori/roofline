import { Page } from '@roofline/ui';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { measure } from '../src/copy/measure.ts';
import { measureGutters } from '../src/copy/measureGutters.ts';
import { measureWindows } from '../src/copy/measureWindows.ts';
import { WINDOW_COPY } from '../src/copy/rail.ts';
import { shell } from '../src/copy/shell.ts';
import { MeasureHost, MeasurePage, MeasureSteps } from '../src/features/measure/MeasurePage.tsx';

afterEach(cleanup);

function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{pathname + search}</p>;
}

function renderPage(element: React.ReactNode) {
  const router = createMemoryRouter([{ path: '*', element: (<><Where />{element}</>) }], { initialEntries: ['/start'] });
  render(<RouterProvider router={router} />);
  return router;
}

const LINKS = { roof: '/estimator', windows: '/estimator/windows?property=p1', gutters: '/estimator/measure/m1/gutters' };
const trail = () => within(screen.getByRole('navigation', { name: shell.crumbsLabel }));

describe('MeasurePage: the head every Measure screen shares', () => {
  it('names the page for the street and gives the trail Measure > section > street', () => {
    renderPage(<MeasurePage section="windows" address="305 Ridgeway Dr, Little Rock, AR 72205" links={LINKS}>{'body'}</MeasurePage>);
    expect(screen.getByRole('heading', { level: 1, name: '305 Ridgeway Dr' })).toBeTruthy();
    const crumbs = trail();
    expect(crumbs.getByRole('link', { name: measure.title }).getAttribute('href')).toBe('/estimator');
    expect(crumbs.getByRole('link', { name: measureWindows.switchWindows }).getAttribute('href')).toBe(LINKS.windows);
    expect(crumbs.getByText('305 Ridgeway Dr')).toBeTruthy();
  });

  it('with nothing open the page is Measure, and the trail is just that', () => {
    renderPage(<MeasurePage section="roof" title={measure.title} links={LINKS}>{'body'}</MeasurePage>);
    expect(screen.getByRole('heading', { level: 1, name: measure.title })).toBeTruthy();
    expect(trail().queryByRole('link')).toBeNull();
  });

  it('the factory order starts its trail at Factory orders and has no Roof | Windows | Gutters switch', () => {
    renderPage(<MeasurePage section="order" address="305 Ridgeway Dr, Little Rock, AR" title={measureWindows.switchLabel} titleHidden>{'body'}</MeasurePage>);
    expect(trail().getByRole('link', { name: WINDOW_COPY.orders.title }).getAttribute('href')).toBe('/estimator/windows');
    expect(screen.queryByRole('radiogroup', { name: measureWindows.switchLabel })).toBeNull();
    // The title is read out but not drawn
    expect(screen.getByRole('heading', { level: 1, name: '305 Ridgeway Dr' }).className).toContain('visually-hidden');
  });

  it('has no Roof | Windows | Gutters switch: staff measure roofs only', () => {
    renderPage(<MeasurePage section="roof" address="12 Elm St, Omaha" links={LINKS}>{'body'}</MeasurePage>);
    expect(screen.queryByRole('radiogroup', { name: measureWindows.switchLabel })).toBeNull();
    expect(screen.queryByRole('radio', { name: measureGutters.switchGutters })).toBeNull();
  });


  it('the page and its host render the steps as a tab list that picks one column', () => {
    let picked = 'requests';
    renderPage(
      <Page title="x" crumbsLabel={shell.crumbsLabel}>
        <MeasureHost step="requests" stepsBelow={980}>
          <MeasureSteps
            label="Steps"
            value="requests"
            onChange={(next) => (picked = next)}
            steps={[
              { key: 'requests', label: 'Requests', done: true },
              { key: 'roof', label: 'Roof' },
              { key: 'proposal', label: 'Proposal', disabled: true },
            ]}
          />
        </MeasureHost>
      </Page>,
    );
    const tabs = within(screen.getByRole('tablist', { name: 'Steps' }));
    expect(tabs.getByRole('tab', { name: 'Requests' }).getAttribute('aria-selected')).toBe('true');
    expect((tabs.getByRole('tab', { name: 'Proposal' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(tabs.getByRole('tab', { name: 'Roof' }));
    expect(picked).toBe('roof');
  });
});
