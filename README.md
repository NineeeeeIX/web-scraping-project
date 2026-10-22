# Thailand Historical Weather Scraper

TypeScript + Node.js + Playwright + Zod + CSV pipeline for historical daily weather data in Thailand.

## Data source

- Historical weather: https://open-meteo.com/en/docs/historical-weather-api
- Geocoding: https://open-meteo.com/en/docs/geocoding-api

The project uses Playwright's API request context to retrieve JSON from the public endpoints, validates source responses and each output row with Zod, then writes CSV. This is API-based collection rather than parsing HTML pages; it is more reliable for a large historical dataset than scraping a table page by page.

Open-Meteo historical data is reanalysis/model data and should not be described as direct measurements from a weather station in every province. Check the source's current terms/licensing and attribution requirements before using the dataset commercially.

## Expected volume

The date range is 2024-01-01 through 2025-12-31 inclusive (731 days). If all 77 province lookups resolve correctly, the target is approximately **56,287 daily rows** (77 × 731). The actual count can be lower if geocoding fails or a request errors. Inspect `output/geocoding-report.csv` and `output/errors.json`.

## Requirements

- Node.js 20 or newer recommended
- Internet access

## Install and run

```bash
npm install
npx playwright install chromium
npm run typecheck
npm start
```

Generated files:

- `output/thailand_weather_2024_2025.csv`
- `output/geocoding-report.csv`
- `output/errors.json`

## CSV columns

| Column | Meaning | Example/unit |
|---|---|---|
| source_name | Data provider | Open-Meteo Historical Weather API |
| source_url | Provider documentation URL | Valid URL |
| location_name | Requested province label | Chiang Mai, Thailand |
| latitude / longitude | Resolved coordinates | Decimal degrees |
| country_code | ISO country code | TH |
| forecast_time | Date of daily weather record | YYYY-MM-DD |
| scraped_at | UTC time the collection run started | ISO 8601 |
| timezone | Local timezone used by the API | Asia/Bangkok |
| temperature | Mean daily air temperature | °C |
| feels_like | Mean daily apparent temperature | °C |
| humidity_percent | Mean daily relative humidity | 0–100% |
| wind_speed | Mean daily wind speed | km/h |
| wind_direction | Dominant daily wind direction, degrees | 0–360 as a string |

Some values may be null if the provider has no value for a variable.

## Configure date range / output directory

PowerShell:

```powershell
$env:START_DATE="2024-01-01"
$env:END_DATE="2025-12-31"
$env:OUTPUT_DIR="output"
npm start
```

macOS/Linux:

```bash
START_DATE=2024-01-01 END_DATE=2025-12-31 OUTPUT_DIR=output npm start
```

## Important data-quality check

Geocoding names are not guaranteed to resolve to a provincial capital. Review `geocoding-report.csv` before analysis. The report records the API's returned location and coordinates so you can spot mismatches or duplicates. If a province resolves to the wrong place, replace that province's geocoding result with verified coordinates.

## Field mapping vs. the requested schema

The output preserves the requested field names. `forecast_time` is a daily date, not an hourly timestamp. The selected temperature, apparent temperature, humidity, and wind fields are daily aggregates. If you need hourly records instead, switch the request from `daily` variables to `hourly` variables; that would produce far more than 50,000 rows across 77 provinces.
