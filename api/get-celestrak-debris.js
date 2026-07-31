import { twoline2satrec, propagate, gstime, eciToGeodetic, radiansToDegrees } from 'satellite.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CELESTRAK_SOURCES = [
  { regime: 'LEO', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=1999-025&FORMAT=JSON' },
  { regime: 'GEO', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=geo&FORMAT=JSON' }
];

export default async function handler(req, res) {
  try {
    const responses = await Promise.all(CELESTRAK_SOURCES.map(src => fetch(src.url).then(r => r.json())));
    const catalog = responses.flat();

    const { data: claims } = await supabase.from('global_registry').select('norad_id, dedication_name');
    const claimMap = new Map(claims?.map(c => [String(c.norad_id), c.dedication_name]) || []);

    const now = new Date();
    const gmst = gstime(now);

    const liveObjects = catalog.slice(0, 60).map(obj => {
      if (!obj.TLE_LINE1 || !obj.TLE_LINE2) return null;

      const satrec = twoline2satrec(obj.TLE_LINE1, obj.TLE_LINE2);
      const posVel = propagate(satrec, now);
      if (!posVel.position) return null;

      const geo = eciToGeodetic(posVel.position, gmst);
      const altKm = Math.round(geo.height);
      const noradId = String(obj.NORAD_CAT_ID);

      let regime = 'LEO';
      let price = 1.99;
      if (altKm >= 2000 && altKm < 35000) { regime = 'MEO'; price = 5.99; }
      else if (altKm >= 35000) { regime = 'GEO'; price = 9.99; }

      return {
        noradId,
        officialName: obj.OBJECT_NAME,
        altKm,
        regime,
        price,
        isClaimed: claimMap.has(noradId),
        claimedBy: claimMap.get(noradId) || null
      };
    }).filter(Boolean);

    res.status(200).json(liveObjects);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch debris data' });
  }
}
