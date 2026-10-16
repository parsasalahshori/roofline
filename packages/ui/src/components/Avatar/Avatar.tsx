import styles from './Avatar.module.css';

export type AvatarProps = {
  name: string;
  size?: 24 | 28 | 32 | 40;
};

/** The first letter of the first and last word: "Dana Marie Park" is DP, "Cher" is C. */
function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  return [first, last]
    .filter((word): word is string => word !== undefined)
    .map((word) => Array.from(word)[0]!.toLocaleUpperCase())
    .join('');
}

/** Decoration only: the person's name is always written next to it, so it stays out of the accessibility tree. */
export function Avatar({ name, size = 32 }: AvatarProps) {
  return (
    <span className={styles.avatar} data-size={size} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
