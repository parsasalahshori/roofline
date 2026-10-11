import type { Clock } from '../clock.ts';
import type { CurrentWeather, WeatherSource } from './source.ts';

type Entry = { value: CurrentWeather | null; expiresAt: number };

/**
 * Remembers each place's weather for 30 minutes (the service updates hourly, and every signed-in
 * member of a company asks for the same place). A `null` is remembered too, so a service that is
 * down is asked once per window, not once per page load. Misses on the same key that overlap share
 * one call to the source.
 *
 * A source is meant never to throw. If one does, nothing is remembered (the next call asks again),
 * the error goes to the caller that caused the miss, and callers that joined its call get `null`:
 * one failure, one report.
 *
 * Entries are small and there is one per company and place (about 1 km), so an expired one is
 * replaced when its key is asked for again and nothing sweeps them.
 */
export class WeatherCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<CurrentWeather | null>>();

  constructor(
    private readonly source: WeatherSource,
    private readonly clock: Clock,
    private readonly ttlMs = 30 * 60_000,
  ) {}

  /** The weather for `key`, from memory or from the source. `lat` and `lng` are used only on a miss. */
  async get(key: string, lat: number, lng: number): Promise<CurrentWeather | null> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.clock.now().getTime()) return entry.value;

    const joined = this.inFlight.get(key);
    if (joined) return joined.catch(() => null);

    const started = this.load(key, lat, lng).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }

  private async load(key: string, lat: number, lng: number): Promise<CurrentWeather | null> {
    const value = await this.source.current(lat, lng);
    // Counted from when the answer arrived, so a slow service does not shorten the window.
    this.entries.set(key, { value, expiresAt: this.clock.now().getTime() + this.ttlMs });
    return value;
  }
}
