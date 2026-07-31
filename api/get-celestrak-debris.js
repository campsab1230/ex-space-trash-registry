export default async function handler(req, res) {
  try {
    const response = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json');
    if (!response.ok) throw new Error('CelesTrak unavailable');
    
    const data = await response.json();
    // Return a sliced set of satellite objects with assigned orbital regimes
    const parsed = data.slice(0, 30).map(sat => {
      const altKm = sat.MEAN_MOTION ? Math.round(Math.pow(86400 / (sat.MEAN_MOTION * 2 * Math.PI), 2/3) * 9.81 - 6371) : 500;
      let regime = 'LEO';
      if (altKm > 2000 && altKm <= 35000) regime = 'MEO';
      if (altKm > 35000) regime = 'GEO';

      return {
        noradId: sat.NORAD_CAT_ID,
        officialName: sat.OBJECT_NAME,
        regime,
        altKm: Math.max(altKm, 200),
      };
    });

    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
