import type { OnCallMember } from '@roofline/shared';
import { Avatar, Icon, IconButton, Panel } from '@roofline/ui';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { frontDeskSettings } from '../../../copy/front-desk-settings.ts';
import { formatPhone } from '../../../lib/phone.ts';
import styles from './OnCallList.module.css';

/*
 * The on-call list: who answers, top down, when a call is passed to a person. Rows reorder by
 * drag (mouse and pen) or by the up and down buttons (keyboard and touch). Controlled: FrontDeskTab
 * owns the order and saves it; this component only reports the next order through onChange.
 */

const copy = frontDeskSettings.onCall;

export type OnCallListProps = {
  /** Every member, as GET /api/front-desk/settings returns them (OnCallMember[]). */
  members: OnCallMember[];
  /** User ids in ring order. Members not in it are off the list. Controlled by FrontDeskTab. */
  order: string[];
  onChange: (order: string[]) => void;
  disabled?: boolean;
};

const GRIP = <Icon name="drag" size={18} />;
const UP = (
  <span className={styles.flip}>
    <Icon name="chevd" size={18} />
  </span>
);
const DOWN = <Icon name="chevd" size={18} />;
const REMOVE = <Icon name="x" size={18} />;
const ADD = <Icon name="plus" size={18} />;

/** The ids with one moved to final position `to` (0-based). Pure: the input array is never changed. */
function reorder(ids: string[], userId: string, to: number): string[] {
  const next = ids.filter((id) => id !== userId);
  next.splice(to, 0, userId);
  return next;
}

export function OnCallList({ members, order, onChange, disabled = false }: OnCallListProps) {
  const byId = new Map(members.map((member) => [member.userId, member]));
  const listed = order.flatMap((id) => {
    const member = byId.get(id);
    return member ? [member] : [];
  });
  const listedIds = new Set(listed.map((member) => member.userId));
  const offList = members.filter((member) => !listedIds.has(member.userId));
  const ids = listed.map((member) => member.userId);

  const [announcement, setAnnouncement] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const draggingId = useRef<string | null>(null);
  // After a button move the row is re-rendered in a new place; focus goes back to its button.
  const pendingFocus = useRef<string | null>(null);

  useEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    pendingFocus.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)?.focus();
  }, [order]);

  function commit(next: string[], userId: string, to: number, direction: 'up' | 'down') {
    const name = byId.get(userId)?.name ?? '';
    let focusDirection = direction;
    if (focusDirection === 'up' && to === 0) focusDirection = 'down';
    if (focusDirection === 'down' && to === next.length - 1) focusDirection = 'up';
    pendingFocus.current = `${userId}|${focusDirection}`;
    setAnnouncement(copy.moved(name, to + 1));
    onChange(next);
  }

  function moveBy(index: number, delta: number) {
    const userId = ids[index];
    const to = index + delta;
    if (userId === undefined || to < 0 || to >= ids.length) return;
    commit(reorder(ids, userId, to), userId, to, delta < 0 ? 'up' : 'down');
  }

  function dropAt(dragId: string, to: number) {
    const from = ids.indexOf(dragId);
    if (from === -1 || from === to) return;
    const direction = to < from ? 'up' : 'down';
    commit(reorder(ids, dragId, to), dragId, to, direction);
  }

  function remove(userId: string) {
    onChange(ids.filter((id) => id !== userId));
  }

  function add(userId: string) {
    onChange([...ids, userId]);
  }

  return (
    <Panel as="section" title={copy.heading}>
      <div className={styles.root}>
        <p className={styles.help}>{copy.help}</p>

        <div ref={listRef} className={styles.listArea}>
          {listed.length === 0 ? (
            <p className={styles.empty}>
              <Icon name="phone" size={18} />
              {copy.empty}
            </p>
          ) : (
            <ol className={styles.list}>
              {listed.map((member, index) => {
                const { userId, name } = member;
                const last = listed.length - 1;
                return (
                  <li
                    key={userId}
                    className={styles.row}
                    draggable={!disabled}
                    onDragStart={(event: DragEvent<HTMLLIElement>) => {
                      if (disabled) {
                        event.preventDefault();
                        return;
                      }
                      draggingId.current = userId;
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', userId);
                    }}
                    onDragOver={(event: DragEvent<HTMLLIElement>) => {
                      if (draggingId.current !== null) event.preventDefault();
                    }}
                    onDrop={(event: DragEvent<HTMLLIElement>) => {
                      event.preventDefault();
                      const dragId = draggingId.current;
                      draggingId.current = null;
                      if (dragId !== null && !disabled) dropAt(dragId, index);
                    }}
                    onDragEnd={() => {
                      draggingId.current = null;
                    }}
                  >
                    <IconButton
                      label={copy.dragHandle(name)}
                      icon={GRIP}
                      tabIndex={-1}
                      disabled={disabled}
                      className={styles.handle}
                    />
                    <span className={styles.place} aria-hidden="true">
                      {index + 1}
                    </span>
                    <Avatar name={name} size={32} />
                    <div className={styles.who}>
                      <span className={styles.name}>{name}</span>
                      <span className={styles.phone}>{member.transferPhoneE164 ? formatPhone(member.transferPhoneE164) : copy.noPhone}</span>
                    </div>
                    <div className={styles.actions}>
                      <IconButton
                        label={copy.moveUp(name)}
                        icon={UP}
                        data-focus-key={`${userId}|up`}
                        disabled={disabled || index === 0}
                        onClick={() => moveBy(index, -1)}
                      />
                      <IconButton
                        label={copy.moveDown(name)}
                        icon={DOWN}
                        data-focus-key={`${userId}|down`}
                        disabled={disabled || index === last}
                        onClick={() => moveBy(index, 1)}
                      />
                      <IconButton
                        label={copy.remove(name)}
                        icon={REMOVE}
                        disabled={disabled}
                        onClick={() => remove(userId)}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {offList.length > 0 ? (
          <div className={styles.offSection}>
            <h3 className={styles.subheading}>{copy.notOnList}</h3>
            <div className={styles.offList}>
              {offList.map((member) => (
                <div key={member.userId} className={styles.row} data-off="true">
                  <Avatar name={member.name} size={32} />
                  <div className={styles.who}>
                    <span className={styles.name}>{member.name}</span>
                    <span className={styles.phone}>{member.transferPhoneE164 ? formatPhone(member.transferPhoneE164) : copy.noPhone}</span>
                  </div>
                  <div className={styles.actions}>
                    <IconButton
                      label={copy.add(member.name)}
                      icon={ADD}
                      disabled={disabled}
                      onClick={() => add(member.userId)}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <p className="visually-hidden" aria-live="polite">
          {announcement}
        </p>
      </div>
    </Panel>
  );
}
