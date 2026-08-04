// api/get-celestrak-debris.js
//
// Pulls REAL debris objects from CelesTrak's public catalog, computes a real
// orbital altitude from each object's mean motion, and classifies it into
// LEO / MEO / GEO. Results are cached in memory for CACHE_TTL so every
// visitor within that window sees the SAME objects with the SAME NORAD IDs
// — that's what makes a "claim" mean something, instead of being a random
// number regenerated on every page load.
//
// IMPORTANT: because we only render a random SAMPLE of the full catalog
// (there are thousands of debris fragments — rendering all of them would
// crash the browser), an object that's already been CLAIMED must be pinned
// into every response regardless of the random draw. Otherwise a buyer's
// own purchase could silently vanish from the scene the next time the
// cache refreshes and pulls a different random sample — which is exactly
// what was happening before this fix.
//
// Deploy target: Vercel serverless function (Node.js runtime).

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

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

// Best-effort recovery of altitude/regime from a registry row's stored
// `stat` text (e.g. "COSMOS 2251 DEBRIS • Alt: 673 km") for the rare case
// where a claimed object can no longer be found in the live CelesTrak
// groups (catalog reshuffle, decayed object, etc.) — better to show it
// with a recovered/best-guess altitude than to drop it from the scene.
function recoverAltFromStat(stat) {
  if (!stat) return null;
  const match = String(stat).match(/Alt:\s*([\d,]+)\s*km/i);
  if (!match) return null;
  return parseInt(match[1].replace(/,/g, ''), 10);
}

export default async function handler(req, res) {
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

    // -------------------------------------------------------------------
    // Pin every already-claimed object into the response, regardless of
    // whether the random sample above happened to include it. This is
    // what stops a buyer's own purchase from disappearing from the scene.
    // -------------------------------------------------------------------
    let claimedRows = [];
    try {
      const { data, error } = await supabase
        .from('global_registry')
        .select('norad_id, debris_name, stat');
      if (error) throw error;
      claimedRows = data || [];
    } catch (claimedErr) {
      // If this lookup fails, we still return the normal sample rather
      // than failing the whole endpoint — pinning is a "nice to have"
      // layered on top, not a hard dependency for the scene to render.
      console.error('Failed to fetch claimed items for pinning:', claimedErr.message);
    }

    const alreadyIncluded = new Set(processed.map(o => String(o.noradId)));

    for (const row of claimedRows) {
      const noradIdStr = String(row.norad_id);
      if (alreadyIncluded.has(noradIdStr)) continue; // already in the sample, nothing to do

      // First choice: find this exact object in the full live-fetched set
      // (not just the random sample) so it gets a real, current altitude.
      const liveMatch = withAltitude.find(o => String(o.NORAD_CAT_ID) === noradIdStr);
      if (liveMatch) {
        processed.push({
          noradId: liveMatch.NORAD_CAT_ID,
          officialName: liveMatch.OBJECT_NAME || row.debris_name || 'Unidentified Object',
          altKm: liveMatch.altKm,
          regime: liveMatch.regime,
          tierLabel: (liveMatch.sourceGroup || 'debris').replace(/-/g, ' ').toUpperCase()
        });
      } else {
        // Fallback: object no longer surfaced by our live groups — recover
        // what we can from the registry's own stored data so it still shows.
        const recoveredAlt = recoverAltFromStat(row.stat);
        processed.push({
          noradId: row.norad_id,
          officialName: row.debris_name || 'Unidentified Object',
          altKm: recoveredAlt,
          regime: recoveredAlt ? classifyRegime(recoveredAlt) : 'LEO',
          tierLabel: 'CLAIMED RECORD'
        });
      }
      alreadyIncluded.add(noradIdStr);
    }

    cache = { data: processed, timestamp: Date.now() };
    return res.status(200).json(processed);
  } catch (err) {
    console.error('get-celestrak-debris error:', err);
    if (cache.data) return res.status(200).json(cache.data);
    return res.status(500).json({ error: 'Failed to fetch debris data' });
  }
}
