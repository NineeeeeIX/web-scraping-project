import {
  request as playwrightRequest,
  type APIRequestContext,
} from "playwright";
import { z } from "zod";
import { stringify } from "csv-stringify/sync";
import { parse } from "csv-parse/sync";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { provinces } from "./provinces.js";

const START_DATE = process.env.START_DATE ?? "2024-01-01";
const END_DATE = process.env.END_DATE ?? "2025-12-31";
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "output";
const TIMEZONE = "Asia/Bangkok";

const GeocodingResultSchema = z
  .object({
    name: z.string(),
    latitude: z.number(),
    longitude: z.number(),
    country_code: z.string().optional(),
    admin1: z.string().optional(),
  })
  .passthrough();

const GeocodingResponseSchema = z
  .object({
    results: z.array(GeocodingResultSchema).optional().default([]),
  })
  .passthrough();

const ArchiveResponseSchema = z
  .object({
    latitude: z.number(),
    longitude: z.number(),
    timezone: z.string().optional(),
    daily: z.object({
      time: z.array(z.string()),
      temperature_2m_mean: z.array(z.number().nullable()).optional(),
      apparent_temperature_mean: z.array(z.number().nullable()).optional(),
      relative_humidity_2m_mean: z.array(z.number().nullable()).optional(),
      wind_speed_10m_mean: z.array(z.number().nullable()).optional(),
      wind_direction_10m_dominant: z.array(z.number().nullable()).optional(),
    }),
  })
  .passthrough();

type WeatherRow = {
  source_name: string;
  source_url: string;
  location_name: string;
  latitude: number;
  longitude: number;
  country_code: string;
  forecast_time: string;
  scraped_at: string;
  timezone: string;
  temperature: number | null;
  feels_like: number | null;
  humidity_percent: number | null;
  wind_speed: number | null;
  wind_direction: string | null;
};

type GeoReportRow = {
  requested_province: string;
  resolved_name: string;
  admin1: string;
  latitude: number | null;
  longitude: number | null;
  status: string;
};

const SOURCE_NAME = "Open-Meteo Historical Weather API";
const SOURCE_URL = "https://open-meteo.com/en/docs/historical-weather-api";

function queryString(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function getJson(
  request: APIRequestContext,
  url: string,
  retries = 6,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await request.get(url, { timeout: 60_000 });
      if (response.ok()) return await response.json();

      const status = response.status();
      const message = `HTTP ${status} for ${url}`;
      // 429 means rate-limited; wait substantially longer before retrying.
      if (attempt < retries) {
        const delay =
          status === 429
            ? Math.min(10_000 * 2 ** (attempt - 1), 120_000)
            : Math.min(3_000 * attempt, 15_000);
        console.warn(
          `Request failed (${message}); attempt ${attempt}/${retries}; retrying in ${Math.round(delay / 1000)}s`,
        );
        await response.dispose();
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw new Error(message);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      // HTTP errors already waited above; avoid an extra short retry on the final attempt.
      if (attempt < retries && !message.startsWith("HTTP ")) {
        const delay = Math.min(5_000 * attempt, 20_000);
        console.warn(
          `Request failed (attempt ${attempt}/${retries}); retrying in ${Math.round(delay / 1000)}s: ${message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else if (attempt === retries) {
        lastError = error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function geocodeProvince(
  request: APIRequestContext,
  province: string,
): Promise<{
  name: string;
  latitude: number;
  longitude: number;
  admin1: string;
} | null> {
  const url =
    "https://geocoding-api.open-meteo.com/v1/search?" +
    queryString({
      name: `${province}, Thailand`,
      count: "10",
      language: "en",
      format: "json",
    });
  const raw = await getJson(request, url);
  const parsed = GeocodingResponseSchema.parse(raw);
  const thailandResults = parsed.results.filter((r) => r.country_code === "TH");

  if (thailandResults.length === 0) return null;

  // Prefer a close name match; otherwise use the first Thailand result and record it in the report.
  const normalized = province.toLowerCase().replace(/[^a-z]/g, "");
  const result =
    thailandResults.find(
      (r) => r.name.toLowerCase().replace(/[^a-z]/g, "") === normalized,
    ) ?? thailandResults[0];

  return {
    name: result.name,
    latitude: result.latitude,
    longitude: result.longitude,
    admin1: result.admin1 ?? "",
  };
}

async function fetchProvinceWeather(
  request: APIRequestContext,
  province: string,
  location: { name: string; latitude: number; longitude: number },
  scrapedAt: string,
): Promise<WeatherRow[]> {
  const url =
    "https://archive-api.open-meteo.com/v1/archive?" +
    queryString({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      start_date: START_DATE,
      end_date: END_DATE,
      daily: [
        "temperature_2m_mean",
        "apparent_temperature_mean",
        "relative_humidity_2m_mean",
        "wind_speed_10m_mean",
        "wind_direction_10m_dominant",
      ].join(","),
      timezone: TIMEZONE,
      temperature_unit: "celsius",
      wind_speed_unit: "kmh",
      timeformat: "iso8601",
    });

  const parsed = ArchiveResponseSchema.parse(await getJson(request, url));
  const daily = parsed.daily;
  const rows: WeatherRow[] = [];

  for (let i = 0; i < daily.time.length; i++) {
    rows.push({
      source_name: SOURCE_NAME,
      source_url: SOURCE_URL,
      location_name: `${province}, Thailand`,
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      country_code: "TH",
      forecast_time: daily.time[i]!,
      scraped_at: scrapedAt,
      timezone: parsed.timezone ?? TIMEZONE,
      temperature: daily.temperature_2m_mean?.[i] ?? null,
      feels_like: daily.apparent_temperature_mean?.[i] ?? null,
      humidity_percent: daily.relative_humidity_2m_mean?.[i] ?? null,
      wind_speed: daily.wind_speed_10m_mean?.[i] ?? null,
      wind_direction:
        daily.wind_direction_10m_dominant?.[i] == null
          ? null
          : String(daily.wind_direction_10m_dominant[i]),
    });
  }

  // Validate each final output row before it is written.
  return rows.map((row) => WeatherRowSchema.parse(row));
}

const NullableNumber = z.number().finite().nullable();
const WeatherRowSchema = z.object({
  source_name: z.string().min(1),
  source_url: z.string().url(),
  location_name: z.string().min(1),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  country_code: z.string().length(2),
  forecast_time: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scraped_at: z.string().datetime({ offset: true }),
  timezone: z.string().min(1),
  temperature: NullableNumber,
  feels_like: NullableNumber,
  humidity_percent: NullableNumber.refine(
    (v) => v === null || (v >= 0 && v <= 100),
  ),
  wind_speed: NullableNumber.refine((v) => v === null || v >= 0),
  wind_direction: z.string().nullable(),
});

async function main(): Promise<void> {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(START_DATE) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(END_DATE)
  ) {
    throw new Error("START_DATE and END_DATE must use YYYY-MM-DD format.");
  }
  if (START_DATE > END_DATE)
    throw new Error("START_DATE must be before or equal to END_DATE.");

  await mkdir(OUTPUT_DIR, { recursive: true });
  const request: APIRequestContext = await playwrightRequest.newContext({
    extraHTTPHeaders: {
      "User-Agent": "ThailandWeatherResearch/1.0 (Playwright)",
    },
  });
  const csvPath = `${OUTPUT_DIR}/thailand_weather_2024_2025.csv`;
  const errorsPath = `${OUTPUT_DIR}/errors.json`;
  let existingRows: WeatherRow[] = [];
  let previousFailures: { province: string; error: string }[] = [];

  try {
    const csvText = await readFile(csvPath, "utf8");
    existingRows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      cast: (value, context) => {
        if (
          [
            "latitude",
            "longitude",
            "temperature",
            "feels_like",
            "humidity_percent",
            "wind_speed",
          ].includes(String(context.column))
        ) {
          return value === "" ? null : Number(value);
        }
        return value;
      },
    }) as WeatherRow[];
  } catch {
    // No previous CSV: start a fresh full run.
  }

  try {
    const errorsText = await readFile(errorsPath, "utf8");
    const previous = JSON.parse(errorsText) as {
      failures?: { province: string; error: string }[];
    };
    previousFailures = previous.failures ?? [];
  } catch {
    // No previous errors file: start a fresh full run.
  }

  const isResume = existingRows.length > 0 && previousFailures.length > 0;
  const provincesToProcess = isResume
    ? provinces.filter((province) =>
        previousFailures.some((f) => f.province === province),
      )
    : provinces;

  const scrapedAt = new Date().toISOString();
  const allRows: WeatherRow[] = [...existingRows];
  const geoReport: GeoReportRow[] = [];
  const failures: { province: string; error: string }[] = [];

  console.log(
    isResume
      ? `Resume mode: retrying ${provincesToProcess.length} failed provinces; keeping ${existingRows.length} existing rows.`
      : `Fresh mode: processing ${provincesToProcess.length} provinces.`,
  );

  try {
    for (let index = 0; index < provincesToProcess.length; index++) {
      const province = provincesToProcess[index]!;
      console.log(`[${index + 1}/${provincesToProcess.length}] ${province}`);

      try {
        const geo = await geocodeProvince(request, province);
        if (!geo) {
          console.warn(`  Could not geocode ${province}; skipping.`);
          geoReport.push({
            requested_province: province,
            resolved_name: "",
            admin1: "",
            latitude: null,
            longitude: null,
            status: "NOT_FOUND",
          });
          continue;
        }

        geoReport.push({
          requested_province: province,
          resolved_name: geo.name,
          admin1: geo.admin1,
          latitude: geo.latitude,
          longitude: geo.longitude,
          status: "RESOLVED_REVIEW_MATCH",
        });

        const rows = await fetchProvinceWeather(
          request,
          province,
          geo,
          scrapedAt,
        );

        // Replace any existing rows for this province rather than duplicating them.
        const locationName = `${province}, Thailand`;
        for (let i = allRows.length - 1; i >= 0; i--) {
          if (allRows[i]!.location_name === locationName) allRows.splice(i, 1);
        }
        allRows.push(...rows);
        console.log(
          `  Added ${rows.length} daily rows (total ${allRows.length}).`,
        );

        // Give the public API time between province requests.
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ province, error: message });
        console.error(`  Failed: ${message}`);
      }
    }
  } finally {
    await request.dispose();
  }

  const weatherCsv = stringify(allRows, { header: true, bom: true });
  await writeFile(
    `${OUTPUT_DIR}/thailand_weather_2024_2025.csv`,
    weatherCsv,
    "utf8",
  );
  await writeFile(
    `${OUTPUT_DIR}/geocoding-report.csv`,
    stringify(geoReport, { header: true, bom: true }),
    "utf8",
  );
  await writeFile(
    `${OUTPUT_DIR}/errors.json`,
    JSON.stringify(
      { start_date: START_DATE, end_date: END_DATE, failures },
      null,
      2,
    ),
    "utf8",
  );

  console.log("\nFinished.");
  console.log(`Weather rows: ${allRows.length}`);
  console.log(`Province lookups: ${geoReport.length}`);
  console.log(`Failures: ${failures.length}`);
  console.log(`Output: ${OUTPUT_DIR}/thailand_weather_2024_2025.csv`);
  console.log(
    "Review geocoding-report.csv to confirm each province resolved to the intended location.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
