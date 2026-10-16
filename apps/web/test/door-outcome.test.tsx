import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { doors } from '../src/copy/doors.ts';
import { DoorOutcome } from '../src/features/storm/routes/DoorOutcome.tsx';
import { useRoute } from '../src/features/storm/routes/api.ts';
import type { DoorOutcomeKey, DoorStop, RouteDetailView } from '../src/features/storm/routes/types.ts';
import { renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const ROUTE = {
  id: 'r1',
  companyStormId: 'cs1',
  stormId: 'st1',
  userId: 'u1',
  name: 'Omaha · Route 1',
  status: 'in_progress' as const,
  stops: 2,
  doneStops: 0,
};
const POST = 'POST /api/routes/r1/stops/s1/outcome';

function stop(position: number, overrides: Partial<DoorStop> = {}): DoorStop {
  return {
    id: `s${position}`,
    position,
    address: addressOf(position),
    lat: 41.2565,
    lng: -95.9345,
    hailIn: 1.75,
    outcome: null,
    routeId: 'r1',
    footprintId: null,
    propertyId: null,
    outcomeAt: null,
    outcomeBy: null,
    createdCustomerId: null,
    createdJobId: null,
    ...overrides,
  };
}

const addressOf = (position: number): string => `${100 + position} Elm St`;

const FIRST = stop(1);

describe('simple outcomes', () => {
  it.each(['not_home', 'not_interested', 'has_roofer', 'do_not_knock'] as const)(
    'posts %s and nothing else',
    async (outcome: DoorOutcomeKey) => {
      api = stubApi({
        [POST]: () => ({ body: { stop: stop(1, { outcome }) } }),
      });
      const { user } = renderAt(<DoorOutcome routeId="r1" stop={FIRST} />);

      await user.click(screen.getByRole('button', { name: doors.outcomes[outcome] }));

      await waitFor(() => expect(api.count(POST)).toBe(1));
      expect(api.sent(POST)).toEqual([{ outcome }]);
      expect(api.calls).toHaveLength(1);
    },
  );
});

describe('the five outcome buttons', () => {
  it('draws a lead in the company colour and the other four plain', () => {
    api = stubApi({});
    renderAt(<DoorOutcome routeId="r1" stop={FIRST} />);

    const variant = (outcome: DoorOutcomeKey) => screen.getByRole('button', { name: doors.outcomes[outcome] }).getAttribute('data-variant');
    expect(variant('wants_check')).toBe('primary');
    for (const outcome of ['not_home', 'not_interested', 'has_roofer', 'do_not_knock'] as const) expect(variant(outcome)).toBe('default');
  });

  it('shows five 48px buttons in the order of the outcomes', () => {
    api = stubApi({});
    renderAt(<DoorOutcome routeId="r1" stop={FIRST} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      doors.outcomes.not_home,
      doors.outcomes.wants_check,
      doors.outcomes.not_interested,
      doors.outcomes.has_roofer,
      doors.outcomes.do_not_knock,
    ]);
    expect(screen.getByRole('heading', { name: doors.outcomeHeading })).toBeInTheDocument();

    const css = readFileSync(join(import.meta.dirname, '../src/features/storm/routes/DoorOutcome.module.css'), 'utf8');
    expect(css).toContain('min-height: 48px');
  });
});

describe('wants a check', () => {
  const WANTS = { outcome: 'wants_check' };
  const wantsKey = `${POST}`;

  function openSheet(user: ReturnType<typeof renderAt>['user']) {
    return user.click(screen.getByRole('button', { name: doors.outcomes.wants_check }));
  }

  it('opens the sheet with the checkbox unchecked, and validates empty input without posting', async () => {
    api = stubApi({});
    const { user } = renderAt(<DoorOutcome routeId="r1" stop={FIRST} />);
    await openSheet(user);

    const dialog = await screen.findByRole('dialog', { name: doors.sheetTitle });
    expect(within(dialog).getByLabelText(doors.leadName)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(doors.leadPhone)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(doors.leadEmail)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(doors.leadNote)).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: doors.leadOkToText })).not.toBeChecked();

    await user.click(within(dialog).getByRole('button', { name: doors.leadSave }));

    expect(within(dialog).getByText(doors.nameRequired)).toBeInTheDocument();
    expect(within(dialog).getByText(doors.contactRequired)).toBeInTheDocument();
    expect(api.count(wantsKey)).toBe(0);
  });

  it('posts a lead with the phone in E.164 form and okToText false by default', async () => {
    api = stubApi({
      [POST]: () => ({ body: { stop: stop(1, { outcome: 'wants_check' }) } }),
    });
    const { user } = renderAt(<DoorOutcome routeId="r1" stop={FIRST} />);
    await openSheet(user);
    const dialog = await screen.findByRole('dialog', { name: doors.sheetTitle });

    await user.type(within(dialog).getByLabelText(doors.leadName), 'Pat Lee');
    await user.type(within(dialog).getByLabelText(doors.leadPhone), '402-555-0114');
    await user.click(within(dialog).getByRole('button', { name: doors.leadSave }));

    await waitFor(() => expect(api.count(POST)).toBe(1));
    expect(api.sent(POST)).toEqual([{ ...WANTS, lead: { name: 'Pat Lee', phoneE164: '+14025550114', okToText: false } }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('sends okToText true when the box is ticked', async () => {
    api = stubApi({
      [POST]: () => ({ body: { stop: stop(1, { outcome: 'wants_check' }) } }),
    });
    const { user } = renderAt(<DoorOutcome routeId="r1" stop={FIRST} />);
    await openSheet(user);
    const dialog = await screen.findByRole('dialog', { name: doors.sheetTitle });

    await user.type(within(dialog).getByLabelText(doors.leadName), 'Pat Lee');
    await user.type(within(dialog).getByLabelText(doors.leadEmail), 'pat@example.com');
    await user.click(within(dialog).getByRole('checkbox', { name: doors.leadOkToText }));
    await user.click(within(dialog).getByRole('button', { name: doors.leadSave }));

    await waitFor(() => expect(api.count(POST)).toBe(1));
    expect(api.sent(POST)).toEqual([{ ...WANTS, lead: { name: 'Pat Lee', email: 'pat@example.com', okToText: true } }]);
  });

  it('shows the phone error for a short number and posts nothing', async () => {
    api = stubApi({});
    const { user } = renderAt(<DoorOutcome routeId="r1" stop={FIRST} />);
    await openSheet(user);
    const dialog = await screen.findByRole('dialog', { name: doors.sheetTitle });

    await user.type(within(dialog).getByLabelText(doors.leadName), 'Pat Lee');
    await user.type(within(dialog).getByLabelText(doors.leadPhone), '12345');
    await user.click(within(dialog).getByRole('button', { name: doors.leadSave }));

    expect(within(dialog).getByText(doors.phoneInvalid)).toBeInTheDocument();
    expect(api.count(wantsKey)).toBe(0);
  });

  it('shows the email error for a bad address and posts nothing', async () => {
    api = stubApi({});
    const { user } = renderAt(<DoorOutcome routeId="r1" stop={FIRST} />);
    await openSheet(user);
    const dialog = await screen.findByRole('dialog', { name: doors.sheetTitle });

    await user.type(within(dialog).getByLabelText(doors.leadName), 'Pat Lee');
    await user.type(within(dialog).getByLabelText(doors.leadEmail), 'x');
    await user.click(within(dialog).getByRole('button', { name: doors.leadSave }));

    expect(within(dialog).getByText(doors.emailInvalid)).toBeInTheDocument();
    expect(api.count(wantsKey)).toBe(0);
  });
});

describe('network failure', () => {
  it('shows Not saved in an alert and enables the buttons so the tap can be repeated', async () => {
    api = stubApi({});
    const stubbed = globalThis.fetch;
    const failing = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST' ? Promise.reject(new TypeError('Failed to fetch')) : stubbed(input, init),
    );
    vi.stubGlobal('fetch', failing);
    const { user } = renderAt(<DoorOutcome routeId="r1" stop={FIRST} />);

    await user.click(screen.getByRole('button', { name: doors.outcomes.not_home }));

    const panel = screen.getByRole('region', { name: doors.outcomeHeading });
    expect(await within(panel).findByRole('alert')).toHaveTextContent(doors.notSaved);
    for (const key of ['not_home', 'wants_check', 'not_interested', 'has_roofer', 'do_not_knock'] as const) {
      expect(screen.getByRole('button', { name: doors.outcomes[key] })).toBeEnabled();
    }

    await user.click(screen.getByRole('button', { name: doors.outcomes.not_home }));
    await waitFor(() => expect(failing.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2));
  });
});

describe('moving on after a save', () => {
  function CurrentDoor({ routeId }: { routeId: string }) {
    const query = useRoute(routeId);
    if (!query.data) return null;
    const current = query.data.stops.find((s) => s.outcome === null);
    if (!current) return <p>done</p>;
    return (
      <div>
        <p data-testid="address">{current.address}</p>
        <DoorOutcome routeId={routeId} stop={current} />
      </div>
    );
  }

  it('shows the next stop once the outcome is saved', async () => {
    let answered = false;
    const route = (stops: DoorStop[]): RouteDetailView => ({ route: ROUTE, stops });
    api = stubApi({
      'GET /api/routes/r1': () => ({
        body: answered
          ? route([stop(1, { outcome: 'not_home' }), stop(2)])
          : route([stop(1), stop(2)]),
      }),
      [POST]: () => {
        answered = true;
        return { body: { stop: stop(1, { outcome: 'not_home' }) } };
      },
    });
    const { user } = renderAt(<CurrentDoor routeId="r1" />, '/storm/routes/r1');

    expect(await screen.findByTestId('address')).toHaveTextContent(addressOf(1));
    await user.click(screen.getByRole('button', { name: doors.outcomes.not_home }));

    await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent(addressOf(2)));
    expect(api.sent(POST)).toEqual([{ outcome: 'not_home' }]);
  });
});

describe('save errors in the sheet', () => {
  async function fillAndSave(user: ReturnType<typeof renderAt>['user']) {
    await user.click(screen.getByRole('button', { name: doors.outcomes.wants_check }));
    const dialog = await screen.findByRole('dialog', { name: doors.sheetTitle });
    await user.type(within(dialog).getByLabelText(doors.leadName), 'Pat Lee');
    await user.type(within(dialog).getByLabelText(doors.leadPhone), '402-555-0114');
    await user.click(within(dialog).getByRole('button', { name: doors.leadSave }));
    return dialog;
  }

  it('a 409 duplicate phone shows the API message on the phone field, not try again', async () => {
    api = stubApi({
      [POST]: () => ({
        status: 409,
        body: { error: 'Another customer already has this number.', field: 'lead.phoneE164' },
      }),
    });
    const { user } = renderAt(<DoorOutcome routeId="r1" stop={FIRST} />);

    const dialog = await fillAndSave(user);

    await waitFor(() => expect(api.count(POST)).toBe(1));
    const phone = await within(dialog).findByLabelText(doors.leadPhone);
    await waitFor(() => expect(phone).toHaveAccessibleDescription('Another customer already has this number.'));
    expect(phone).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getAllByRole('alert').map((alert) => alert.textContent)).toEqual([
      'Another customer already has this number.',
    ]);
    expect(screen.queryByText(/try again/i)).toBeNull();
    expect(screen.getByRole('dialog', { name: doors.sheetTitle })).toBeInTheDocument();
  });

  it('a network failure in the sheet shows Not saved', async () => {
    api = stubApi({});
    const stubbed = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'POST' ? Promise.reject(new TypeError('Failed to fetch')) : stubbed(input, init),
      ),
    );
    const { user } = renderAt(<DoorOutcome routeId="r1" stop={FIRST} />);

    const dialog = await fillAndSave(user);

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(doors.notSaved);
    expect(screen.getByText(doors.notSaved)).toBeInTheDocument();
  });

  it('a non-phone API error in the sheet shows its own message, not try again', async () => {
    api = stubApi({
      [POST]: () => ({ status: 422, body: { error: 'Please enter a valid phone number.' } }),
    });
    const { user } = renderAt(<DoorOutcome routeId="r1" stop={FIRST} />);

    const dialog = await fillAndSave(user);

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Please enter a valid phone number.');
    expect(screen.queryByText(/try again/i)).toBeNull();
  });
});

describe('the lead form', () => {
  it('has no owner name field', async () => {
    api = stubApi({});
    const { user } = renderAt(<DoorOutcome routeId="r1" stop={FIRST} />);
    await user.click(screen.getByRole('button', { name: doors.outcomes.wants_check }));
    const dialog = await screen.findByRole('dialog', { name: doors.sheetTitle });

    expect(within(dialog).queryByLabelText(/owner/i)).toBeNull();
    expect(screen.queryByText(/owner/i)).toBeNull();
  });
});
