import { describe, expect, it } from 'vitest';
import { agentPage, agentsDash } from '../src/copy/agents.ts';

describe('time breakdown labels', () => {
  it('says Front Desk call and text rows include bookings', () => {
    expect(agentPage.baselineLabels.call_answered).toBe('Calls answered (incl. bookings)');
    expect(agentPage.baselineLabels.text_reply).toBe('Text replies (incl. bookings)');
  });
});

describe('dashboard copy', () => {
  it('marks the dollar figure as an estimate', () => {
    expect(agentsDash.officeSubSuffix).toContain('(estimate)');
  });

  it('lists permissions for every agent, and at least one it may not do without approval', () => {
    for (const list of Object.values(agentsDash.permissionList)) {
      expect(list.some((p) => p.on)).toBe(true);
      expect(list.some((p) => !p.on)).toBe(true);
    }
  });
});
