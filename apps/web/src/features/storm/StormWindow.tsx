import { Banner, Button, EmptyState, Icon, Panel, Skeleton, Table, Tag, Td, Th, Tr } from '@roofline/ui';
import { useApprovals, useMapArea, useMe } from '../../api/hooks.ts';
import { doors } from '../../copy/doors.ts';
import { storm } from '../../copy/storm.ts';
import { AppPage } from '../../shell/AppPage.tsx';
import { countedDrafts } from '../../shell/countedDrafts.ts';
import { MapPanel } from '../../shell/MapPanel.tsx';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { HomeApproval } from '../today/HomeApproval.tsx';
import { newestFirst } from '../today/homeFacts.ts';
import { useStorms } from './api.ts';
import { count, hailLevel, hailName, hailSize, stormDay } from './format.ts';
import { useStormLayer } from './layerApi.ts';
import { planTag } from './planTag.ts';
import type { StormSummary } from './types.ts';
import styles from './StormWindow.module.css';

/** Newest day first. The list answer already leaves out dismissed storms; the query data is not changed. */
function visibleStorms(storms: StormSummary[]): StormSummary[] {
  return [...storms].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/** The hail size of a storm: a swatch in the key's colour, the number in mono, and what it is in a hand. */
function HailSize({ inches }: { inches: number }) {
  return (
    <span className={styles.hail}>
      <span className={styles.swatch} style={{ background: `var(--hail-${hailLevel(inches)})` }} aria-hidden="true" />
      <span className={styles.size}>
        <b>{hailSize(inches)}</b>
        <span className={styles.unit}>{storm.hailUnit}</span>
      </span>
      <span className={styles.name}>{hailName(inches)}</span>
    </span>
  );
}

/** What can be done with a storm: open it, and open its plan while the plan waits for a yes. */
function StormActions({ item }: { item: StormSummary }) {
  const seePlan = item.planTaskId !== null && (item.planStatus === 'draft' || item.planStatus === 'awaiting_owner');
  return (
    <div className={styles.actions}>
      <Button size="sm" variant="default" href={'/storm/' + encodeURIComponent(item.id)}>
        {storm.viewStorm}
      </Button>
      {seePlan ? (
        <Button size="sm" variant="quiet" href={'/storm/plans/' + encodeURIComponent(item.planTaskId as string)}>
          {storm.seePlan}
        </Button>
      ) : null}
    </div>
  );
}

function PlanTag({ status }: { status: string | null }) {
  const tag = planTag(status);
  return (
    <Tag tone={tag.tone} icon={tag.icon}>
      {tag.label}
    </Tag>
  );
}

/** The storms as a table: where, when, how big, how many it hit, and where the plan stands. */
function StormsTable({ rows }: { rows: StormSummary[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>{storm.colStorm}</Th>
          <Th>{storm.colHail}</Th>
          <Th numeric>{storm.colCustomers}</Th>
          <Th numeric>{storm.colHomes}</Th>
          <Th>{storm.colPlan}</Th>
          <Th>
            <span className="visually-hidden">{storm.colActions}</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((item) => (
          <Tr key={item.id}>
            <Td>
              <span className={styles.place}>
                <b>{item.placeName ?? stormDay(item.day)}</b>
                {item.placeName ? <span className={styles.day}>{stormDay(item.day)}</span> : null}
              </span>
            </Td>
            <Td>
              <HailSize inches={item.maxIn} />
            </Td>
            <Td numeric>{count(item.customersHit)}</Td>
            <Td numeric>{count(item.homesHit)}</Td>
            <Td>
              <PlanTag status={item.planStatus} />
            </Td>
            <Td>
              <StormActions item={item} />
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

/** The same storms on a phone: one block each, the facts side by side and the buttons under them. */
function StormsList({ rows }: { rows: StormSummary[] }) {
  return (
    <ul className={styles.list}>
      {rows.map((item) => (
        <li key={item.id} className={styles.item}>
          <div className={styles.itemHead}>
            <span className={styles.place}>
              <b>{item.placeName ?? stormDay(item.day)}</b>
              {item.placeName ? <span className={styles.day}>{stormDay(item.day)}</span> : null}
            </span>
            <PlanTag status={item.planStatus} />
          </div>
          <HailSize inches={item.maxIn} />
          <p className={styles.facts}>
            <span>{storm.customersHit(item.customersHit)}</span>
            <span aria-hidden="true"> · </span>
            <span>{storm.homesHit(item.homesHit)}</span>
          </p>
          <StormActions item={item} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The Storm page: the map with the hail on it, the newest plan waiting for a yes beside it, and the list of storms in
 * your area underneath. My routes (the door-knock lists) is the button at the top.
 */
export function StormWindow() {
  const me = useMe();
  const approvals = useApprovals();
  const storms = useStorms();
  const area = useMapArea();
  const layer = useStormLayer(area.data?.bounds ?? null, 6, true);
  const phone = useIsPhone();
  const canDecide = me.data?.role === 'owner' || me.data?.role === 'office';
  const plans = canDecide ? newestFirst(countedDrafts(approvals.data).filter((task) => task.agent === 'storm_scout')) : [];
  const [newest] = plans;

  const rows = storms.data ? visibleStorms(storms.data.storms) : [];

  return (
    <AppPage
      app="storm"
      actions={
        <Button variant="default" href="/storm/routes">
          <Icon name="route" size={16} />
          {doors.myRoutesLink}
        </Button>
      }
    >
      {layer.data?.stale === true ? <Banner tone="warning">{storm.staleBanner}</Banner> : null}
      <div className={styles.top}>
        <div className={styles.map}>
          <MapPanel pins={false} />
        </div>
        <div className={styles.side}>
          {newest ? (
            <section aria-label={storm.planHeading} className={styles.plan}>
              <HomeApproval
                key={newest.id}
                task={newest}
                more={plans.length - 1}
                href={'/storm/plans/' + encodeURIComponent(newest.id)}
                reviewLabel={storm.approve}
              />
            </section>
          ) : (
            <Panel as="aside" title={storm.noPlanWaiting} className={styles.noPlan}>
              <p className={styles.help}>{storm.noPlanWaitingHelp}</p>
            </Panel>
          )}
        </div>
      </div>
      {storms.isPending ? (
        <div role="status" aria-label={storm.loading}>
          <Skeleton lines={3} />
        </div>
      ) : null}
      {storms.isError ? <p role="alert">{storm.loadFailed}</p> : null}
      {storms.data ? (
        <Panel title={storm.listHeading} tag={rows.length > 0 ? storm.count(rows.length) : undefined} padded={false}>
          {rows.length === 0 ? (
            <EmptyState title={storm.empty} />
          ) : phone ? (
            <StormsList rows={rows} />
          ) : (
            <StormsTable rows={rows} />
          )}
          {rows.length > 0 ? <p className={styles.note}>{storm.radarNote}</p> : null}
        </Panel>
      ) : null}
    </AppPage>
  );
}
