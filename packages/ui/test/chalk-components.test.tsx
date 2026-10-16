import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalCard,
  Chip,
  Icon,
  KpiTile,
  Listbox,
  Panel,
  PrecisionLadder,
  Segmented,
  Size,
  sizeSpeech,
  StageMenu,
  Table,
  Tabs,
  Tag,
  Td,
  Th,
  ToastProvider,
  Tr,
  UiLinkProvider,
  useToast,
  type SizeCopy,
  type UiLinkProps,
} from '../src/index.ts';

describe('Chip', () => {
  it('is a filter: a button whose on state is in aria-pressed, not only in colour', async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Chip pressed={false} onClick={onClick} count={12}>
        Open
      </Chip>,
    );
    const chip = screen.getByRole('button', { name: 'Open 12' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await userEvent.setup().click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Chip pressed onClick={onClick}>
        Open
      </Chip>,
    );
    expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('is a plain button without pressed, and a link with an href', () => {
    const { rerender } = render(<Chip>Plain</Chip>);
    expect(screen.getByRole('button', { name: 'Plain' })).not.toHaveAttribute('aria-pressed');
    rerender(<Chip href="/jobs">Jobs</Chip>);
    expect(screen.getByRole('link', { name: 'Jobs' })).toHaveAttribute('href', '/jobs');
  });

  it('hides its icon from assistive tech', () => {
    render(<Chip icon={<svg data-testid="glyph" />}>Filter</Chip>);
    expect(screen.getByTestId('glyph').closest('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('Tag', () => {
  it('shows its words with a tone, defaulting to neutral', () => {
    const { rerender } = render(<Tag>Inspection</Tag>);
    expect(screen.getByText('Inspection')).toHaveAttribute('data-tone', 'neutral');
    rerender(<Tag tone="ok">Signed</Tag>);
    expect(screen.getByText('Signed')).toHaveAttribute('data-tone', 'ok');
  });

  it('draws a glyph beside the word for a status, hidden from assistive tech', () => {
    const { container } = render(
      <Tag tone="bad" icon="lock">
        Hold
      </Tag>,
    );
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Hold')).toBeInTheDocument();
  });
});

describe('Icon', () => {
  it('is decoration unless it is given a label', () => {
    const { container, rerender } = render(<Icon name="lock" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    rerender(<Icon name="lock" label="Locked" />);
    expect(screen.getByRole('img', { name: 'Locked' })).toBeInTheDocument();
  });
});

describe('Segmented', () => {
  function Harness({ onChange = () => {} }: { onChange?: (value: string) => void }) {
    const [value, setValue] = useState('board');
    return (
      <Segmented
        label="View"
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        options={[
          { value: 'board', label: 'Board' },
          { value: 'list', label: 'List', count: 34 },
          { value: 'map', label: 'Map' },
        ]}
      />
    );
  }

  it('is a radio group where exactly one is checked, and only that one is in the tab order', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'View' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(radios.map((radio) => radio.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('moves the choice with the arrow keys, wrapping, and with Home and End', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    screen.getByRole('radio', { name: 'Board' }).focus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'List 34' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'List 34' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Map' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Home}');
    expect(screen.getByRole('radio', { name: 'Board' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('radio', { name: 'Map' })).toHaveAttribute('aria-checked', 'true');
    expect(onChange.mock.calls.map((call) => call[0])).toEqual(['list', 'board', 'map', 'board', 'map']);
  });

  it('picks a segment by click', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Map' }));
    expect(onChange).toHaveBeenCalledWith('map');
  });
});

describe('Panel', () => {
  it('is a region named by its title, with the tag and the actions in its header', () => {
    render(
      <Panel title="Today" tag="3 visits" actions={<button type="button">Calendar</button>}>
        body
      </Panel>,
    );
    const region = screen.getByRole('region', { name: 'Today' });
    expect(within(region).getByRole('heading', { level: 2, name: 'Today' })).toBeInTheDocument();
    expect(within(region).getByText('3 visits')).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Calendar' })).toBeInTheDocument();
    expect(within(region).getByText('body')).toBeInTheDocument();
  });

  it('can be a level-3 heading and unpadded, and without a title has no header', () => {
    const { container, rerender } = render(
      <Panel title="Inside" headingLevel={3} padded={false}>
        x
      </Panel>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Inside' })).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('data-padded', 'false');
    rerender(<Panel as="div">only body</Panel>);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('only body')).toBeInTheDocument();
  });

  it('does not make a second banner landmark of its header', () => {
    render(
      <Panel title="Panel">
        x
      </Panel>,
    );
    expect(screen.queryByRole('banner')).toBeNull();
  });
});

describe('KpiTile', () => {
  it('is one term and its number, with a unit and a meta line', () => {
    const { container } = render(<KpiTile label="Hail" value="1.50" unit="in" meta="34 customers inside the swath" />);
    expect(container.querySelector('dt')).toHaveTextContent('Hail');
    expect(container.querySelector('dd')).toHaveTextContent('1.50in');
    expect(screen.getByText('34 customers inside the swath')).toBeInTheDocument();
  });

  it('draws weekly bars, the last in the company colour, as decoration unless it is named', () => {
    const { container, rerender } = render(<KpiTile label="Signed" value="$1" spark={[2, 4, 8]} />);
    const bars = container.querySelectorAll('[data-current]');
    expect(bars).toHaveLength(1);
    expect(container.querySelectorAll('span[style]')).toHaveLength(3);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    rerender(<KpiTile label="Signed" value="$1" spark={[2, 4, 8]} sparkLabel="Signed per week, 3 weeks" />);
    expect(screen.getByRole('img', { name: 'Signed per week, 3 weeks' })).toBeInTheDocument();
  });

  it('says it has bars, so the note under the number can leave them room; a tile without bars says nothing', () => {
    const { container, rerender } = render(<KpiTile label="Signed" value="$1" meta="Weekly" spark={[2, 4]} />);
    expect(container.firstElementChild).toHaveAttribute('data-spark', 'true');
    rerender(<KpiTile label="Signed" value="$1" meta="Weekly" spark={[]} />);
    expect(container.firstElementChild).not.toHaveAttribute('data-spark');
    rerender(<KpiTile label="Signed" value="$1" meta="Weekly" />);
    expect(container.firstElementChild).not.toHaveAttribute('data-spark');
  });
});

describe('Table', () => {
  it('right-aligns numeric cells, tints a tone row, and marks the selected one', () => {
    render(
      <Table>
        <thead>
          <tr>
            <Th>Window</Th>
            <Th numeric>Price</Th>
          </tr>
        </thead>
        <tbody>
          <Tr tone="bad">
            <Td>Kitchen</Td>
            <Td numeric>$4,200</Td>
          </Tr>
          <Tr selected>
            <Td>Hall</Td>
            <Td numeric>$900</Td>
          </Tr>
        </tbody>
      </Table>,
    );
    expect(screen.getByRole('columnheader', { name: 'Price' })).toHaveAttribute('data-numeric', 'true');
    expect(screen.getByRole('cell', { name: '$4,200' })).toHaveAttribute('data-numeric', 'true');
    expect(screen.getByRole('row', { name: /Kitchen/ })).toHaveAttribute('data-tone', 'bad');
    expect(screen.getByRole('row', { name: /Hall/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('columnheader', { name: 'Window' })).toHaveAttribute('scope', 'col');
  });

  it('puts a table that can scroll in a named, focusable region', () => {
    render(
      <Table regionLabel="Orders">
        <tbody>
          <tr>
            <td>x</td>
          </tr>
        </tbody>
      </Table>,
    );
    const region = screen.getByRole('region', { name: 'Orders' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(within(region).getByRole('table')).toBeInTheDocument();
  });
});

describe('Tabs', () => {
  it('is a labelled navigation of links, the current one marked', () => {
    function RouterLink(props: UiLinkProps) {
      return <a {...props} data-provided="yes" />;
    }
    render(
      <UiLinkProvider component={RouterLink}>
        <Tabs
          label="Settings"
          items={[
            { key: 'company', label: 'Company', href: '/settings/company', current: true },
            { key: 'team', label: 'Team', href: '/settings/team', count: 4 },
          ]}
        />
      </UiLinkProvider>,
    );
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(nav).getByRole('link', { name: 'Company' })).toHaveAttribute('aria-current', 'page');
    const team = within(nav).getByRole('link', { name: 'Team 4' });
    expect(team).not.toHaveAttribute('aria-current');
    expect(team).toHaveAttribute('href', '/settings/team');
    expect(team).toHaveAttribute('data-provided', 'yes');
  });
});

describe('Listbox', () => {
  const OPTIONS = [
    { value: 'any', label: 'Anyone' },
    { value: 'dana', label: 'Dana Whitfield' },
    { value: 'sam', label: 'Sam Roofer' },
    { value: 'off', label: 'Out sick', disabled: true },
  ];

  function Harness({ onChange = () => {}, variant }: { onChange?: (value: string) => void; variant?: 'field' | 'chip' }) {
    const [value, setValue] = useState('any');
    return (
      <>
        <button type="button">before</button>
        <Listbox
          label="Assigned to"
          value={value}
          variant={variant}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
          options={OPTIONS}
        />
        <button type="button">after</button>
      </>
    );
  }

  it('shows the current choice on a button that opens a listbox', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: /Assigned to/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByLabelText('Assigned to')).toBe(trigger);
    expect(trigger).toHaveTextContent('Anyone');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('listbox', { name: 'Assigned to' });
    const options = within(list).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Anyone', 'Dana Whitfield', 'Sam Roofer', 'Out sick']);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[3]).toHaveAttribute('aria-disabled', 'true');
    // The list takes focus and points at the highlighted option
    expect(list).toHaveFocus();
    expect(list).toHaveAttribute('aria-activedescendant', options[0]!.id);
  });

  it('moves with the arrows, picks with Enter and gives focus back to the trigger', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: /Assigned to/ });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('sam');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveTextContent('Sam Roofer');
  });

  it('skips a disabled option, jumps by a typed letter, and wraps', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /Assigned to/ }));
    const list = screen.getByRole('listbox');
    await user.keyboard('s');
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'Sam Roofer' }).id);
    // Down from the last enabled option wraps past the disabled one to the first
    await user.keyboard('{ArrowDown}');
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'Anyone' }).id);
    await user.keyboard('{End}');
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'Sam Roofer' }).id);
    await user.keyboard('{Home}');
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'Anyone' }).id);
  });

  it('closes on Esc, on Tab and on a press outside, changing nothing', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: /Assigned to/ });

    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('listbox')).toBeNull();

    await user.click(trigger);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'before' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('picks by click, ignores a disabled option and marks the picked one', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Assigned to/ }));
    await user.click(screen.getByRole('option', { name: 'Out sick' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Dana Whitfield' }));
    expect(onChange).toHaveBeenCalledWith('dana');
    await user.click(screen.getByRole('button', { name: /Assigned to/ }));
    expect(screen.getByRole('option', { name: 'Dana Whitfield' })).toHaveAttribute('aria-selected', 'true');
  });

  it('is a chip in a filter bar: the name and the value in the button, no label above', () => {
    render(<Harness variant="chip" />);
    const trigger = screen.getByRole('button', { name: 'Assigned to: Anyone' });
    expect(trigger).toHaveAttribute('data-variant', 'chip');
    expect(screen.queryByText('Assigned to', { selector: 'label' })).toBeNull();
  });

  it('is portaled to the body, so a scrolling lane cannot clip it', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <div style={{ overflow: 'hidden' }}>
        <Harness />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: /Assigned to/ }));
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull();
  });
});

describe('StageMenu', () => {
  const STAGES = [
    { key: 'lead', label: 'Lead', color: 'var(--st-lead)' },
    { key: 'inspection', label: 'Inspection' },
    { key: 'proposal', label: 'Proposal' },
    { key: 'won', label: 'Won' },
    { key: 'installed', label: 'Installed' },
    { key: 'paid', label: 'Paid' },
  ];
  const EXTRAS = [
    { key: 'lost', label: 'Lost', shortcut: 'L', tone: 'bad' as const },
    { key: 'archive', label: 'Archive', shortcut: 'E' },
  ];

  function open() {
    const onPick = vi.fn();
    render(<StageMenu label="Move to…" heading="Move to stage" stages={STAGES} current="inspection" extras={EXTRAS} onPick={onPick} />);
    return onPick;
  }

  it('is a button named Move to… that opens a listbox of the stages, the current one checked', async () => {
    const user = userEvent.setup();
    open();
    const trigger = screen.getByRole('button', { name: 'Move to…' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    await user.click(trigger);
    const list = screen.getByRole('listbox', { name: 'Move to stage' });
    const options = within(list).getAllByRole('option');
    expect(options.map((option) => option.textContent?.replace(/\d$|[LE]$/, ''))).toEqual([
      'Lead',
      'Inspection',
      'Proposal',
      'Won',
      'Installed',
      'Paid',
      'Lost',
      'Archive',
    ]);
    expect(options.filter((option) => option.getAttribute('aria-selected') === 'true')).toEqual([options[1]]);
    // Opens on the current stage
    expect(list).toHaveAttribute('aria-activedescendant', options[1]!.id);
  });

  it('moves at once on a number key, and on L and E for the extras', async () => {
    const user = userEvent.setup();
    const onPick = open();
    const trigger = screen.getByRole('button', { name: 'Move to…' });
    await user.click(trigger);
    await user.keyboard('4');
    expect(onPick).toHaveBeenLastCalledWith('won');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.keyboard('l');
    expect(onPick).toHaveBeenLastCalledWith('lost');
    await user.click(trigger);
    await user.keyboard('E');
    expect(onPick).toHaveBeenLastCalledWith('archive');
  });

  it('moves with the arrows and Enter, and a click', async () => {
    const user = userEvent.setup();
    const onPick = open();
    await user.click(screen.getByRole('button', { name: 'Move to…' }));
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenLastCalledWith('proposal');
    await user.click(screen.getByRole('button', { name: 'Move to…' }));
    await user.click(screen.getByRole('option', { name: /^Lead/ }));
    expect(onPick).toHaveBeenLastCalledWith('lead');
  });

  it('does nothing when the current stage is picked again, and Esc closes it', async () => {
    const user = userEvent.setup();
    const onPick = open();
    const trigger = screen.getByRole('button', { name: 'Move to…' });
    await user.click(trigger);
    await user.keyboard('2');
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('can write its label on the trigger, for a menu with no quick-move button beside it', () => {
    const { rerender } = render(
      <StageMenu label="Move to…" heading="Move to stage" stages={STAGES} current="lead" onPick={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Move to…' })).not.toHaveTextContent('Move to…');
    rerender(<StageMenu label="Move to…" heading="Move to stage" stages={STAGES} current="lead" showLabel onPick={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Move to…' });
    expect(trigger).toHaveTextContent('Move to…');
    expect(trigger).toHaveAttribute('data-labelled', 'true');
  });

  it('writes the destructive choice with its word, and hides the key hints from assistive tech', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: 'Move to…' }));
    const lost = screen.getByRole('option', { name: /^Lost/ });
    expect(lost).toHaveAttribute('data-tone', 'bad');
    expect(within(lost).getByText('L').closest('[aria-hidden="true"]')).not.toBeNull();
  });
});

const COPY: SizeCopy = {
  by: 'by',
  inches: 'inches',
  about: 'about',
  plusMinus: 'plus or minus',
  methods: { lidar: 'LiDAR', sheet: 'Sheet photo', room: 'Room scan', walls: 'From walls' },
};

describe('Size', () => {
  it('speaks one sentence in whole inches and reduced fractions', () => {
    expect(sizeSpeech(COPY, 35.875, 59.5, 0.125, false)).toBe('35 7/8 by 59 1/2 inches, plus or minus 1/8');
    expect(sizeSpeech(COPY, 36, 60, 2, true)).toBe('about 36 by 60 inches, plus or minus 2');
    expect(sizeSpeech(COPY, 36, 60, null, false)).toBe('36 by 60 inches');
  });

  it('reduces 4/8 to 1/2 and never writes a decimal', () => {
    const { container } = render(<Size w={36.5} h={24.25} copy={COPY} />);
    const text = container.textContent ?? '';
    expect(text).toContain('36');
    expect(text).not.toMatch(/\.\d/);
    expect(screen.getByText('36 1/2 by 24 1/4 inches')).toBeInTheDocument();
  });

  it('stacks the eighth: numerator, a slash, denominator', () => {
    const { container } = render(<Size w={35.875} h={59} copy={COPY} />);
    const frac = container.querySelector('[class*="frac"]');
    expect(frac).not.toBeNull();
    expect(frac?.textContent).toBe('7/8');
    expect(frac?.children).toHaveLength(3);
  });

  it('draws the visible marks as decoration and leaves the sentence to a screen reader', () => {
    const { container } = render(<Size w={35.875} h={59} pm={0.125} copy={COPY} />);
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toContain('±1/8');
    expect(screen.getByText('35 7/8 by 59 inches, plus or minus 1/8')).toHaveClass('visually-hidden');
  });

  it('marks an estimate with a tilde and a lighter weight', () => {
    const { container } = render(<Size w={36} h={60} pm={2} estimate copy={COPY} />);
    expect(container.firstElementChild).toHaveAttribute('data-estimate', 'true');
    expect(container.textContent).toContain('~');
    expect(screen.getByText('about 36 by 60 inches, plus or minus 2')).toBeInTheDocument();
  });

  it('shows how it was measured, with its glyph, and takes a scale', () => {
    const { container } = render(<Size w={36} h={60} pm={0.125} method="lidar" scale="card" copy={COPY} />);
    expect(screen.getByText('LiDAR')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('data-scale', 'card');
    expect(container.querySelectorAll('svg').length).toBe(1);
  });

  it('shows no tolerance when none is known', () => {
    const { container } = render(<Size w={36} h={60} copy={COPY} />);
    expect(container.textContent).not.toContain('±');
  });
});

describe('PrecisionLadder', () => {
  const RUNGS = [
    { key: 'estimate', label: 'Estimate', note: '±2 · quote only', count: 1 },
    { key: 'quote', label: 'Quote-grade', note: '±1 in · room scan', count: 2 },
    { key: 'order', label: 'Order-grade', note: '±1/8 · LiDAR or sheet photo', count: 4 },
  ] as const;

  it('lists the three rungs with their count, an "of" total and a bar of the share', () => {
    render(<PrecisionLadder label="Measuring grade" rungs={RUNGS} ofLabel={(total) => `of ${total}`} />);
    const list = screen.getByRole('list', { name: 'Measuring grade' });
    const rungs = within(list).getAllByRole('listitem');
    expect(rungs).toHaveLength(3);
    expect(rungs[2]).toHaveAttribute('data-rung', 'order');
    expect(rungs[2]).toHaveTextContent('Order-grade');
    expect(rungs[2]).toHaveTextContent('4of 7');
    expect(rungs[2]!.querySelector('[style]')).toHaveStyle({ width: '57%' });
    expect(rungs[0]!.querySelector('[style]')).toHaveStyle({ width: '14%' });
  });

  it('fills a rung that has windows and leaves an empty one hollow, and takes its own total', () => {
    render(
      <PrecisionLadder
        label="Grade"
        rungs={[
          { key: 'estimate', label: 'Estimate', note: 'n', count: 0 },
          { key: 'quote', label: 'Quote-grade', note: 'n', count: 0 },
          { key: 'order', label: 'Order-grade', note: 'n', count: 3 },
        ]}
        total={10}
        ofLabel={(total) => `of ${total}`}
      />,
    );
    const rungs = screen.getAllByRole('listitem');
    expect(rungs[0]).not.toHaveAttribute('data-filled');
    expect(rungs[2]).toHaveAttribute('data-filled', 'true');
    expect(rungs[2]).toHaveTextContent('3of 10');
  });

  it('shows empty bars when there is nothing measured yet', () => {
    render(
      <PrecisionLadder
        label="Grade"
        rungs={[
          { key: 'estimate', label: 'Estimate', note: 'n', count: 0 },
          { key: 'quote', label: 'Quote-grade', note: 'n', count: 0 },
          { key: 'order', label: 'Order-grade', note: 'n', count: 0 },
        ]}
        ofLabel={(total) => `of ${total}`}
      />,
    );
    for (const rung of screen.getAllByRole('listitem')) expect(rung.querySelector('[style]')).toHaveStyle({ width: '0%' });
  });

  it('is a stack by default and a strip when asked, with the same rungs either way', () => {
    const rungs = [
      { key: 'estimate', label: 'Estimate', note: 'n', count: 1 },
      { key: 'quote', label: 'Quote-grade', note: 'n', count: 0 },
      { key: 'order', label: 'Order-grade', note: 'n', count: 2 },
    ] as const;
    const { rerender } = render(<PrecisionLadder label="Grade" rungs={rungs} ofLabel={(total) => `of ${total}`} />);
    expect(screen.getByRole('list', { name: 'Grade' })).toHaveAttribute('data-layout', 'stack');
    rerender(<PrecisionLadder label="Grade" rungs={rungs} ofLabel={(total) => `of ${total}`} layout="strip" />);
    const list = screen.getByRole('list', { name: 'Grade' });
    expect(list).toHaveAttribute('data-layout', 'strip');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getAllByRole('listitem')[2]).toHaveTextContent('2of 3');
  });
});

describe('ApprovalCard', () => {
  function card(extra: Partial<Parameters<typeof ApprovalCard>[0]> = {}) {
    const approve = vi.fn();
    const edit = vi.fn();
    const later = vi.fn();
    render(
      <ApprovalCard
        agentIcon="ruler"
        drafted="Estimator drafted · 3 days ago"
        tag="Needs your OK"
        title="Order an exact roof report"
        facts={[
          { label: 'For', value: '4353 Underwood Ave', locked: true },
          { label: 'Cost', value: '$18.00', mono: true },
        ]}
        approve={{ label: 'Approve', onClick: approve, keyHint: '1' }}
        edit={{ label: 'Edit', onClick: edit, keyHint: 'E' }}
        later={{ label: 'Not now', onClick: later, keyHint: 'H' }}
        meta="Expires Sat"
        lockedLabel="Locked"
        {...extra}
      />,
    );
    return { approve, edit, later };
  }

  it('is an article named by its title, with who drafted it and the tag', () => {
    card();
    const article = screen.getByRole('article', { name: 'Order an exact roof report' });
    expect(within(article).getByText('Estimator drafted · 3 days ago')).toBeInTheDocument();
    expect(within(article).getByText('Needs your OK')).toBeInTheDocument();
    expect(within(article).getByText('Expires Sat')).toBeInTheDocument();
  });

  it('lists the facts, the cost in mono and the locked ones with a named lock', () => {
    card();
    const facts = screen.getByRole('article').querySelector('dl');
    expect(facts?.querySelectorAll('dt')).toHaveLength(2);
    expect(screen.getByText('$18.00')).toHaveAttribute('data-mono', 'true');
    expect(screen.getByRole('img', { name: 'Locked' })).toBeInTheDocument();
  });

  it('has Approve, Edit and Not now, each doing its own thing', async () => {
    const { approve, edit, later } = card();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(approve).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveAttribute('data-key', '1');
  });

  it('shows a summary under the title, and a glyph of its own on the main action', () => {
    card({ summary: 'Text the customers under the hail swath.', approve: { label: 'Review 3 steps', href: '/approvals/t1', icon: 'arrow' } });
    const article = screen.getByRole('article', { name: 'Order an exact roof report' });
    expect(within(article).getByText('Text the customers under the hail swath.')).toBeInTheDocument();
    expect(within(article).getByRole('link', { name: 'Review 3 steps' })).toHaveAttribute('href', '/approvals/t1');
    // Without a summary there is no empty line under the title
    expect(article.querySelectorAll('p')).toHaveLength(1);
  });

  it('can link instead of act, leave out Edit and Not now, and show a busy Approve', () => {
    card({ approve: { label: 'Approve', href: '/approvals/t1', busy: true }, edit: undefined, later: undefined, meta: undefined });
    const approve = screen.getByRole('link', { name: 'Approve' });
    expect(approve).toHaveAttribute('href', '/approvals/t1');
    expect(approve).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByText('Expires Sat')).toBeNull();
  });
});

describe('Toast with an action', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function Mover({ onUndo }: { onUndo: () => void }) {
    const toast = useToast();
    return (
      <button type="button" onClick={() => toast.show('Moved to Inspection', 'info', { action: { label: 'Undo', onClick: onUndo } })}>
        move
      </button>
    );
  }

  function renderMover(children: ReactNode) {
    return render(<ToastProvider closeLabel="Dismiss">{children}</ToastProvider>);
  }

  it('shows an Undo button that runs its action and closes the toast', () => {
    const onUndo = vi.fn();
    renderMover(<Mover onUndo={onUndo} />);
    fireEvent.click(screen.getByRole('button', { name: 'move' }));
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Moved to Inspection');
    fireEvent.click(within(status).getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(status).toBeEmptyDOMElement();
  });

  it('still goes away after six seconds, and a repeat keeps one toast with the latest action', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    function Twice() {
      const toast = useToast();
      return (
        <>
          <button type="button" onClick={() => toast.show('Moved', 'info', { action: { label: 'Undo', onClick: first } })}>
            one
          </button>
          <button type="button" onClick={() => toast.show('Moved', 'info', { action: { label: 'Undo', onClick: second } })}>
            two
          </button>
        </>
      );
    }
    renderMover(<Twice />);
    fireEvent.click(screen.getByRole('button', { name: 'one' }));
    fireEvent.click(screen.getByRole('button', { name: 'two' }));
    expect(within(screen.getByRole('status')).getAllByText('Moved')).toHaveLength(1);
    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'one' }));
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});
