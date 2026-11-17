/** Runtime configuration, served as config.json next to index.html. */
export type AppConfig = {
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  region: string;
};

export class ConfigError extends Error {}

let current: AppConfig | null = null;

const REQUIRED_KEYS = ['apiUrl', 'userPoolId', 'userPoolClientId', 'region'] as const;

export async function loadConfig(): Promise<AppConfig> {
  // Relative URL: the app is hosted under whatever path CloudFront serves it from.
  // Absolute (from the app root), so deep links like /classes/CS101/report still find it.
  const url = new URL(`${import.meta.env.BASE_URL}config.json`, window.location.origin).toString();
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    throw new ConfigError(`Could not download config.json (${String(err)}).`);
  }
  if (!res.ok) {
    throw new ConfigError(`config.json returned HTTP ${res.status}.`);
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    // Vite's dev server answers unknown paths with index.html, so a missing
    // file usually shows up here as "not JSON".
    throw new ConfigError('config.json is missing or is not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError('config.json must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  const missing = REQUIRED_KEYS.filter((k) => typeof obj[k] !== 'string' || !(obj[k] as string).trim());
  if (missing.length) {
    throw new ConfigError(`config.json is missing: ${missing.join(', ')}.`);
  }
  const apiUrl = (obj.apiUrl as string).trim();
  current = {
    apiUrl: apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`,
    userPoolId: (obj.userPoolId as string).trim(),
    userPoolClientId: (obj.userPoolClientId as string).trim(),
    region: (obj.region as string).trim(),
  };
  return current;
}

export function getConfig(): AppConfig {
  if (!current) throw new Error('Config not loaded yet');
  return current;
}
