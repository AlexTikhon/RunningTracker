// WGS84 geodesy for the GPS trace tools (D10): Vincenty's inverse and direct formulae.
//
// The sanitizer turns a point into a geodesic distance and azimuth from an origin, which is an azimuthal-equidistant
// local frame on the WGS84 ellipsoid (the same projection family the display simplifier uses in PostGIS). Distances
// from the origin are exact; between two other points the error is second order in the extent, below 1e-5 relative
// within 10 km. The formulae are accurate to about a millimetre and converge for every pair of points that is not
// nearly antipodal, which the trace tools exclude by bounding a trace to 50 km.

const A = 6_378_137;
const F = 1 / 298.257223563;
const B = (1 - F) * A;
const MAX_ITERATIONS = 200;
const TOLERANCE = 1e-12;

export interface GeographicPoint {
  readonly latitude: number;
  readonly longitude: number;
}

export interface LocalPoint {
  readonly xM: number;
  readonly yM: number;
}

const toRad = (degrees: number) => (degrees * Math.PI) / 180;
const toDeg = (radians: number) => (radians * 180) / Math.PI;

function normalizeLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

interface InverseSolution {
  readonly azimuthRad: number;
  readonly distanceM: number;
}

function inverse(from: GeographicPoint, to: GeographicPoint): InverseSolution {
  if (from.latitude === to.latitude && from.longitude === to.longitude) {
    return { azimuthRad: 0, distanceM: 0 };
  }
  const u1 = Math.atan((1 - F) * Math.tan(toRad(from.latitude)));
  const u2 = Math.atan((1 - F) * Math.tan(toRad(to.latitude)));
  const l = toRad(normalizeLongitude(to.longitude - from.longitude));
  const sinU1 = Math.sin(u1);
  const cosU1 = Math.cos(u1);
  const sinU2 = Math.sin(u2);
  const cosU2 = Math.cos(u2);

  let lambda = l;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cosSqAlpha = 0;
  let cos2SigmaM = 0;
  let converged = false;
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.hypot(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    const c = (F / 16) * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
    const previous = lambda;
    lambda =
      l +
      (1 - c) *
        F *
        sinAlpha *
        (sigma + c * sinSigma * (cos2SigmaM + c * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - previous) < TOLERANCE) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    throw new Error('The geodesic between two points did not converge; they are too far apart for the trace tools');
  }

  const uSq = (cosSqAlpha * (A * A - B * B)) / (B * B);
  const bigA = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const bigB = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    bigB *
    sinSigma *
    (cos2SigmaM +
      (bigB / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (bigB / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  const sinLambda = Math.sin(lambda);
  const cosLambda = Math.cos(lambda);
  return {
    azimuthRad: Math.atan2(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda),
    distanceM: B * bigA * (sigma - deltaSigma),
  };
}

function direct(from: GeographicPoint, azimuthRad: number, distanceM: number): GeographicPoint {
  const sinAlpha1 = Math.sin(azimuthRad);
  const cosAlpha1 = Math.cos(azimuthRad);
  const tanU1 = (1 - F) * Math.tan(toRad(from.latitude));
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
  const sinU1 = tanU1 * cosU1;
  const sigma1 = Math.atan2(tanU1, cosAlpha1);
  const sinAlpha = cosU1 * sinAlpha1;
  const cosSqAlpha = 1 - sinAlpha * sinAlpha;
  const uSq = (cosSqAlpha * (A * A - B * B)) / (B * B);
  const bigA = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const bigB = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

  let sigma = distanceM / (B * bigA);
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    const sinSigma = Math.sin(sigma);
    const cosSigma = Math.cos(sigma);
    const deltaSigma =
      bigB *
      sinSigma *
      (cos2SigmaM +
        (bigB / 4) *
          (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            (bigB / 6) *
              cos2SigmaM *
              (-3 + 4 * sinSigma * sinSigma) *
              (-3 + 4 * cos2SigmaM * cos2SigmaM)));
    const next = distanceM / (B * bigA) + deltaSigma;
    const done = Math.abs(next - sigma) < TOLERANCE;
    sigma = next;
    if (done) {
      break;
    }
  }
  const sinSigma = Math.sin(sigma);
  const cosSigma = Math.cos(sigma);
  const cos2SigmaM = Math.cos(2 * sigma1 + sigma);

  const x = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
  const latitude = Math.atan2(
    sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
    (1 - F) * Math.hypot(sinAlpha, x),
  );
  const lambda = Math.atan2(sinSigma * sinAlpha1, cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1);
  const c = (F / 16) * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
  const l =
    lambda -
    (1 - c) *
      F *
      sinAlpha *
      (sigma + c * sinSigma * (cos2SigmaM + c * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
  return {
    latitude: toDeg(latitude),
    longitude: normalizeLongitude(from.longitude + toDeg(l)),
  };
}

/** Geodesic distance in metres between two WGS84 points. */
export function geodesicDistanceM(from: GeographicPoint, to: GeographicPoint): number {
  return inverse(from, to).distanceM;
}

/** Geodesic distance and azimuth from `origin` become east (`xM`) and north (`yM`) metres. */
export function toLocalMetres(origin: GeographicPoint, point: GeographicPoint): LocalPoint {
  const { azimuthRad, distanceM } = inverse(origin, point);
  if (distanceM === 0) {
    return { xM: 0, yM: 0 };
  }
  return { xM: distanceM * Math.sin(azimuthRad), yM: distanceM * Math.cos(azimuthRad) };
}

/** The inverse of {@link toLocalMetres}: places local metres around `anchor`. */
export function fromLocalMetres(anchor: GeographicPoint, point: LocalPoint): GeographicPoint {
  const distanceM = Math.hypot(point.xM, point.yM);
  if (distanceM === 0) {
    return { latitude: anchor.latitude, longitude: anchor.longitude };
  }
  return direct(anchor, Math.atan2(point.xM, point.yM), distanceM);
}
