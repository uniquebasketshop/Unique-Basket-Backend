import { AppError } from '../utils/errors';
import { Coordinates, isMapsShortLink, parseMapsCoordinates } from '../utils/mapsLocation';

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 5000;
const MAX_BODY_CHARS = 1_000_000;

/**
 * Only Google hosts are ever contacted (the server must not be usable to fetch arbitrary URLs).
 */
export function isAllowedGoogleHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'maps.app.goo.gl' ||
    host === 'goo.gl' ||
    host === 'google.com' ||
    host.endsWith('.google.com') ||
    host === 'google.co.in' ||
    host.endsWith('.google.co.in')
  );
}

const NOT_FOUND = () =>
  new AppError(
    422,
    'LOCATION_NOT_FOUND',
    'No location found in this link. Paste a Google Maps link to the store, or its "latitude, longitude".',
  );

/** A Google place page names its pin in the preview image URL: …center=22.27%2C70.76… */
function coordinatesInPage(html: string): Coordinates | null {
  const match = html.match(/(?:center|markers)=(-?\d{1,3}\.\d+)(?:%2C|,)(-?\d{1,3}\.\d+)/i);
  return match ? parseMapsCoordinates(`${match[1]}, ${match[2]}`) : null;
}

/**
 * Turns a pasted store location into coordinates: "lat, lng", a full Google Maps URL, or a
 * maps.app.goo.gl share link (followed on the server, Google hosts only, max 5 redirects).
 */
export async function resolveStoreLocation(input: string, fetchImpl: typeof fetch = fetch): Promise<Coordinates> {
  const direct = parseMapsCoordinates(input);
  if (direct) return direct;
  if (!isMapsShortLink(input)) throw NOT_FOUND();

  let url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:' || !isAllowedGoogleHost(url.hostname)) throw NOT_FOUND();

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new AppError(502, 'LOCATION_LOOKUP_FAILED', 'Could not open the Google Maps link. Please try again.');
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url);
      const found = parseMapsCoordinates(url.toString());
      if (found) return found;
      continue;
    }

    if (response.ok) {
      const html = (await response.text()).slice(0, MAX_BODY_CHARS);
      const found = parseMapsCoordinates(url.toString()) ?? coordinatesInPage(html);
      if (found) return found;
    }
    throw NOT_FOUND();
  }
  throw NOT_FOUND();
}
