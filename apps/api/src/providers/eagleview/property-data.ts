import { z } from 'zod';
import type { Config } from '../../config.ts';
import { AerialUnavailableError, type AerialMeasure, type AerialRoof } from '../aerial.ts';
import { EagleViewHttp } from './http.ts';

const NOT_PROCESSED = 'EagleView could not process this property.';
const UNANSWERED = "EagleView didn't answer.";
const NO_ROOF = 'EagleView returned no usable roof for this property.';

const requestSchema = z.object({
  request: z.object({ id: z.uuid(), status: z.string() }),
});

const resultSchema = z.object({
  request: z.object({ id: z.string(), status: z.string() }),
  structures: z.array(z.unknown()).max(1000),
});

const structureSchema = z.object({
  roof: z.object({
    structure_roof_area: z.object({
      value: z.number().positive().max(100000),
      unit: z.literal('square feet'),
    }),
    structure_roof_predominant_pitch: z.object({
      value: z.number().min(0).max(24),
      unit: z.literal('over 12'),
    }),
  }),
});

export function eagleViewPropertyDataFor(config: Config): AerialMeasure | null {
  const clientId = config.EAGLEVIEW_CLIENT_ID;
  const clientSecret = config.EAGLEVIEW_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new EagleViewPropertyData({
    http: new EagleViewHttp({ clientId, clientSecret, env: config.EAGLEVIEW_ENV }),
  });
}

export class EagleViewPropertyData implements AerialMeasure {
  readonly configured = true;
  private readonly http: EagleViewHttp;

  constructor(o: { http: EagleViewHttp }) {
    this.http = o.http;
  }

  async start(address: string): Promise<{ requestId: string }> {
    let body: unknown;
    try {
      body = (await this.http.request('property', 'POST', '/property/v2/request', {
        address: { completeAddress: address },
      })).body;
    } catch {
      throw new AerialUnavailableError(UNANSWERED);
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success || parsed.data.request.status === 'Failure') {
      throw new AerialUnavailableError(NOT_PROCESSED);
    }
    return { requestId: parsed.data.request.id };
  }

  async result(requestId: string): Promise<{ status: 'pending' } | { status: 'complete'; roofs: AerialRoof[] }> {
    const id = z.uuid().safeParse(requestId);
    if (!id.success) throw new AerialUnavailableError(NOT_PROCESSED);

    let res: { status: number; body: unknown };
    try {
      res = await this.http.request('property', 'GET', `/property/v2/result/${id.data}`);
    } catch {
      throw new AerialUnavailableError(UNANSWERED);
    }
    if (res.status === 202) return { status: 'pending' };

    const parsed = resultSchema.safeParse(res.body);
    if (!parsed.success || parsed.data.request.status === 'Failure' || parsed.data.request.id !== id.data) {
      throw new AerialUnavailableError(NOT_PROCESSED);
    }

    const roofs: AerialRoof[] = [];
    parsed.data.structures.forEach((structure, structureIndex) => {
      const roof = structureSchema.safeParse(structure);
      if (!roof.success) return;
      roofs.push({
        areaSqFt: roof.data.roof.structure_roof_area.value,
        pitchX12: roof.data.roof.structure_roof_predominant_pitch.value,
        structureIndex,
      });
    });
    if (roofs.length === 0) throw new AerialUnavailableError(NO_ROOF);
    return { status: 'complete', roofs };
  }
}
