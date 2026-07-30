import countryNames from "./countries.json";

export interface CountryFlagOption {
  /** ISO-3166 country code (or special code like "GB-ENG", "EU", "XK"). */
  code: string;
  name: string;
}

/** All bundled country flags (`public/flags/svg/{code}.svg`), sorted by name. */
export const COUNTRY_FLAG_OPTIONS: CountryFlagOption[] = Object.entries(
  countryNames as Record<string, string>,
)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** Public URL for a bundled country flag SVG. */
export function countryFlagSvgUrl(code: string): string {
  return `/flags/svg/${code.toLowerCase()}.svg`;
}

/** Fetches a bundled country flag SVG and wraps it as a File, ready to upload. */
export async function fetchCountryFlagFile(code: string): Promise<File> {
  const url = countryFlagSvgUrl(code);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load flag for "${code}"`);
  }
  const blob = await response.blob();
  return new File([blob], `${code.toLowerCase()}.svg`, {
    type: "image/svg+xml",
  });
}
