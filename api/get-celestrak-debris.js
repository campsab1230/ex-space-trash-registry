// api/get-celestrak-debris.js
//
// Pulls REAL debris objects from CelesTrak's public catalog, computes a real
// orbital altitude from each object's mean motion, and classifies it into
// LEO / MEO / GEO. Results are cached in memory for CACHE_TTL so every
// visitor within that window sees the SAME objects with the SAME NORAD IDs
// — that's what makes a "claim" mean something, instead of being a random
// number regenerated on every page load.
//
// Deploy target: Vercel serverless function (Node.js runtime).
// If you deploy elsewhere (Netlify, Cloudflare Workers, a plain Express
// server), the fetch/caching logic is the same — only the export shape
// (module.exports vs. a route handler) needs to change.

// Debris-specific groups (all LEO collision/ASAT clouds — great debris flavor,
// but none of them reach past ~1,000km, which is why MEO/GEO never appeared).
const LEO_DEBRIS_GROUPS = [
  'cosmos-1408-debris',
  'cosmos-2251-debris',
  'fengyun-1c-debris',
  'iridium-33-debris'
];

// Sources that actually reach into MEO/GEO altitude:
//  - 'analyst': CelesTrak's uncorrelated/unidentified tracked object catalog,
//    spans every altitude band and is thematically perfect ("unidentified
//    debris") — nothing in it is operational infrastructure.
//  - 'geo': the geosynchronous belt. This one DOES include active,
//    operational satellites, so we filter those out below (OPS_STATUS_CODE)
//    to avoid ever letting someone "claim" a live comms/weather satellite.
const HIGH_ALTITUDE_GROUPS = ['analyst', 'geo'];

const ALL_GROUPS = [...LEO_DEBRIS_GROUPS, ...HIGH_ALTITUDE_GROUPS];

// Operational status codes CelesTrak uses that mean "this is a live,
// in-service satellite" — never surface these from the 'geo' group.
const OPERATIONAL_STATUS_CODES = new Set(['+', 'P', 'B', 'S']);

const EARTH_RADIUS_KM = 6371;
const EARTH_MU = 398600.4418; // km^3/s^2

let cache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function altitudeFromMeanMotion(meanMotionRevPerDay) {
  const periodSeconds = 86400 / meanMotionRevPerDay;
  const semiMajorAxisKm = Math.cbrt(EARTH_MU * Math.pow(periodSeconds / (2 * Math.PI), 2));
  return Math.round(semiMajorAxisKm - EARTH_RADIUS_KM);
}

function classifyRegime(altKm) {
  if (altKm > 35000) return 'GEO';
  if (altKm > 2000) return 'MEO';
  return 'LEO';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  try {
    if (cache.data && (Date.now() - cache.timestamp) < CACHE_TTL_MS) {
      return res.status(200).json(cache.data);
    }

    let allObjects = [];
    for (const group of ALL_GROUPS) {
      try {
        const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;
        const r = await fetch(url);
        if (!r.ok) continue;
        const objs = await r.json();
        if (Array.isArray(objs)) {
          allObjects = allObjects.concat(objs.map(o => ({ ...o, sourceGroup: group })));
        }
      } catch (groupErr) {
        console.warn(`Failed to fetch group ${group}:`, groupErr.message);
      }
    }

    if (allObjects.length === 0) {
      // Serve stale cache if we have it rather than an empty scene
      if (cache.data) return res.status(200).json(cache.data);
      return res.status(502).json({ error: 'Could not reach CelesTrak' });
    }

    // Never surface a currently-operational satellite as "claimable trash" —
    // only applies to the 'geo' group, since 'analyst' and the debris groups
    // are inherently non-operational by definition.
    const safeObjects = allObjects.filter(o => {
      if (o.sourceGroup !== 'geo') return true;
      const status = o.OPS_STATUS_CODE;
      return !status || !OPERATIONAL_STATUS_CODES.has(status);
    });

    const withAltitude = safeObjects
      .filter(o => typeof o.MEAN_MOTION === 'number' && o.MEAN_MOTION > 0 && o.NORAD_CAT_ID)
      .map(o => {
        const altKm = altitudeFromMeanMotion(o.MEAN_MOTION);
        return { ...o, altKm, regime: classifyRegime(altKm) };
      });

    // Stratified sampling — plain random sampling would get swamped by the
    // LEO debris clouds (thousands of fragments) and MEO/GEO objects
    // (usually a few dozen) would rarely get picked at all. Guarantee a mix.
    function sampleRegime(regime, count) {
      const pool = withAltitude.filter(o => o.regime === regime);
      return pool.sort(() => 0.5 - Math.random()).slice(0, count);
    }

    const sample = [
      ...sampleRegime('LEO', 20),
      ...sampleRegime('MEO', 10),
      ...sampleRegime('GEO', 10),
    ];

    const meoCount = sample.filter(o => o.regime === 'MEO').length;
    const geoCount = sample.filter(o => o.regime === 'GEO').length;
    if (meoCount === 0 || geoCount === 0) {
      console.warn(`get-celestrak-debris: low/no coverage — MEO=${meoCount}, GEO=${geoCount}. Check that the 'analyst' and 'geo' CelesTrak groups are returning data.`);
    }

    const processed = sample.map(o => ({
      noradId: o.NORAD_CAT_ID,
      officialName: o.OBJECT_NAME || 'Unidentified Object',
      altKm: o.altKm,
      regime: o.regime,
      tierLabel: (o.sourceGroup || 'debris').replace(/-/g, ' ').toUpperCase()
    }));

    cache = { data: processed, timestamp: Date.now() };
    return res.status(200).json(processed);
  } catch (err) {
    console.error('get-celestrak-debris error:', err);
    if (cache.data) return res.status(200).json(cache.data);
    return res.status(500).json({ error: 'Failed to fetch debris data' });
  }
};
