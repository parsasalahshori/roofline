/**
 * How wide the Agents overview has to be, in rem, for the picked agent's panel to sit beside the cards. The layout asks the
 * same question in CSS (`@container (min-width: 62rem)` in AgentsWindow.module.css, which a test keeps in step with this);
 * the window asks it here for what CSS cannot change: with room, a card picks the agent for the panel; without, it opens the
 * agent's page.
 */
export const SIDE_PANEL_REM = 62;
