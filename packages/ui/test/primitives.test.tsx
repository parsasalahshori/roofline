import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Pill,
  Select,
  Skeleton,
  StatCard,
  Toggle,
  UiLink,
  UiLinkProvider,
  type UiLinkProps,
} from '../src/index.ts';

/** A link component that records every props object it is rendered with, like a router adapter would. */
function recordingLink() {
  const seen: UiLinkProps[] = [];
  function RecordingLink(props: UiLinkProps) {
    seen.push(props);
    return <a {...props} data-provided="yes" />;
  }
  return { RecordingLink, seen };
}

describe('UiLink', () => {
  it('renders a plain anchor when no provider is mounted', () => {
    render(<UiLink href="/jobs">Jobs</UiLink>);
    const link = screen.getByRole('link', { name: 'Jobs' });
    expect(link).toHaveAttribute('href', '/jobs');
    expect(link).not.toHaveAttribute('data-provided');
  });

  it('renders the provided component with the anchor props', () => {
    const { RecordingLink, seen } = recordingLink();
    render(
      <UiLinkProvider component={RecordingLink}>
        <UiLink href="/jobs" className="x">
          Jobs
        </UiLink>
      </UiLinkProvider>,
    );
    expect(screen.getByRole('link', { name: 'Jobs' })).toHaveAttribute('data-provided', 'yes');
    expect(seen[0]).toMatchObject({ href: '/jobs', className: 'x' });
  });
});

describe('Button', () => {
  it('defaults to type="button" and the primary variant', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('data-variant', 'primary');
  });

  it('exposes the variant and size as data attributes and honours an explicit type', () => {
    render(
      <Button variant="danger" size="lg" type="submit">
        Delete
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toHaveAttribute('data-variant', 'danger');
    expect(button).toHaveAttribute('data-size', 'lg');
    expect(button).toHaveAttribute('type', 'submit');
  });

  it.each(['primary', 'ink', 'default', 'quiet', 'ghost', 'danger'] as const)('takes the %s variant', (variant) => {
    render(<Button variant={variant}>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveAttribute('data-variant', variant);
  });

  it.each(['sm', 'md', 'lg'] as const)('takes the %s size, and md is the default', (size) => {
    render(<Button size={size}>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveAttribute('data-size', size);
  });

  it('is medium by default', () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveAttribute('data-size', 'md');
  });

  it('is disabled and aria-busy while busy, and ignores clicks', async () => {
    const onClick = vi.fn();
    render(
      <Button busy onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.setup().click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is not aria-busy when idle', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).not.toHaveAttribute('aria-busy');
  });

  it('renders an anchor through the provided link component when given an href', () => {
    const { RecordingLink, seen } = recordingLink();
    render(
      <UiLinkProvider component={RecordingLink}>
        <Button href="/jobs" variant="ghost">
          Open jobs
        </Button>
      </UiLinkProvider>,
    );
    const link = screen.getByRole('link', { name: 'Open jobs' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/jobs');
    expect(link).toHaveAttribute('data-variant', 'ghost');
    expect(link).toHaveAttribute('data-provided', 'yes');
    expect(seen[0]).toMatchObject({ href: '/jobs' });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps a busy link from navigating', () => {
    const onClick = vi.fn();
    render(
      <Button href="/jobs" busy onClick={onClick}>
        Open jobs
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Open jobs' });
    expect(link).toHaveAttribute('aria-busy', 'true');
    expect(link).toHaveAttribute('aria-disabled', 'true');
    // fireEvent.click returns false when the click's default action was cancelled
    expect(fireEvent.click(link)).toBe(false);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('lets an idle link click through', () => {
    const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <Button href="/jobs" onClick={onClick}>
        Open jobs
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Open jobs' });
    expect(link).not.toHaveAttribute('aria-disabled');
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('IconButton', () => {
  it('is named by its label and hides the icon from assistive tech', () => {
    render(<IconButton label="Close" icon={<svg data-testid="icon" />} />);
    const button = screen.getByRole('button', { name: 'Close' });
    expect(button).toHaveAttribute('type', 'button');
    expect(screen.getByTestId('icon').closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('calls onClick', async () => {
    const onClick = vi.fn();
    render(<IconButton label="Close" icon={<svg />} onClick={onClick} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders a link when given an href', () => {
    render(<IconButton label="Back" icon={<svg />} href="/" />);
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/');
  });
});

describe('Card and StatCard', () => {
  it('renders the requested element and padding state', () => {
    const { container } = render(
      <Card as="section" padded={false} aria-label="Summary">
        body
      </Card>,
    );
    const card = container.firstElementChild!;
    expect(card.tagName).toBe('SECTION');
    expect(card).toHaveAttribute('data-padded', 'false');
    expect(screen.getByRole('region', { name: 'Summary' })).toBe(card);
  });

  it('is a div with padding by default', () => {
    const { container } = render(<Card>body</Card>);
    expect(container.firstElementChild!.tagName).toBe('DIV');
    expect(container.firstElementChild).toHaveAttribute('data-padded', 'true');
  });

  it('shows the label, value and hint of a stat', () => {
    render(<StatCard label="Open jobs" value={12} hint="3 new this week" />);
    expect(screen.getByText('Open jobs')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('3 new this week')).toBeInTheDocument();
  });

  it('leaves out the hint when there is none', () => {
    const { container } = render(<StatCard label="Open jobs" value="12" />);
    expect(container.querySelector('[data-part="hint"]')).toBeNull();
  });

  it('is a description list of one pair, so a screen reader hears the number with its name', () => {
    const { container } = render(<StatCard label="Open jobs" value="12" />);
    expect(container.querySelector('dl')).not.toBeNull();
    expect(container.querySelector('dt')).toHaveTextContent('Open jobs');
  });
});

describe('Toggle', () => {
  it('is a switch named by its label, with its state in aria-checked and data-state', () => {
    render(<Toggle checked onChange={() => {}} label="Text 31 customers" />);
    const toggle = screen.getByRole('switch', { name: 'Text 31 customers' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveAttribute('data-state', 'on');
    expect(toggle).toHaveAttribute('type', 'button');
  });

  it('reports off when unchecked', () => {
    render(<Toggle checked={false} onChange={() => {}} label="Text 31 customers" />);
    const toggle = screen.getByRole('switch', { name: 'Text 31 customers' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAttribute('data-state', 'off');
  });

  it('calls onChange with the opposite value when clicked', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Toggle checked onChange={onChange} label="Text 31 customers" />);
    await user.click(screen.getByRole('switch', { name: 'Text 31 customers' }));
    expect(onChange).toHaveBeenLastCalledWith(false);
    rerender(<Toggle checked={false} onChange={onChange} label="Text 31 customers" />);
    await user.click(screen.getByRole('switch', { name: 'Text 31 customers' }));
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it('can be flipped from the keyboard', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Toggle checked={false} onChange={onChange} label="Text 31 customers" />);
    await user.tab();
    expect(screen.getByRole('switch')).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does nothing when disabled', async () => {
    const onChange = vi.fn();
    render(<Toggle checked onChange={onChange} label="Text 31 customers" disabled />);
    const toggle = screen.getByRole('switch', { name: 'Text 31 customers' });
    expect(toggle).toBeDisabled();
    await userEvent.setup().click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the name when the label is hidden', () => {
    render(<Toggle checked onChange={() => {}} label="Text 31 customers" labelHidden />);
    expect(screen.getByRole('switch', { name: 'Text 31 customers' })).toBeInTheDocument();
    expect(screen.queryByText('Text 31 customers')).not.toBeInTheDocument();
  });
});

describe('Field', () => {
  it('hides the label visually but keeps it tied to the input', () => {
    render(<Field label="Minutes" labelHidden />);
    expect(screen.getByLabelText('Minutes').tagName).toBe('INPUT');
    expect(screen.getByText('Minutes')).toHaveClass('visually-hidden');
  });

  it('shows the label by default', () => {
    render(<Field label="Minutes" />);
    expect(screen.getByText('Minutes')).not.toHaveClass('visually-hidden');
  });

  it('ties the label to the input', () => {
    render(<Field label="Email" type="email" />);
    const input = screen.getByLabelText('Email');
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAttribute('type', 'email');
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('lists the help and error ids in aria-describedby and marks the field invalid', () => {
    render(<Field label="Email" help="We never share it" error="That doesn't look like an email" />);
    const input = screen.getByLabelText('Email');
    const help = screen.getByText('We never share it');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("That doesn't look like an email");
    expect(help.id).not.toBe('');
    expect(alert.id).not.toBe('');
    const describedBy = (input.getAttribute('aria-describedby') ?? '').split(/\s+/);
    expect(describedBy).toContain(help.id);
    expect(describedBy).toContain(alert.id);
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('describes the field by the help alone when there is no error', () => {
    render(<Field label="Email" help="We never share it" />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-describedby', screen.getByText('We never share it').id);
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('gives two fields different ids, and honours an explicit id', () => {
    render(
      <>
        <Field label="First" />
        <Field label="Second" />
        <Field label="Third" id="third-field" />
      </>,
    );
    expect(screen.getByLabelText('First').id).not.toBe(screen.getByLabelText('Second').id);
    expect(screen.getByLabelText('Third')).toHaveAttribute('id', 'third-field');
  });

  it('renders a textarea when multiline', () => {
    render(<Field label="Notes" multiline rows={5} />);
    const notes = screen.getByLabelText('Notes');
    expect(notes.tagName).toBe('TEXTAREA');
    expect(notes).toHaveAttribute('rows', '5');
  });

  it('passes typed text to onChange', async () => {
    const onChange = vi.fn();
    render(<Field label="Email" onChange={onChange} />);
    await userEvent.setup().type(screen.getByLabelText('Email'), 'a');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('Select', () => {
  const options = [
    { value: 'owner', label: 'Owner' },
    { value: 'office', label: 'Office' },
    { value: 'rep', label: 'Sales rep' },
  ];

  it('calls onChange with the chosen value', async () => {
    const onChange = vi.fn();
    render(<Select label="Role" value="owner" onChange={onChange} options={options} />);
    const select = screen.getByLabelText('Role');
    expect(select).toHaveValue('owner');
    await userEvent.setup().selectOptions(select, 'office');
    expect(onChange).toHaveBeenCalledWith('office');
  });

  it('describes itself with help and error, like Field', () => {
    render(
      <Select
        label="Role"
        value="owner"
        onChange={() => {}}
        options={options}
        help="Who can do what"
        error="Pick a role"
      />,
    );
    const select = screen.getByLabelText('Role');
    const describedBy = (select.getAttribute('aria-describedby') ?? '').split(/\s+/);
    expect(describedBy).toContain(screen.getByText('Who can do what').id);
    expect(describedBy).toContain(screen.getByRole('alert').id);
    expect(select).toHaveAttribute('aria-invalid', 'true');
  });

  it('can be disabled', () => {
    render(<Select label="Role" value="owner" onChange={() => {}} options={options} disabled />);
    expect(screen.getByLabelText('Role')).toBeDisabled();
  });
});

describe('Badge', () => {
  it('renders nothing at zero', () => {
    const { container } = render(<Badge count={0} label="Unread messages" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the count, named by its label', () => {
    render(<Badge count={3} label="3 unread messages" />);
    const badge = screen.getByRole('img', { name: '3 unread messages' });
    expect(badge).toHaveTextContent('3');
    expect(screen.getByLabelText('3 unread messages')).toBe(badge);
  });

  it('caps the count at 99+', () => {
    render(<Badge count={120} label="120 unread messages" />);
    expect(screen.getByText('99+')).toBeInTheDocument();
    expect(screen.getByLabelText('120 unread messages')).toBeInTheDocument();
  });

  it('shows 99 as it is', () => {
    render(<Badge count={99} label="99 unread messages" />);
    expect(screen.getByText('99')).toBeInTheDocument();
  });
});

describe('Pill (the older name for a Tag or a Chip)', () => {
  it('is a plain label: a Tag, neutral or in the company colour', () => {
    const { rerender } = render(<Pill tone="neutral">Archived</Pill>);
    expect(screen.getByText('Archived')).toHaveAttribute('data-tone', 'neutral');
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<Pill>Open</Pill>);
    expect(screen.getByText('Open')).toHaveAttribute('data-tone', 'brand');
  });

  it('is a button chip with an onClick', async () => {
    const onClick = vi.fn();
    render(<Pill onClick={onClick}>Hail</Pill>);
    const pill = screen.getByRole('button', { name: 'Hail' });
    expect(pill).toHaveAttribute('type', 'button');
    await userEvent.setup().click(pill);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is a link chip with an href, through the provided link component', () => {
    const { RecordingLink } = recordingLink();
    render(
      <UiLinkProvider component={RecordingLink}>
        <Pill href="/jobs">Jobs</Pill>
      </UiLinkProvider>,
    );
    const pill = screen.getByRole('link', { name: 'Jobs' });
    expect(pill).toHaveAttribute('href', '/jobs');
    expect(pill).toHaveAttribute('data-provided', 'yes');
  });
});

describe('Avatar', () => {
  it('shows the first letters of the first and last word', () => {
    render(<Avatar name="Dana Park" />);
    expect(screen.getByText('DP')).toBeInTheDocument();
  });

  it('shows a single letter for a single name', () => {
    render(<Avatar name="Cher" />);
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('skips middle names and uppercases', () => {
    render(<Avatar name="  dana  marie   park " />);
    expect(screen.getByText('DP')).toBeInTheDocument();
  });

  it('is hidden from assistive tech and carries its size', () => {
    render(<Avatar name="Dana Park" size={40} />);
    const avatar = screen.getByText('DP');
    expect(avatar).toHaveAttribute('aria-hidden', 'true');
    expect(avatar).toHaveAttribute('data-size', '40');
  });

  it('defaults to 32', () => {
    render(<Avatar name="Dana Park" />);
    expect(screen.getByText('DP')).toHaveAttribute('data-size', '32');
  });
});

describe('Skeleton', () => {
  it('is hidden from assistive tech', () => {
    const { container } = render(<Skeleton width="120px" height="24px" />);
    const skeleton = container.firstElementChild!;
    expect(skeleton).toHaveAttribute('aria-hidden', 'true');
    expect(skeleton).toHaveStyle({ width: '120px', height: '24px' });
  });

  it('draws the requested number of lines', () => {
    const { container } = render(<Skeleton lines={3} />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelectorAll('[data-part="line"]')).toHaveLength(3);
  });
});

describe('EmptyState', () => {
  it('shows the title, body and action', () => {
    render(
      <EmptyState
        title="No jobs yet"
        body="Add a customer to get started."
        action={<Button>Add customer</Button>}
      />,
    );
    expect(screen.getByText('No jobs yet')).toBeInTheDocument();
    expect(screen.getByText('Add a customer to get started.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add customer' })).toBeInTheDocument();
  });

  it('works with a title alone', () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(container.querySelectorAll('p')).toHaveLength(1);
  });
});

describe('refs', () => {
  it('reaches the rendered button through Button and the rendered input through Field', () => {
    const buttonRef = createRef<HTMLButtonElement | HTMLAnchorElement>();
    const fieldRef = createRef<HTMLInputElement | HTMLTextAreaElement>();
    render(
      <>
        <Button ref={buttonRef}>Save</Button>
        <Field ref={fieldRef} label="Email" />
      </>,
    );
    expect(buttonRef.current).toBe(screen.getByRole('button', { name: 'Save' }));
    expect(fieldRef.current).toBe(screen.getByLabelText('Email'));
  });

  it('reaches the anchor when Button or IconButton has an href', () => {
    const buttonRef = createRef<HTMLButtonElement | HTMLAnchorElement>();
    const iconRef = createRef<HTMLButtonElement | HTMLAnchorElement>();
    render(
      <>
        <Button ref={buttonRef} href="/jobs">
          Jobs
        </Button>
        <IconButton ref={iconRef} label="Back" icon={<svg />} href="/" />
      </>,
    );
    expect(buttonRef.current).toBe(screen.getByRole('link', { name: 'Jobs' }));
    expect(iconRef.current).toBe(screen.getByRole('link', { name: 'Back' }));
  });

  it('reaches the textarea when a Field is multiline, so the first invalid field can take focus', () => {
    const fieldRef = createRef<HTMLInputElement | HTMLTextAreaElement>();
    render(<Field ref={fieldRef} label="Notes" multiline />);
    expect(fieldRef.current).toBe(screen.getByLabelText('Notes'));
    fieldRef.current?.focus();
    expect(screen.getByLabelText('Notes')).toHaveFocus();
  });

  it('reaches the IconButton, Toggle and Select elements', () => {
    const iconRef = createRef<HTMLButtonElement | HTMLAnchorElement>();
    const toggleRef = createRef<HTMLButtonElement>();
    const selectRef = createRef<HTMLSelectElement>();
    render(
      <>
        <IconButton ref={iconRef} label="Close" icon={<svg />} />
        <Toggle ref={toggleRef} checked onChange={() => {}} label="Text customers" />
        <Select ref={selectRef} label="Role" value="a" onChange={() => {}} options={[{ value: 'a', label: 'A' }]} />
      </>,
    );
    expect(iconRef.current).toBe(screen.getByRole('button', { name: 'Close' }));
    expect(toggleRef.current).toBe(screen.getByRole('switch', { name: 'Text customers' }));
    expect(selectRef.current).toBe(screen.getByLabelText('Role'));
  });
});
