// Dependency-free weather validation/projection for the display bundle.
export const weatherConditions = [
  "clear-day",
  "clear-night",
  "partly-cloudy",
  "cloudy",
  "rain",
  "heavy-rain",
  "snow",
  "sleet",
  "hail",
  "fog",
  "wind",
  "windy-cloudy",
  "thunderstorm",
  "thunderstorm-rain",
] as const;
export type WeatherCondition = (typeof weatherConditions)[number];
export type ForecastPeriod = "daily" | "hourly";
export type WeatherValue = {
  temperature: number | null;
  condition: WeatherCondition | null;
};
export type ForecastEntry = WeatherValue & {
  at: number;
  low: number | null;
};
export type ForecastValue = { entries: ForecastEntry[] };

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const temperature = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isFinite(value));
export function isWeatherValue(value: unknown): value is WeatherValue {
  return (
    object(value) &&
    temperature(value.temperature) &&
    (value.condition === null ||
      weatherConditions.includes(value.condition as WeatherCondition)) &&
    (value.temperature !== null || value.condition !== null)
  );
}
export function isForecastValue(
  value: unknown,
  period: ForecastPeriod,
): value is ForecastValue {
  return (
    object(value) &&
    Array.isArray(value.entries) &&
    value.entries.length > 0 &&
    value.entries.length <= (period === "daily" ? 7 : 24) &&
    value.entries.every(
      (entry, index, entries) =>
        object(entry) &&
        Number.isSafeInteger(entry.at) &&
        (entry.at as number) >= 0 &&
        (index === 0 || (entry.at as number) > entries[index - 1].at) &&
        temperature(entry.low) &&
        (period === "daily" || entry.low === null) &&
        isWeatherValue({
          temperature: entry.temperature ?? entry.low,
          condition: entry.condition,
        }) &&
        temperature(entry.temperature) &&
        (entry.low === null ||
          entry.temperature === null ||
          (entry.low as number) <= (entry.temperature as number)),
    )
  );
}
export function projectWeather(value: WeatherValue): WeatherValue {
  return { temperature: value.temperature, condition: value.condition };
}
export function projectForecast(value: ForecastValue): ForecastValue {
  return {
    entries: value.entries.map((entry) => ({
      at: entry.at,
      ...projectWeather(entry),
      low: entry.low,
    })),
  };
}
