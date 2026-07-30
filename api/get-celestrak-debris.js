import { twoline2satrec, propagate, gstime, eciToGeodetic, radiansToDegrees } from 'satellite.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  try {
    // 1. Fetch real debris from CelesTrak (e.g., Fengyun 1C debris or general rocket bodies)
    const url = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=1999-025&FORMAT=JSON';
    const celestrakRes = await fetch(url);
    const catalog = await celestrakRes.json();

    // 2. Fetch all claimed debris from Supabase
    const { data: claims } = await supabase.from('global_registry').select('norad_id, dedication_name');
    const claimMap = new Map(claims?.map(c => [String(c.norad_id), c.dedication_name]) || []);

    const now = new Date();
    const gmst = gstime(now);

    // 3. Process top ~50 objects and propagate live positions
    const liveObjects = catalog.slice(0, 50).map(obj => {
      if (!obj.TLE_LINE1 || !obj.TLE_LINE2) return null;

      const satrec = twoline2satrec(obj.TLE_LINE1, obj.TLE_LINE2);
      const posVel = propagate(satrec, now);
      if (!posVel.position) return null;

      const geo = eciToGeodetic(posVel.position, gmst);
      
      const noradId = String(obj.NORAD_CAT_ID);

      return {
        noradId: noradId,
        officialName: obj.OBJECT_NAME,
        type: obj.OBJECT_TYPE || 'DEBRIS',
        inclination: obj.INCLINATION,
        period: obj.PERIOD,
        lat: radiansToDegrees(geo.latitude),
        lng: radiansToDegrees(geo.longitude),
        altKm: Math.round(geo.height),
        isClaimed: claimMap.has(noradId),
        claimedBy: claimMap.get(noradId) || null
      };
    }).filter(Boolean);

    res.status(200).json(liveObjects);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch space debris' });
  }
}
