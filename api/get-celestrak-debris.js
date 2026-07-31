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

const DEBRIS_GROUPS = [
  'cosmos-1408-debris',
  'cosmos-2251-debris',
  'fengyun-1c-debris',
  'iridium-33-debris'
];

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
    for (const group of DEBRIS_GROUPS) {
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

    // Cap how many objects we render — keep the scene light and avoid
    // hammering the CelesTrak API on every cold start.
    const sample = allObjects
      .filter(o => typeof o.MEAN_MOTION === 'number' && o.NORAD_CAT_ID)
      .sort(() => 0.5 - Math.random())
      .slice(0, 40);

    const processed = sample.map(o => {
      const altKm = altitudeFromMeanMotion(o.MEAN_MOTION);
      const regime = classifyRegime(altKm);
      return {
        noradId: o.NORAD_CAT_ID,
        officialName: o.OBJECT_NAME || 'Unidentified Object',
        altKm,
        regime,
        tierLabel: (o.sourceGroup || 'debris').replace(/-/g, ' ').toUpperCase()
      };
    });

    cache = { data: processed, timestamp: Date.now() };
    return res.status(200).json(processed);
  } catch (err) {
    console.error('get-celestrak-debris error:', err);
    if (cache.data) return res.status(200).json(cache.data);
    return res.status(500).json({ error: 'Failed to fetch debris data' });
  }
};
