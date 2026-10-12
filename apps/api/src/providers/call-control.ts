import type { SubaccountRef } from './registrar.ts';

export interface CallControl {
  readonly configured: boolean;
  startRecording(sub: SubaccountRef, callSid: string, statusCallback?: string): Promise<{ recordingSid: string }>;
  stopRecording(sub: SubaccountRef, callSid: string, recordingSid: string): Promise<void>;
  fetchRecording(sub: SubaccountRef, recordingSid: string): Promise<Uint8Array>; // mp3
  deleteRecording(sub: SubaccountRef, recordingSid: string): Promise<void>;
  placeTestCall(i: { to: string; from: string; statusCallback: string }): Promise<{ callSid: string }>; // Roofline's own account
  setVoiceUrl(sub: SubaccountRef, phoneNumberSid: string, url: string, statusCallback: string): Promise<void>;
}
