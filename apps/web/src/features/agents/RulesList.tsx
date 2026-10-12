import { UiLink } from '@roofline/ui';
import type { RuleSentence } from '@roofline/shared';
import type { ReactNode } from 'react';
import { agentPage } from '../../copy/agents.ts';
import styles from './RulesList.module.css';

/** The rule's text with each link label turned into a link, walking left to right. */
function renderRule(rule: RuleSentence): ReactNode[] {
  const parts: ReactNode[] = [];
  let rest = rule.text;
  rule.links.forEach((link, index) => {
    const at = link.label === '' ? -1 : rest.indexOf(link.label);
    if (at < 0) return;
    if (at > 0) parts.push(rest.slice(0, at));
    parts.push(
      <UiLink key={index} href={link.href} className={styles.link}>
        {link.label}
      </UiLink>,
    );
    rest = rest.slice(at + link.label.length);
  });
  if (rest) parts.push(rest);
  return parts;
}

/** What the agent does, one plain sentence per rule, its numbers linking to where they are changed. */
export function RulesList({ rules }: { rules: RuleSentence[] }) {
  if (rules.length === 0) return <p className={styles.empty}>{agentPage.rulesEmpty}</p>;
  return (
    <ul className={styles.list}>
      {rules.map((rule, index) => (
        <li key={index} className={styles.item}>
          {renderRule(rule)}
        </li>
      ))}
    </ul>
  );
}
