import { Banner, Icon, Panel, Skeleton, UiLink } from '@roofline/ui';
import type { ScreenAgent } from '@roofline/shared';
import { agentsDash } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { AgentGlyph } from './AgentGlyph.tsx';
import { agoWords } from './agentTheme.ts';
import { useAgentDetail, useAgentFeed } from './api.ts';
import { RulesList } from './RulesList.tsx';
import { RunNowButton } from './RunNowButton.tsx';
import { agentSlug } from './slugs.ts';
import styles from './AgentPanel.module.css';

const FEED_ROWS = 4;

/** The panel beside the cards for the picked agent: what it is, Run now, what it may do, what it does and what it just did. */
export function AgentPanel({ agent, now }: { agent: ScreenAgent; now: number }) {
  const detail = useAgentDetail(agent, 'week');
  const feed = useAgentFeed(agent);
  const d = detail.data;
  const name = AGENT_LABEL[agent];
  const permissions = agentsDash.permissionList[agent];
  const allowed = permissions.filter((p) => p.on).length;
  const rows = (feed.data?.pages[0]?.items ?? []).slice(0, FEED_ROWS);
  return (
    <Panel
      as="aside"
      className={styles.panel}
      title={
        <span className={styles.title}>
          <AgentGlyph agent={agent} size="md" />
          <span>{name}</span>
        </span>
      }
    >
      <div className={styles.body}>
        <div className={styles.intro}>
          <p className={styles.blurb}>{agentsDash.blurb[agent]}</p>
          {d ? <RunNowButton agent={agent} runNow={d.runNow} paused={d.paused !== null} label={agentsDash.runNow} /> : null}
        </div>
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{agentsDash.permissions}</h3>
            <span className={styles.count}>{`${allowed} ${agentsDash.agentsOf} ${permissions.length} ${agentsDash.allowedOf}`}</span>
          </div>
          <ul className={styles.permissions}>
            {permissions.map((p) => (
              <li key={p.label} className={styles.permission} data-on={p.on ? 'true' : 'false'}>
                <Icon name={p.on ? 'check' : 'lock'} size={16} />
                <span className={styles.permissionLabel}>{p.label}</span>
                {p.on ? <span className="visually-hidden">{agentsDash.allowedWord}</span> : <span className={styles.notAllowed}>{agentsDash.notAllowedWord}</span>}
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
            <RulesList rules={d.rules} />
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
    </Panel>
  );
}
