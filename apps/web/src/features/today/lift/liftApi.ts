import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client.ts';

/** One day tile of GET /api/weather/outlook (apps/api/src/routes/weather.ts). */
export type OutlookDay = {
  /** YYYY-MM-DD, the company's local date. */
  date: string;
  highF: number | null;
  precipChancePercent: number | null;
  icon: 'sun' | 'moon' | 'cloud' | 'rain' | 'storm' | 'snow' | 'fog' | 'wind';
  risky: boolean;
  installs: number;
};

export type WeatherOutlook = {
  today: string;
  days: OutlookDay[];
  atRisk: number;
  worstDate: string | null;
};

const OUTLOOK_EVERY = 30 * 60_000;

/** The next days of forecast with the Scheduler's rain rule: `data.outlook` is null when there is no forecast. */
export function useWeatherOutlook() {
  return useQuery({
    queryKey: ['weather', 'outlook'] as const,
    queryFn: ({ signal }) => apiFetch<{ outlook: WeatherOutlook | null }>('/api/weather/outlook', { signal }),
    refetchInterval: OUTLOOK_EVERY,
    staleTime: OUTLOOK_EVERY,
  });
}
