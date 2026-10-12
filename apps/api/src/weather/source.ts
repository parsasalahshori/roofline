/*
 * Weather for the company's location (the dashboard's weather chip). Where the numbers come from
 * is a `WeatherSource`: the real one asks the National Weather Service (nws.ts), tests use a fake,
 * and a deployment that must not reach the network uses `NullWeatherSource`.
 */

export type WeatherIcon = 'sun' | 'moon' | 'cloud' | 'rain' | 'storm' | 'snow' | 'fog' | 'wind';

export type CurrentWeather = {
  /** Whole degrees Fahrenheit. */
  tempF: number;
  /** The forecast's own short words, for example `Mostly Sunny`. */
  summary: string;
  icon: WeatherIcon;
  isDaytime: boolean;
  /** When the reading starts, as an ISO instant. */
  updatedAt: string;
};

/** One hour of forecast, shared with the weather-risk rule in @roofline/shared (G1). */
export type { HourlyForecast } from '@roofline/shared';
import type { HourlyForecast } from '@roofline/shared';

export interface WeatherSource {
  /**
   * The weather now at a place, or null when there is none to show: the service is down or slow,
   * answered something unreadable, or does not cover the place (outside the US). A source never
   * throws for those; null is the whole answer and the screen simply shows no weather.
   */
  current(lat: number, lng: number): Promise<CurrentWeather | null>;
  /**
   * The next `hours` hourly periods at a place, soonest first, or null on any failure (same rule
   * as `current`: never throws).
   */
  hourly(lat: number, lng: number, hours: number): Promise<HourlyForecast[] | null>;
}

/** A source with no weather to give. It asks nobody. */
export class NullWeatherSource implements WeatherSource {
  readonly current: WeatherSource['current'] = async () => null;
  readonly hourly: WeatherSource['hourly'] = async () => null;
}
