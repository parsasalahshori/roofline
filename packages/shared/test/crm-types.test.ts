import { describe, expectTypeOf, it, expect } from 'vitest';
import type {
  BoardView,
  BoardStage,
  JobStage,
  JobCard,
  JobView,
  CustomerView,
  AppointmentView,
  TimelineItem,
  TimelinePage,
  CalendarConnectionView,
  CalendarProvider,
  QuoteView,
  QuoteSummary,
  ScheduleSettings,
  WorkHours,
  PricebookView,
  QuoteDefaults,
  Scope,
  Pricebook,
  Calculation,
  MemberRef,
} from '../src/index.ts';

describe('CRM view types', () => {
  it('board columns carry board stages and lost count', () => {
    expectTypeOf<BoardView['columns'][number]['stage']>().toEqualTypeOf<BoardStage>();
    expectTypeOf<BoardView['lost']>().toEqualTypeOf<{ count: number }>();
  });

  it('job cards and job views', () => {
    expectTypeOf<JobCard['stage']>().toEqualTypeOf<JobStage>();
    expectTypeOf<JobCard['valueCents']>().toEqualTypeOf<number | null>();
    expectTypeOf<JobCard['assigned']>().toEqualTypeOf<MemberRef | null>();
    expectTypeOf<JobView['job']>().toMatchTypeOf<JobCard>();
    expectTypeOf<JobView['can']>().toEqualTypeOf<{ edit: boolean; seeValue: boolean; archive: boolean }>();
    expectTypeOf<MemberRef>().toEqualTypeOf<{ userId: string; name: string }>();
  });

  it('appointment sync states', () => {
    expectTypeOf<AppointmentView['sync']>().toEqualTypeOf<'none' | 'synced' | 'pending' | 'failed'>();
  });

  it('customer view', () => {
    expectTypeOf<CustomerView['can']>().toEqualTypeOf<{ edit: boolean; changeConsent: boolean; archive: boolean }>();
    expectTypeOf<CustomerView['customer']['emails']>().toEqualTypeOf<string[]>();
  });

  it('timeline items and pages', () => {
    expectTypeOf<TimelineItem['type']>().toEqualTypeOf<'activity' | 'text'>();
    expectTypeOf<TimelineItem['actor']['type']>().toEqualTypeOf<'user' | 'agent' | 'system'>();
    expectTypeOf<TimelinePage['nextBefore']>().toEqualTypeOf<string | null>();
  });

  it('calendar connection', () => {
    expectTypeOf<CalendarConnectionView['provider']>().toEqualTypeOf<CalendarProvider | null>();
    expectTypeOf<CalendarConnectionView['configured']>().toEqualTypeOf<Record<CalendarProvider, boolean>>();
    expectTypeOf<CalendarProvider>().toEqualTypeOf<'google' | 'microsoft'>();
  });

  it('schedule settings use the shared work hours type', () => {
    expectTypeOf<ScheduleSettings['workHours']>().toEqualTypeOf<WorkHours>();
  });

  it('pricebook and quote defaults', () => {
    expectTypeOf<PricebookView['prices']>().toEqualTypeOf<Pricebook>();
    expectTypeOf<QuoteDefaults['material']>().toEqualTypeOf<Scope['material']>();
  });

  it('quote view', () => {
    expectTypeOf<QuoteView['calculation']>().toEqualTypeOf<Calculation>();
    expectTypeOf<QuoteView['scope']>().toEqualTypeOf<Scope>();
    expectTypeOf<QuoteView['finalizedAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<QuoteSummary['totalCents']>().toEqualTypeOf<number>();
  });

  it('runtime sanity', () => {
    expect(true).toBe(true);
  });
});
