import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Banner, Checkbox, FilePicker, ProgressBar, ProgressRing } from '../src/index.ts';

describe('Checkbox', () => {
  it('calls onChange with true when the label is clicked', async () => {
    const user = userEvent.setup();
    const fn = vi.fn();
    render(<Checkbox checked={false} onChange={fn} label="Agree" />);
    await user.click(screen.getByText('Agree'));
    expect(fn).toHaveBeenCalledWith(true);
  });

  it('marks the input invalid and shows the error as an alert', () => {
    render(<Checkbox checked={false} onChange={() => {}} label="Agree" error="Required" />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Required');
  });

  it('follows checked in data-state', () => {
    const { container, rerender } = render(
      <Checkbox checked={false} onChange={() => {}} label="Agree" />,
    );
    expect(container.querySelector('[data-state]')).toHaveAttribute('data-state', 'unchecked');
    rerender(<Checkbox checked={true} onChange={() => {}} label="Agree" />);
    expect(container.querySelector('[data-state]')).toHaveAttribute('data-state', 'checked');
  });
});

describe('ProgressBar', () => {
  it('reports the value to assistive tech', () => {
    render(<ProgressBar value={40} max={100} label="Importing" />);
    const bar = screen.getByRole('progressbar', { name: 'Importing' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
  });

  it('clamps the value to the maximum', () => {
    render(<ProgressBar value={150} max={100} label="Importing" />);
    expect(screen.getByRole('progressbar', { name: 'Importing' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
  });

  it('reports zero when the maximum is zero', () => {
    render(<ProgressBar value={5} max={0} label="Importing" />);
    expect(screen.getByRole('progressbar', { name: 'Importing' })).toHaveAttribute(
      'aria-valuenow',
      '0',
    );
  });
});

describe('ProgressRing', () => {
  it('is not marked complete while steps remain', () => {
    render(<ProgressRing done={2} total={5} label="2 of 5 setup steps done" />);
    expect(screen.getByRole('img', { name: '2 of 5 setup steps done' })).not.toHaveAttribute(
      'data-complete',
    );
  });

  it('is marked complete when every step is done', () => {
    const { rerender } = render(<ProgressRing done={2} total={5} label="2 of 5 setup steps done" />);
    rerender(<ProgressRing done={5} total={5} label="5 of 5 setup steps done" />);
    expect(screen.getByRole('img', { name: '5 of 5 setup steps done' })).toHaveAttribute(
      'data-complete',
    );
  });
});

describe('FilePicker', () => {
  it('calls onFile when a file is chosen through the input', async () => {
    const user = userEvent.setup();
    const onFile = vi.fn();
    render(
      <FilePicker
        onFile={onFile}
        label="Customer file"
        buttonLabel="Choose file"
        dropLabel="Drop a file here"
        accept=".csv"
      />,
    );
    const file = new File(['a'], 'a.csv', { type: 'text/csv' });
    await user.upload(screen.getByLabelText('Customer file'), file);
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it('shows the drop zone as over while a drag is inside it, then calls onFile on drop', () => {
    const onFile = vi.fn();
    render(
      <FilePicker
        onFile={onFile}
        label="Customer file"
        buttonLabel="Choose file"
        dropLabel="Drop a file here"
        accept=".csv"
      />,
    );
    const zone = screen.getByText('Drop a file here');
    const file = new File(['a'], 'a.csv', { type: 'text/csv' });

    fireEvent.dragEnter(zone);
    expect(zone).toHaveAttribute('data-state', 'over');

    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
    expect(zone).toHaveAttribute('data-state', 'idle');
  });

  it('shows an error as an alert', () => {
    render(
      <FilePicker
        onFile={() => {}}
        label="Customer file"
        buttonLabel="Choose file"
        dropLabel="Drop a file here"
        accept=".csv"
        error="Bad file"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Bad file');
  });
});

describe('Banner', () => {
  it('uses the alert role for danger', () => {
    render(<Banner tone="danger">Oops</Banner>);
    expect(screen.getByRole('alert')).toHaveTextContent('Oops');
  });

  it('uses the status role for warning', () => {
    render(<Banner tone="warning">Careful</Banner>);
    expect(screen.getByRole('status')).toHaveTextContent('Careful');
  });

  it('uses the status role for info', () => {
    render(<Banner tone="info">FYI</Banner>);
    expect(screen.getByRole('status')).toHaveTextContent('FYI');
  });

  it('renders the action slot', () => {
    render(
      <Banner tone="warning" action={<span>Fix it</span>}>
        Payment failed
      </Banner>,
    );
    expect(screen.getByText('Fix it')).toBeInTheDocument();
  });
});
