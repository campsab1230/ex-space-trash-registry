import { ImageResponse } from '@vercel/og';
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'nodejs' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: obj } = await supabase.from('claims').select('*').eq('id', id).single();

  return new ImageResponse(
    (
      <div style={{
        height: '100%', width: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', background: '#0a0a1a', color: 'white',
      }}>
        <div style={{ fontSize: 28, opacity: 0.6 }}>NORAD OBJECT #{obj.norad_id}</div>
        <div style={{ fontSize: 64, fontWeight: 700, marginTop: 20 }}>{obj.custom_name}</div>
        <div style={{ fontSize: 24, opacity: 0.5, marginTop: 20 }}>officially dedicated to the void</div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
