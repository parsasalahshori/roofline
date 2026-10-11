import styles from './Skeleton.module.css';

export type SkeletonProps = {
  width?: string;
  height?: string;
  /** Draw this many stacked lines (the last one shorter) instead of a single block. */
  lines?: number;
};

/** A placeholder while content loads. Pure decoration, so the loading state is announced elsewhere. */
export function Skeleton({ width = '100%', height = '1rem', lines }: SkeletonProps) {
  if (lines === undefined) {
    return <span className={styles.bar} style={{ width, height }} aria-hidden="true" />;
  }
  return (
    <span className={styles.lines} style={{ width }} aria-hidden="true">
      {Array.from({ length: Math.max(0, Math.floor(lines)) }, (_, index) => (
        <span key={index} className={styles.bar} data-part="line" style={{ height }} />
      ))}
    </span>
  );
}
