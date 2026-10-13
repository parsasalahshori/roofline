import type { ScreenAgent } from '@roofline/shared';
import { agentsDash } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { AGENT_GLYPH } from './AgentIcon.tsx';
import { AGENT_COLOR, DASH_ORDER } from './agentTheme.ts';
import styles from './RoofDiagram.module.css';

/*
 * The mountain: a roof line with one node per agent, above that agent's card, and a tag on the roof for
 * each real handoff (a job one agent passed to the next today). Own SVG, drawn on a 1300 by 372 grid.
 */
const W = 1300;
const H = 372;
const EAVE_Y = 340;
const PEAK_Y = 28;
const NODE_R = 34;
/** Height of the roof line above its eaves at horizontal position x. */
const roofY = (x: number): number => EAVE_Y - (EAVE_Y - PEAK_Y) * (1 - Math.abs(x - W / 2) / (W / 2));
const nodeX = (index: number): number => ((index * 2 + 1) / (DASH_ORDER.length * 2)) * W;

const TAG_H = 30;
const TAG_MAX = 3;

type Handoff = { from: ScreenAgent; to: ScreenAgent; label: string };

export function RoofDiagram({ handoffs, selected }: { handoffs: Handoff[]; selected: ScreenAgent | null }) {
  // One tag per pair of agents (the newest), at most three, so the roof stays readable.
  const seen = new Set<string>();
  const tags = handoffs
    .filter((h) => {
      const key = `${h.from}>${h.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return DASH_ORDER.includes(h.from) && DASH_ORDER.includes(h.to);
    })
    .slice(0, TAG_MAX);
  return (
    <svg className={styles.svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={agentsDash.diagramLabel} focusable="false">
      <defs>
        <linearGradient id="roof-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className={styles.fillTop} />
          <stop offset="1" className={styles.fillBottom} />
        </linearGradient>
      </defs>
      <polygon className={styles.fill} points={`0,${EAVE_Y} ${W / 2},${PEAK_Y} ${W},${EAVE_Y}`} fill="url(#roof-fill)" />
      <polyline className={styles.inner} points={`0,${EAVE_Y - 12} ${W / 2},${PEAK_Y + 12} ${W},${EAVE_Y - 12}`} />
      <polyline className={styles.roof} points={`0,${EAVE_Y} ${W / 2},${PEAK_Y} ${W},${EAVE_Y}`} />
      {DASH_ORDER.map((agent, i) => (
        <line key={agent} className={styles.drop} x1={nodeX(i)} x2={nodeX(i)} y1={roofY(nodeX(i))} y2={H} />
      ))}
      {tags.map((tag) => {
        const a = DASH_ORDER.indexOf(tag.from);
        const b = DASH_ORDER.indexOf(tag.to);
        const mx = (nodeX(a) + nodeX(b)) / 2;
        const my = (roofY(nodeX(a)) + roofY(nodeX(b))) / 2;
        const width = Math.min(260, 44 + tag.label.length * 7.4);
        return (
          <g key={`${tag.from}>${tag.to}`} className={styles.tag} transform={`translate(${mx - width / 2} ${my - TAG_H / 2})`}>
            <rect width={width} height={TAG_H} rx={TAG_H / 2} className={styles.tagBox} />
            <circle cx={16} cy={TAG_H / 2} r={7} style={{ fill: AGENT_COLOR[tag.from] }} className={styles.tagDot} />
            <text x={30} y={TAG_H / 2 + 5} className={styles.tagText} textLength={width - 42} lengthAdjust="spacingAndGlyphs">
              {tag.label}
            </text>
            <title>{`${AGENT_LABEL[tag.from]} ${agentsDash.handedTo} ${AGENT_LABEL[tag.to]}`}</title>
          </g>
        );
      })}
      {DASH_ORDER.map((agent, i) => (
        <g
          key={agent}
          className={styles.node}
          data-selected={agent === selected ? 'true' : undefined}
          transform={`translate(${nodeX(i)} ${roofY(nodeX(i))})`}
          style={{ color: AGENT_COLOR[agent] }}
        >
          <circle r={NODE_R} className={styles.ring} />
          <g transform="translate(-14 -14) scale(1.1667)" className={styles.glyph}>
            <NodeGlyph agent={agent} />
          </g>
        </g>
      ))}
    </svg>
  );
}

function NodeGlyph({ agent }: { agent: ScreenAgent }) {
  return <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{AGENT_GLYPH[agent]}</g>;
}
