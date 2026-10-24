/**
 * Reads coordinates from what an admin pastes as a store location (no API key, no Maps SDK):
 * "22.2916, 70.7932" or a Google Maps URL (…!3d22.29!4d70.79, …/@22.29,70.79,17z,
 * ?q= / query= / ll= / destination= / center=). Same rules as the admin panel's parseLocation.
 */
export interface Coordinates {
  latitude: number;
  longitude: number;
}

const NUMBER = '(-?\\d{1,3}(?:\\.\\d+)?)';
const PATTERNS = [
  new RegExp(`!3d${NUMBER}!4d${NUMBER}`), // exact place pin
  new RegExp(`@${NUMBER},${NUMBER}`), // map view centre
  new RegExp(`[?&](?:q|query|ll|destination|center)=${NUMBER}\\s*,\\s*${NUMBER}`),
  new RegExp(`^${NUMBER}\\s*,\\s*${NUMBER}$`), // plain "lat, lng"
];

const round = (n: number) => Number(n.toFixed(7));

export function parseMapsCoordinates(input: string): Coordinates | null {
  const text = input.trim();
  if (!text) return null;
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // not URL-encoded
  }
  for (const pattern of PATTERNS) {
    const match = decoded.match(pattern);
    if (!match) continue;
    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      return { latitude: round(latitude), longitude: round(longitude) };
    }
  }
  return null;
}

/** maps.app.goo.gl/… or goo.gl/maps/… share links, which only redirect to the full URL. */
export function isMapsShortLink(input: string): boolean {
  return /^(https?:\/\/)?(maps\.app\.goo\.gl\/|goo\.gl\/maps\/)/i.test(input.trim());
}
