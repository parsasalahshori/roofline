import { Banner, Skeleton, UiLink } from '@roofline/ui';
import type { CSSProperties } from 'react';
import type { ScreenAgent } from '@roofline/shared';
import { agentsDash } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { AgentIcon } from './AgentIcon.tsx';
import { AGENT_COLOR, agoWords } from './agentTheme.ts';
import { useAgentDetail, useAgentFeed } from './api.ts';
import { RulesList } from './RulesList.tsx';
import { RunNowButton } from './RunNowButton.tsx';
import { agentSlug } from './slugs.ts';
import styles from './AgentPanel.module.css';

const FEED_ROWS = 4;

function CheckMark({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {on ? <path d="M3.2 8.4l3 3 6.6-6.8" /> : <path d="M8 3.5v9M3.5 8h9" />}
    </svg>
  );
}

/** The side panel for the selected agent: what it is, Run now, what it may do, what it does and what it just did. */
export function AgentPanel({ agent, now }: { agent: ScreenAgent; now: number }) {
  const detail = useAgentDetail(agent, 'week');
  const feed = useAgentFeed(agent);
  const d = detail.data;
  const name = AGENT_LABEL[agent];
  const permissions = agentsDash.permissionList[agent];
  const allowed = permissions.filter((p) => p.on).length;
  const rows = (feed.data?.pages[0]?.items ?? []).slice(0, FEED_ROWS);
  return (
    <aside className={styles.panel} aria-label={`${agentsDash.panelLabel}: ${name}`} style={{ '--agent': AGENT_COLOR[agent] } as CSSProperties}>
      <header className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          <AgentIcon agent={agent} size={26} />
        </span>
        <div className={styles.titles}>
          <h2 className={styles.name}>{name}</h2>
          <p className={styles.blurb}>{agentsDash.blurb[agent]}</p>
        </div>
        <div className={styles.run}>
          {d ? <RunNowButton agent={agent} runNow={d.runNow} paused={d.paused !== null} label={agentsDash.runNow} /> : null}
        </div>
      </header>
      <div className={styles.body}>
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{agentsDash.permissions}</h3>
            <span className={styles.count}>{`${allowed} ${agentsDash.agentsOf} ${permissions.length} ${agentsDash.allowedOf}`}</span>
          </div>
          <ul className={styles.chips}>
            {permissions.map((p) => (
              <li key={p.label} className={styles.chip} data-on={p.on ? 'true' : 'false'}>
                <CheckMark on={p.on} />
                <span>{p.label}</span>
                <span className="visually-hidden">{p.on ? agentsDash.allowedWord : agentsDash.notAllowedWord}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{agentsDash.instructions}</h3>
          {detail.isPending ? (
            <Skeleton lines={3} />
          ) : !d ? (
            <Banner tone="danger">{agentsDash.panelLoadError}</Banner>
          ) : (
            <div className={styles.rules}>
              <RulesList rules={d.rules} />
            </div>
          )}
        </section>
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{agentsDash.recentActivity}</h3>
            <UiLink href={`/agents/${agentSlug(agent)}`} className={styles.open}>
              {`${agentsDash.openAgent} ${name}`}
            </UiLink>
          </div>
          {rows.length === 0 ? (
            feed.isPending ? null : <p className={styles.empty}>{agentsDash.recentNone}</p>
          ) : (
            <ul className={styles.feed}>
              {rows.map((row) => (
                <li key={row.id} className={styles.feedRow}>
                  {row.href === null ? (
                    <span>{row.text}</span>
                  ) : (
                    <UiLink href={row.href} className={styles.feedLink}>
                      {row.text}
                    </UiLink>
                  )}{' '}
                  <span className={styles.when}>{agoWords(row.at, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}
