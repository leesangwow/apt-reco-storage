import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (!q) return NextResponse.json([]);

  // 공백으로 분리, 각 토큰이 name·gu·dong·sido 중 하나라도 포함되면 매칭
  const tokens = q.split(/\s+/).filter(Boolean);

  let query = supabase
    .from('apt_prices')
    .select('id, name, sido, gu, dong, year_built, hh, pyeong_supply, area_sqm, avg_price, deal_count, size_tier, size_label, tier_deal_count_12m')
    .limit(300);

  for (const tok of tokens) {
    query = query.or(`name.ilike.%${tok}%,gu.ilike.%${tok}%,dong.ilike.%${tok}%,sido.ilike.%${tok}%`);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 단지별 그룹핑 (name + gu + dong), 그 안에서 평형 구간별로 한 개씩.
  //
  // 구간으로 접지 않으면 같은 평형이 여러 번 나온다. 해밀마을1단지 34평은 전용면적이
  // 84.40~84.97로 14개 행이라 "26평"이 14개 나열됐다. size_tier로 접으면 34평 하나다.
  type Variant = { aptId: number; pyeong: number; area: number; price: number;
                   label: string; annualDeals: number; dealCount: number; areaRaw: number };
  const map = new Map<string, {
    name: string; sido: string; gu: string; dong: string;
    year_built: number | null; hh: number | null;
    variants: Map<number, Variant>;   // size_tier → 대표 1개
  }>();

  for (const r of (data ?? [])) {
    const key = `${r.name}||${r.gu}||${r.dong}`;
    if (!map.has(key)) {
      map.set(key, {
        name: r.name, sido: r.sido, gu: r.gu, dong: r.dong,
        year_built: r.year_built, hh: r.hh, variants: new Map(),
      });
    }
    const variants = map.get(key)!.variants;
    const cur = variants.get(r.size_tier);
    // 대표는 6개월 거래가 가장 많은 면적으로 고른다. 파편 중 1건짜리가 대표가 되면
    // 평균가가 그 한 건에 좌우된다. 동률이면 작은 면적으로 고정해 매번 같은 결과가 나오게 한다.
    const areaRaw = Number(r.area_sqm);
    const better = !cur
      || r.deal_count > cur.dealCount
      || (r.deal_count === cur.dealCount && areaRaw < cur.areaRaw);
    if (better) {
      variants.set(r.size_tier, {
        aptId: r.id,
        pyeong: r.pyeong_supply,
        area: Math.round(areaRaw),
        areaRaw,
        price: Number(r.avg_price),
        label: r.size_label,
        annualDeals: r.tier_deal_count_12m,
        dealCount: r.deal_count,
      });
    }
  }

  const result = Array.from(map.values()).map(c => ({
    ...c,
    variants: Array.from(c.variants.values())
      .sort((a, b) => a.areaRaw - b.areaRaw)
      .map(({ areaRaw: _drop, ...v }) => v),
  }));

  return NextResponse.json(result);
}
