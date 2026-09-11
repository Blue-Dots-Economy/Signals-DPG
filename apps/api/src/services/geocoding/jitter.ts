/**
 * Deterministic geo-jitter for PRIVATE (PII) locations: offsets a coordinate by
 * a pseudo-random distance in [minMeters, maxMeters] at a pseudo-random bearing,
 * so the stored point is near — but never exactly on — the true location.
 *
 * Determinism (seed derived from the coordinate itself) is deliberate: the same
 * true location always maps to the same jittered point, so re-saving a profile
 * never drifts the pin and an observer cannot average repeated snapshots back to
 * the truth. See docs/superpowers/specs/2026-07-07-pii-location-jitter-design.md.
 *
 * The seed is keyed with a server secret (see `jitterCoordinate`) — the jittered
 * point is served publicly (map/search) and the algorithm is open-source, so
 * without a secret key an attacker could brute-force the ~1 m grid within
 * `maxMeters` of the stored point and match it back to the true coordinate.
 */

import { createHmac } from 'node:crypto';

export interface JitterableCoord {
  lat: number;
  lng: number;
  label?: string;
}

/** Metres per degree of latitude (constant); longitude scales by cos(lat). */
const METERS_PER_DEGREE = 111_320;

/**
 * mulberry32 PRNG — deterministic uniform [0, 1) sequence from a 32-bit seed.
 *
 * The `| 0` and `>>> 0` below are the algorithm, not a truncation shortcut: they
 * force 32-bit wraparound, which is what makes the sequence match every other
 * mulberry32 implementation. `Math.trunc` drops the fraction WITHOUT wrapping,
 * so swapping it in changes the output stream — and this PRNG seeds the PII
 * location jitter, where a stable mapping is the whole point (`jitterCoordinate`
 * must send the same true coordinate to the same pin every time, or re-saving a
 * profile visibly moves it on the map). A static analyser that flags `| 0` here
 * as "prefer Math.trunc" is pattern-matching the idiom without the semantics.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function jitterCoordinate(
  coord: JitterableCoord,
  minMeters: number,
  maxMeters: number,
  secret: Buffer | string,
): JitterableCoord {
  // Seed = HMAC(secret, "location-jitter:<lat5>,<lng5>") → first 4 bytes as uint32.
  // The 'location-jitter:' prefix domain-separates this use of the key from
  // PII-blob encryption. Determinism (same coord+secret → same point) is
  // preserved; without the secret the offset is unpredictable, so a publicly
  // served jittered point cannot be brute-forced back to the true coordinate.
  const seed = createHmac('sha256', secret)
    .update(`location-jitter:${coord.lat.toFixed(5)},${coord.lng.toFixed(5)}`)
    .digest()
    .readUInt32BE(0);
  const rng = mulberry32(seed);
  const u = rng();
  const v = rng();

  // Uniform over the annulus AREA (not biased toward the inner radius).
  const dist = Math.sqrt(u * (maxMeters ** 2 - minMeters ** 2) + minMeters ** 2);
  const theta = 2 * Math.PI * v;

  const dLat = (dist * Math.cos(theta)) / METERS_PER_DEGREE;
  const latRad = (coord.lat * Math.PI) / 180;
  // Equirectangular longitude scaling divides by cos(lat); undefined at the
  // poles (lat = ±90), which is out of domain for any real street address.
  const dLng = (dist * Math.sin(theta)) / (METERS_PER_DEGREE * Math.cos(latRad));

  const out: JitterableCoord = { lat: coord.lat + dLat, lng: coord.lng + dLng };
  if (coord.label !== undefined) out.label = coord.label;
  return out;
}
