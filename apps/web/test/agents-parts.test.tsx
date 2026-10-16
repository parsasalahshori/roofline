import { cleanup, render, screen, within } from '@testing-library/react';
import type { DayCount } from '@roofline/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { agentsDash } from '../src/copy/agents.ts';
import { AgentGlyph } from '../src/features/agents/AgentGlyph.tsx';
import { agentStatus } from '../src/features/agents/agentStatus.ts';
import { DayBars } from '../src/features/agents/DayBars.tsx';
import { Handoffs, type Handoff } from '../src/features/agents/Handoffs.tsx';

afterEach(cleanup);

const NOW = Date.parse('2026-10-13T06:41:00.000Z');

describe('how an agent\'s state is drawn', () => {
  it('Running is green, Waiting is tape yellow, Paused and Coming soon are plain, each with a glyph and its word', () => {
    expect(agentStatus({ status: 'on', waitingCount: 0 })).toEqual({ word: agentsDash.running, tone: 'ok', icon: 'bolt' });
    expect(agentStatus({ status: 'on', waitingCount: 2 })).toEqual({ word: agentsDash.waiting, tone: 'tape', icon: 'alert' });
    expect(agentStatus({ status: 'waiting', waitingCount: 2 })).toEqual({ word: agentsDash.waiting, tone: 'tape', icon: 'alert' });
    expect(agentStatus({ status: 'paused', waitingCount: 0 })).toEqual({ word: agentsDash.paused, tone: 'neutral', icon: 'minus' });
    expect(agentStatus({ status: 'coming_soon', waitingCount: 0 })).toEqual({ word: agentsDash.comingSoon, tone: 'neutral', icon: 'clock' });
  });

  it('a paused agent with work waiting stays Paused: it is not working, whatever is waiting', () => {
    expect(agentStatus({ status: 'paused', waitingCount: 3 }).word).toBe(agentsDash.paused);
  });
});

describe('the bars of the last days', () => {
  const days = (counts: number[]): DayCount[] => counts.map((finished, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, finished }));

  it('is one image for a screen reader: the label and the counts', () => {
    render(<DayBars days={days([0, 2, 5])} label="Tasks finished" />);
    expect(screen.getByRole('img', { name: 'Tasks finished: 0, 2, 5' })).toBeInTheDocument();
  });

  it('draws a bar a day, the newest in the company colour, the tallest at full height and a quiet day as a stub', () => {
    const { container } = render(<DayBars days={days([0, 2, 5])} label="Tasks finished" />);
    const bars = Array.from(container.querySelectorAll<HTMLElement>('[style]'));
    expect(bars.map((bar) => bar.style.height)).toEqual(['8%', '40%', '100%']);
    expect(bars.map((bar) => bar.getAttribute('data-current'))).toEqual([null, null, 'true']);
  });

  it('a window of days with no work draws stubs, not nothing', () => {
    const { container } = render(<DayBars days={days([0, 0])} label="Tasks finished" />);
    expect(Array.from(container.querySelectorAll<HTMLElement>('[style]')).map((bar) => bar.style.height)).toEqual(['8%', '8%']);
  });
});

describe('the glyph of an agent', () => {
  it('is decoration: hidden from a screen reader, with an icon in it', () => {
    const { container } = render(<AgentGlyph agent="storm_scout" />);
    const glyph = container.firstElementChild as HTMLElement;
    expect(glyph.getAttribute('aria-hidden')).toBe('true');
    expect(glyph.querySelector('svg')).not.toBeNull();
  });
});

describe('the handoffs panel', () => {
  const handoff = (i: number): Handoff => ({ from: 'front_desk', to: 'estimator', label: `${i} Main St`, at: '2026-10-13T06:00:00.000Z' });

  it('shows the five newest and counts all of them', () => {
    render(<Handoffs handoffs={[1, 2, 3, 4, 5, 6, 7].map(handoff)} total={7} now={NOW} />);
    const panel = screen.getByRole('region', { name: agentsDash.handoffsTitle });
    expect(within(panel).getByText('7')).toBeInTheDocument();
    expect(within(panel).getAllByRole('listitem')).toHaveLength(5);
  });

  it('says how long ago each was, in words', () => {
    render(<Handoffs handoffs={[handoff(1)]} total={1} now={NOW} />);
    expect(screen.getByText('41 min ago')).toBeInTheDocument();
  });

  it('says so with no handoffs, and shows no list', () => {
    render(<Handoffs handoffs={[]} total={0} now={NOW} />);
    expect(screen.getByText(agentsDash.handoffsEmpty)).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
