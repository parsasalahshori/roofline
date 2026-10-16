import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PinCard } from '../src/shell/map/PinCard.tsx';
import type { PickedPin } from '../src/shell/map/types.ts';

afterEach(() => {
  cleanup();
});

const JOB_PIN: PickedPin = {
  kind: 'job',
  id: 'job-1',
  name: 'Ada Lovelace',
  addressLine: '12 Oak St',
  stage: 'proposal',
  stageLabel: 'Proposal',
  lngLat: [-96.8, 32.9],
};

const CUSTOMER_PIN: PickedPin = {
  kind: 'customer',
  id: 'cust-1',
  name: 'Grace Hopper',
  addressLine: '4 Elm Ave',
  stage: null,
  stageLabel: null,
  lngLat: [-96.7, 32.8],
};

describe('PinCard', () => {
  it('shows the name, the address and the stage of a job', () => {
    render(<PinCard pin={JOB_PIN} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('12 Oak St')).toBeInTheDocument();
    expect(screen.getByText('Proposal')).toBeInTheDocument();
  });

  it('is a labelled region named after the pin, marked with its kind', () => {
    render(<PinCard pin={JOB_PIN} onOpen={vi.fn()} onClose={vi.fn()} />);
    const region = screen.getByRole('region', { name: 'Ada Lovelace' });
    expect(region).toHaveAttribute('data-kind', 'job');
    expect(region.querySelector('[data-stage="proposal"]')).toHaveTextContent('Proposal');
  });

  it('calls onOpen once with the kind and id when Open is pressed', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<PinCard pin={JOB_PIN} onOpen={onOpen} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Open job' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith({ kind: 'job', id: 'job-1' });
  });

  it('offers directions to the address as a link that opens in a new tab', () => {
    render(<PinCard pin={JOB_PIN} onOpen={vi.fn()} onClose={vi.fn()} />);
    const link = screen.getByRole('link', { name: 'Directions' });
    expect(link).toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=12%20Oak%20St');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('has no directions link for a pin with no address', () => {
    render(<PinCard pin={{ ...JOB_PIN, addressLine: '' }} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('link', { name: 'Directions' })).toBeNull();
  });

  it('calls onClose once when Close is pressed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PinCard pin={JOB_PIN} onOpen={vi.fn()} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a customer with no stage and no stage marker', () => {
    const { container } = render(<PinCard pin={CUSTOMER_PIN} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByText('4 Elm Ave')).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'Grace Hopper' });
    expect(region).toHaveAttribute('data-kind', 'customer');
    expect(container.querySelector('[data-stage]')).toBeNull();
  });

  it('opens a customer with its own kind', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<PinCard pin={CUSTOMER_PIN} onOpen={onOpen} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Open customer' }));
    expect(onOpen).toHaveBeenCalledWith({ kind: 'customer', id: 'cust-1' });
  });
});
