import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (!q) return NextResponse.json([]);

  // 공백으로 분리, 각 토큰이 name·gu·dong·sido 중 하나라도 포함되면 매칭
  const tokens = q.split(/\s+/).filter(Boolean);

  let query = supabase
    .from('apt_prices')
    .select('id, name, sido, gu, dong, year_built, hh, pyeong, area_sqm, avg_price')
    .limit(300);

  for (const tok of tokens) {
    query = query.or(`name.ilike.%${tok}%,gu.ilike.%${tok}%,dong.ilike.%${tok}%,sido.ilike.%${tok}%`);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 단지별 그룹핑 (name + gu + dong)
  const map = new Map<string, {
    name: string; sido: string; gu: string; dong: string;
    year_built: number | null; hh: number | null;
    variants: { aptId: number; pyeong: number; area: number; price: number }[];
  }>();

  for (const r of (data ?? [])) {
    const key = `${r.name}||${r.gu}||${r.dong}`;
    if (!map.has(key)) {
      map.set(key, {
        name: r.name, sido: r.sido, gu: r.gu, dong: r.dong,
        year_built: r.year_built, hh: r.hh, variants: [],
      });
    }
    map.get(key)!.variants.push({
      aptId: r.id,
      pyeong: Math.round(Number(r.pyeong)),
      area: Math.round(Number(r.area_sqm)),
      price: Number(r.avg_price),
    });
  }

  const result = Array.from(map.values()).map(c => ({
    ...c,
    variants: c.variants.sort((a, b) => a.area - b.area),
  }));

  return NextResponse.json(result);
}
