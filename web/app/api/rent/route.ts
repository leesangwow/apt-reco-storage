import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { NEIGHBORS } from '@/lib/regions';

const COLS = 'id, name, sido, gu, dong, pyeong, area_sqm, avg_deposit, year_built, hh, deal_count, latest_date, oldest_date, freshness, latest_deposit, latest_contract_date';

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const aptId           = Number(p.get('aptId'));
  const scope           = p.get('scope')           ?? 'gu';
  const sort            = p.get('sort')            ?? 'diff';
  const dir             = p.get('dir')             ?? 'asc';
  const page            = Number(p.get('page')     ?? '0');
  const band            = p.get('band')            ?? '5%';
  const freshnessFilter = p.get('freshnessFilter');
  const regionId        = p.get('regionId');

  // 기준 아파트 (apt_rent_prices 뷰에서 조회)
  const { data: base, error: be } = await supabase
    .from('apt_rent_prices')
    .select(COLS)
    .eq('id', aptId)
    .single();

  if (be || !base) return NextResponse.json({ error: 'base apt not found in rent data' }, { status: 404 });

  const myPrice    = Number(base.avg_deposit);
  const PRICE_BAND = band === '5%'  ? myPrice * 0.05
                   : band === '10%' ? myPrice * 0.1
                   : Number(band);

  let query = supabase
    .from('apt_rent_prices')
    .select(COLS)
    .neq('name', base.name)
    .gte('avg_deposit', myPrice - PRICE_BAND)
    .lte('avg_deposit', myPrice + PRICE_BAND);

  // 범위 필터
  if (regionId) {
    if (regionId.includes('/')) {
      const [sido, gu] = regionId.split('/');
      query = query.eq('sido', sido).eq('gu', gu);
    } else {
      query = query.eq('sido', regionId);
    }
  } else {
    switch (scope) {
      case 'dong':
        query = query.eq('sido', base.sido).eq('gu', base.gu).eq('dong', base.dong);
        break;
      case 'gu':
        query = query.eq('sido', base.sido).eq('gu', base.gu);
        break;
      case 'all':
        query = query.eq('sido', base.sido);
        break;
      case 'neighbors':
        const neighborSidos = NEIGHBORS[base.sido] ?? [];
        query = neighborSidos.length > 0
          ? query.in('sido', neighborSidos)
          : query.eq('sido', base.sido);
        break;
    }
  }

  if (freshnessFilter === 'fresh_high') {
    query = query.eq('freshness', 'fresh_high');
  } else if (freshnessFilter === 'fresh_mid_up') {
    query = query.in('freshness', ['fresh_high', 'fresh_mid']);
  }

  const { data: rows, error: re } = await query.limit(500);
  if (re) return NextResponse.json({ error: re.message }, { status: 500 });

  // 단지당 1개 (기준가와 가장 가까운 평형)
  const complexMap = new Map<string, typeof rows[0]>();
  for (const r of (rows ?? [])) {
    const key = `${r.name}||${r.gu}||${r.dong}`;
    const cur = complexMap.get(key);
    if (!cur || Math.abs(Number(r.avg_deposit) - myPrice) < Math.abs(Number(cur.avg_deposit) - myPrice)) {
      complexMap.set(key, r);
    }
  }

  const asc = dir === 'asc';
  const sorted = Array.from(complexMap.values()).sort((a, b) => {
    let v = 0;
    if      (sort === 'diff') v = Math.abs(Number(a.avg_deposit) - myPrice) - Math.abs(Number(b.avg_deposit) - myPrice);
    else if (sort === 'area') v = Number(a.pyeong) - Number(b.pyeong);
    else if (sort === 'year') v = (a.year_built ?? 0) - (b.year_built ?? 0);
    else                      v = Math.abs(Number(a.avg_deposit) - myPrice) - Math.abs(Number(b.avg_deposit) - myPrice);
    return asc ? v : -v;
  });

  const total = sorted.length;
  const items = sorted.slice(0, (page + 1) * 3).map(r => ({
    id: r.id, name: r.name, sido: r.sido, gu: r.gu, dong: r.dong,
    price: Number(r.avg_deposit),
    pyeong: Math.round(Number(r.pyeong)),
    area: Math.round(Number(r.area_sqm)),
    year: r.year_built, hh: r.hh,
    km: null, mins: null,
    dealCount: r.deal_count,
    latestDate: r.latest_date,
    freshness: r.freshness,
    latestPrice: Number(r.latest_deposit),
    latestFloor: null,
    latestContractDate: r.latest_contract_date,
  }));

  return NextResponse.json({
    base: {
      id: base.id, name: base.name, sido: base.sido, gu: base.gu, dong: base.dong,
      price: myPrice,
      pyeong: Math.round(Number(base.pyeong)),
      area: Math.round(Number(base.area_sqm)),
      year: base.year_built, hh: base.hh,
      dealCount: base.deal_count,
      latestDate: base.latest_date,
      freshness: base.freshness,
      latestPrice: Number(base.latest_deposit),
      latestFloor: null,
      latestContractDate: base.latest_contract_date,
      priceMode: false,
    },
    total, items,
  });
}
