import { Button, Icon } from '@roofline/ui';
import { useId, useRef, useState, type DragEvent } from 'react';
import { jobs } from '../../copy/jobs.ts';
import styles from './LostLane.module.css';

export type LostLaneProps = {
  /** How many jobs are lost. */
  count: number;
  /** A card is being dragged: the lane lights up as a place to drop it. */
  dragging: boolean;
  onDropJob: (jobId: string) => void;
};

/**
 * Lost, the last lane: a 46px vertical tab with its count that opens into a drawer. Both are places to drop a card (it
 * asks why the job was lost); the board shows no lost cards.
 */
export function LostLane({ count, dragging, onDropJob }: LostLaneProps) {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const drawerId = useId();

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    depth.current = 0;
    setOver(false);
    const jobId = event.dataTransfer.getData('text/plain');
    if (jobId !== '') onDropJob(jobId);
  };

  return (
    <div
      className={styles.lane}
      data-open={open ? 'true' : undefined}
      data-over={over && dragging ? 'true' : undefined}
      onDragOver={(event) => event.preventDefault()}
      onDragEnter={() => {
        depth.current += 1;
        setOver(true);
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={handleDrop}
    >
      <Button
        variant="quiet"
        className={styles.tab}
        aria-label={jobs.lostDrawer(count)}
        aria-expanded={open}
        aria-controls={drawerId}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? 'chevd' : 'chev'} size={16} />
        <span className={styles.name}>
          {jobs.stage.lost}
          <span className={styles.count}>{count}</span>
        </span>
      </Button>
      {open ? (
        <div id={drawerId} className={styles.drawer}>
          <p className={styles.hint}>{count === 0 ? jobs.lostDrawerEmpty : jobs.lostDropHint}</p>
        </div>
      ) : null}
    </div>
  );
}
