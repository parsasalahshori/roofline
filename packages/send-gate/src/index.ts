export { decide, type GateDecision, type GateRequest } from './decide.ts';
export { decideEmail, type EmailGateDecision, type EmailGateRequest } from './email.ts';
export { nextAllowedTime } from './quiet-hours.ts';
export { classifyInbound, type InboundKind, type InboundReading, looksLikeOptOut, readInbound } from './inbound.ts';
export {
  DisabledSmsAdapter,
  FakeSmsAdapter,
  isSmsRefusedError,
  type OutboundSms,
  SMS_REFUSED,
  type SmsAdapter,
  SmsRefusedError,
  type SmsSendResult,
} from './adapter.ts';
// Convenience: the body renderer lives in shared, and the gate checks the body it produces.
export { renderBody } from '@roofline/shared';
