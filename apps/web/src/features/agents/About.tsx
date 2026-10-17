import { agentsCommon, agentsDash } from '../../copy/agents.ts';
import { hoursParts } from './agentTheme.ts';
import styles from './About.module.css';

/** The estimate mark before a figure that is a guess ("about 35 hrs"): small and grey, so the figure still reads first. */
export function About({ lead = agentsDash.about }: { lead?: string }) {
  // The space is part of the text, so the figure reads "about 35" as words, in a copy and to a screen reader
  return <span className={styles.about}>{`${lead} `}</span>;
}

/** A tile with no figure yet: a quiet dash, so it does not read as a number, and words for a screen reader. */
export function NoFigure() {
  return (
    <>
      <span className={styles.none} aria-hidden="true">
        –
      </span>
      <span className="visually-hidden">{agentsCommon.noFigure}</span>
    </>
  );
}

/**
 * Hours saved as a figure: "about 28 hours" with the lead and the unit set small beside the number, as the Overview's tiles
 * do. The spaces are real text, so it reads and copies as one phrase.
 */
export function HoursFigure({ minutes }: { minutes: number }) {
  const parts = hoursParts(minutes);
  return (
    <>
      <About lead={parts.lead} />
      {parts.number}
      <span className={styles.unit}>{` ${parts.unit}`}</span>
    </>
  );
}
