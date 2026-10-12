import type { CallControl } from '../call-control.ts';
import type { SubaccountRef } from '../registrar.ts';

function sid(prefix: string, n: number): string {
  return `${prefix}${n.toString(16).padStart(32, '0')}`;
}

export class FakeCallControl implements CallControl {
  readonly configured = true;
  recordings = new Map<string, Uint8Array>();
  calls: { method: string; args: unknown[] }[] = [];
  private counter = 0;
  private failures = 0;

  failNext(n = 1): void {
    this.failures = n;
  }
  putRecording(recordingSid: string, bytes: Uint8Array): void {
    this.recordings.set(recordingSid, bytes);
  }

  private async enter(method: string, args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    if (this.failures > 0) {
      this.failures--;
      throw new Error('call control failure');
    }
  }

  async startRecording(sub: SubaccountRef, callSid: string, statusCallback?: string): Promise<{ recordingSid: string }> {
    await this.enter('startRecording', statusCallback === undefined ? [sub, callSid] : [sub, callSid, statusCallback]);
    const recordingSid = sid('RE', ++this.counter);
    this.recordings.set(recordingSid, Uint8Array.from([0x49, 0x44, 0x33]));
    return { recordingSid };
  }
  async stopRecording(sub: SubaccountRef, callSid: string, recordingSid: string): Promise<void> {
    await this.enter('stopRecording', [sub, callSid, recordingSid]);
  }
  async fetchRecording(sub: SubaccountRef, recordingSid: string): Promise<Uint8Array> {
    await this.enter('fetchRecording', [sub, recordingSid]);
    const bytes = this.recordings.get(recordingSid);
    if (!bytes) throw new Error('recording not found');
    return bytes;
  }
  async deleteRecording(sub: SubaccountRef, recordingSid: string): Promise<void> {
    await this.enter('deleteRecording', [sub, recordingSid]);
    this.recordings.delete(recordingSid);
  }
  async placeTestCall(i: { to: string; from: string; statusCallback: string }): Promise<{ callSid: string }> {
    await this.enter('placeTestCall', [i]);
    return { callSid: sid('CA', ++this.counter) };
  }
  async setVoiceUrl(sub: SubaccountRef, phoneNumberSid: string, url: string, statusCallback: string): Promise<void> {
    await this.enter('setVoiceUrl', [sub, phoneNumberSid, url, statusCallback]);
  }
}
