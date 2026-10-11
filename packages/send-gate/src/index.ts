export { decide, type GateDecision, type GateRequest } from './decide.ts';
export { nextAllowedTime } from './quiet-hours.ts';
export { FakeSmsAdapter, type OutboundSms, type SmsAdapter, type SmsSendResult } from './adapter.ts';
// Convenience: the body renderer lives in shared, and the gate checks the body it produces.
export { renderBody } from '@roofline/shared';
