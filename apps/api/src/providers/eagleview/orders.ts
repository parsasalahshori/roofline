import { z } from 'zod';
import type { Config } from '../../config.ts';
import {
  ExactOrderUncertainError,
  ExactReportsUnavailableError,
  type ExactOrderInput,
  type ExactPrice,
  type ExactReports,
} from '../exact-reports.ts';
import { EagleViewHttp, EagleViewHttpError, type EagleViewResponse } from './http.ts';
import { EagleViewNormalizeError, normalizeEagleView } from './normalize.ts';

/**
 * EagleView "delivery product" id for the standard digital delivery. v1 used this value; confirm it
 * with EagleView at partner onboarding and change it here if their catalogue differs.
 */
const DELIVERY_PRODUCT_ID = 8;

/** A price quote is valid for this long (v1: ten minutes). */
const PRICE_TTL_MS = 10 * 60 * 1000;
/** MeasurementInstructionType 1 = include garage (v1's default for orders). */
const MEASUREMENT_INSTRUCTION_INCLUDE_GARAGE = 1;
const ORDER_COMMENT = 'Roofline: US imperial roof measurements requested.';

/** Failed statuses from GetReport: v1 treats these ids as failed. */
const FAILED_STATUS_IDS: readonly number[] = [6, 7];
/** GetReport status id for a completed report. */
const COMPLETED_STATUS_ID = 5;
/** Report ids are numeric. Anything else never reaches the URL. */
const REPORT_ID_PATTERN = /^\d{1,15}$/;

const NO_ANSWER_MESSAGE = "EagleView didn't answer.";
const BAD_PRICE_MESSAGE = 'EagleView sent a price we could not read.';
const REJECTED_MESSAGE = 'EagleView did not accept the order. No order was placed.';
const ORDER_UNCERTAIN_MESSAGE = 'Order result is uncertain. Check EagleView with the reference before ordering again.';

const placeOrderSchema = z.object({
  ReportIds: z.array(z.number().int().positive()).min(1),
});

type ReportResult = Awaited<ReturnType<ExactReports['report']>>;

type OrderPayload = {
  OrderReports: [
    {
      ReferenceId: string;
      ReportAddresses: [
        { Address: string; City: string; State: string; Zip: string; Country: string; AddressType: number },
      ];
      PrimaryProductId: number;
      DeliveryProductId: number;
      MeasurementInstructionType: number;
      ChangesInLast4Years: boolean;
      Comments: string;
    },
  ];
};

/** Builds the EagleView client from config. Null unless credentials are set and an order product is configured. */
export function eagleViewOrdersFor(config: Config): ExactReports | null {
  const clientId = config.EAGLEVIEW_CLIENT_ID;
  const clientSecret = config.EAGLEVIEW_CLIENT_SECRET;
  if (!clientId || !clientSecret || config.EAGLEVIEW_PRODUCT_ID <= 0) return null;
  return new EagleViewOrders({
    http: new EagleViewHttp({ clientId, clientSecret, env: config.EAGLEVIEW_ENV }),
    productId: config.EAGLEVIEW_PRODUCT_ID,
    deliveryId: DELIVERY_PRODUCT_ID,
  });
}

export class EagleViewOrders implements ExactReports {
  readonly configured = true;

  constructor(private readonly o: { http: EagleViewHttp; productId: number; deliveryId: number }) {}

  async price(i: ExactOrderInput): Promise<ExactPrice> {
    let res: EagleViewResponse;
    try {
      res = await this.o.http.request('orders', 'POST', '/v2/Order/PriceOrder', this.payload(i));
    } catch (err) {
      if (err instanceof EagleViewHttpError) throw new ExactReportsUnavailableError(NO_ANSWER_MESSAGE);
      throw err;
    }
    const dollars = priceDollars(res.body, PRICE_KEYS);
    if (dollars === null || dollars <= 0) throw new ExactReportsUnavailableError(BAD_PRICE_MESSAGE);
    const cents = Math.round(dollars * 100);
    return { minCents: cents, maxCents: cents, expiresAt: new Date(Date.now() + PRICE_TTL_MS) };
  }

  /**
   * Places the order once. Never retried. Only a clear refusal (no order created) is reported as
   * unavailable; any other outcome after the call was made is uncertain.
   */
  async order(i: ExactOrderInput): Promise<{ reportId: string }> {
    const payload = this.payload(i);
    let res: EagleViewResponse;
    try {
      res = await this.o.http.request('orders', 'POST', '/v2/Order/PlaceOrder', payload);
    } catch (err) {
      if (err instanceof EagleViewHttpError && isClearRefusal(err)) {
        throw new ExactReportsUnavailableError(REJECTED_MESSAGE);
      }
      throw new ExactOrderUncertainError(ORDER_UNCERTAIN_MESSAGE);
    }
    if (res.status !== 200 && res.status !== 201) throw new ExactOrderUncertainError(ORDER_UNCERTAIN_MESSAGE);
    const parsed = placeOrderSchema.safeParse(res.body);
    if (!parsed.success) throw new ExactOrderUncertainError(ORDER_UNCERTAIN_MESSAGE);
    const [first] = parsed.data.ReportIds;
    if (first === undefined) throw new ExactOrderUncertainError(ORDER_UNCERTAIN_MESSAGE);
    return { reportId: String(first) };
  }

  async report(reportId: string): Promise<ReportResult> {
    if (!REPORT_ID_PATTERN.test(reportId)) return { status: 'failed', reasonKey: 'provider_failed' };
    let res: EagleViewResponse;
    try {
      res = await this.o.http.request('orders', 'GET', `/v3/Report/GetReport?reportId=${reportId}`);
    } catch (err) {
      if (err instanceof EagleViewHttpError) {
        if (err.kind === 'not_found' && err.status !== 204) {
          return { status: 'failed', reasonKey: 'provider_failed' };
        }
        throw new ExactReportsUnavailableError(NO_ANSWER_MESSAGE);
      }
      throw err;
    }
    const body = res.body;
    if (!isRecord(body)) return { status: 'pending' };
    if (isCompleted(body)) return this.completeReport(body);
    if (isFailed(body)) return { status: 'failed', reasonKey: 'provider_failed' };
    return { status: 'pending' };
  }

  private completeReport(body: Record<string, unknown>): ReportResult {
    try {
      const report = normalizeEagleView(body);
      const dollars = priceDollars(body, COST_KEYS);
      const costCents = dollars === null ? 0 : Math.round(dollars * 100);
      return { status: 'complete', report, costCents };
    } catch (err) {
      if (err instanceof EagleViewNormalizeError) return { status: 'failed', reasonKey: 'unsupported_units' };
      throw err;
    }
  }

  /** The order payload in v1's wire shape: one report with one address. */
  private payload(i: ExactOrderInput): OrderPayload {
    return {
      OrderReports: [
        {
          ReferenceId: i.referenceId,
          ReportAddresses: [
            {
              Address: i.address.street,
              City: i.address.city,
              State: i.address.state,
              Zip: i.address.zip,
              Country: 'US',
              AddressType: 1,
            },
          ],
          PrimaryProductId: this.o.productId,
          DeliveryProductId: this.o.deliveryId,
          MeasurementInstructionType: MEASUREMENT_INSTRUCTION_INCLUDE_GARAGE,
          ChangesInLast4Years: false,
          Comments: ORDER_COMMENT,
        },
      ],
    };
  }
}

const PRICE_KEYS: readonly string[] = ['Total', 'TotalPrice'];
const COST_KEYS: readonly string[] = ['Cost', 'TotalPrice', 'Total'];

/** A refusal where EagleView clearly created no order. Ambiguous kinds (network, 5xx, 429, bad body) are not refusals. */
function isClearRefusal(err: EagleViewHttpError): boolean {
  if (err.kind === 'rejected') return true;
  // 204 has no body and may mean the order was created, so it stays uncertain.
  return err.kind === 'not_found' && err.status !== 204;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCompleted(body: Record<string, unknown>): boolean {
  if (body.StatusId === COMPLETED_STATUS_ID) return true;
  return typeof body.Status === 'string' && /^completed$/i.test(body.Status);
}

function isFailed(body: Record<string, unknown>): boolean {
  if (typeof body.StatusId === 'number' && FAILED_STATUS_IDS.includes(body.StatusId)) return true;
  return typeof body.Status === 'string' && /fail|cancel|reject/i.test(body.Status);
}

/**
 * Reads the first present dollar amount among keys (a number or a plain numeric string).
 * Null when none is present or the value is not a non-negative amount.
 */
function priceDollars(body: unknown, keys: readonly string[]): number | null {
  if (!isRecord(body)) return null;
  for (const key of keys) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value.trim());
    return null;
  }
  return null;
}
