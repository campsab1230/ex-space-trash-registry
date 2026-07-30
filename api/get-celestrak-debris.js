import { twoline2satrec, propagate, gstime, eciToGeodetic, radiansToDegrees } from 'satellite.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// CelesTrak endpoints covering low, medium, and high orbits
const CELESTRAK_SOURCES = [
  { name: 'LEO Debris', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=1999-025&FORMAT=JSON' }, // Fengyun 1C
  { name: 'GEO Debris', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=geo&FORMAT=JSON' },      // Geostationary
  { name: 'Rocket Bodies', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=glo-ops&FORMAT=JSON' } // GLONASS / Rocket bodies
];

/**
 * Pricing Engine based on Altitude & Object Type
 */
function calculatePriceAndTier(altKm, objectType, objectName) {
  let regime = 'LEO'; // Low Earth Orbit (< 2,000 km)
  let basePrice = 1.99;
  let tierLabel = 'Low-Orbit Paint Chip';

  if (altKm >= 2000 && altKm < 35000) {
    regime = 'MEO'; // Medium Earth Orbit
    basePrice = 4.99;
    tierLabel = 'Mid-Orbit Junk';
  } else if (altKm >= 35000) {
    regime = 'GEO'; // Geostationary Orbit (> 35,000 km)
    basePrice = 9.99;
    tierLabel = 'High-GEO Graveyard Debris';
  }

  // Surcharge for intact rocket bodies or high-profile satellite remains
  const isRocketBody = objectType === 'R/B' || objectName.includes('R/B');
  if (isRocketBody) {
    basePrice += 5.00;
    tierLabel = `Heavy ${regime} Booster Section`;
  }

  return {
    regime,
    price: parseFloat(basePrice.toFixed(2)),
    tierLabel
  };
}

export default async function handler(req, res) {
  try {
    // 1. Fetch debris data across all source URLs concurrently
    const responses = await Promise.all(CELESTRAK_SOURCES.map(src => fetch(src.url).then(r => r.json())));
    const catalog = responses.flat();

    // 2. Fetch all claimed debris from Supabase
    const { data: claims } = await supabase.from('global_registry').select('norad_id, dedication_name');
    const claimMap = new Map(claims?.map(c => [String(c.norad_id), c.dedication_name]) || []);

    const now = new Date();
    const gmst = gstime(now);

    // 3. Process and filter objects across different orbital regimes
    const liveObjects = catalog.slice(0, 100).map(obj => {
      if (!obj.TLE_LINE1 || !obj.TLE_LINE2) return null;

      const satrec = twoline2satrec(obj.TLE_LINE1, obj.TLE_LINE2);
      const posVel = propagate(satrec, now);
      if (!posVel.position) return null;

      const geo = eciToGeodetic(posVel.position, gmst);
      const altKm = Math.round(geo.height);
      const noradId = String(obj.NORAD_CAT_ID);

      const pricing = calculatePriceAndTier(altKm, obj.OBJECT_TYPE, obj.OBJECT_NAME);

      return {
        noradId: noradId,
        officialName: obj.OBJECT_NAME,
        type: obj.OBJECT_TYPE || 'DEBRIS',
        lat: radiansToDegrees(geo.latitude),
        lng: radiansToDegrees(geo.longitude),
        altKm: altKm,
        regime: pricing.regime,
        price: pricing.price,
        tierLabel: pricing.tierLabel,
        isClaimed: claimMap.has(noradId),
        claimedBy: claimMap.get(noradId) || null
      };
    }).filter(Boolean);

    res.status(200).json(liveObjects);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch space debris' });
  }
}
