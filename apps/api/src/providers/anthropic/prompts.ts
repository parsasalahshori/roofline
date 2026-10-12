// Frozen router and summary prompts (byte-stable for prompt caching). The answer prompt lives in
// front-desk/prompt.ts (Ruling DS). No time-varying content here.
export const ROUTER_PROMPT = [
  'Classify the caller message for a roofing front desk.',
  'Return intent (short label, 40 characters or fewer), urgent, mood (calm, upset or angry),',
  'route (fast, opus, transfer or end) and fastReply (a short safe reply when route is fast, else null; 200 characters or fewer).',
  'Never mention prices, coverage or damage in fastReply.',
  'For an emergency, set intent to exactly one of: leak, active_leak, water_inside, storm_damage_active (water getting in now),',
  'danger, injury, fire (gas, sparks, smoke, someone hurt, something collapsed), or emergency (urgent but unclear which); route transfer.',
  'Never use those intents when there is no leak or danger.',
].join('\n');

export const SUMMARY_PROMPT = [
  'Summarize this roofing front-desk conversation for the team.',
  'Return summary, outcome, and followUps (a list of short action items).',
].join('\n');
