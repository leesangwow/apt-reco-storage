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

  // 가격대 탐색 모드
  const priceMode  = !aptId && !!p.get('price');
  const priceParam = Number(p.get('price') ?? '0');
  const sidoParam  = p.get('sido') ?? '';
  const guParam    = p.get('gu')   ?? '';

  let base: Record<string, unknown> | null = null;
  let myPrice = priceParam;

  if (!priceMode) {
    const { data, error: be } = await supabase
      .from('apt_rent_prices')
      .select(COLS)
      .eq('id', aptId)
      .single();
    if (be || !data) return NextResponse.json({ error: 'base apt not found in rent data' }, { status: 404 });
    base = data;
    myPrice = Number(base.avg_deposit);
  }

  const PRICE_BAND = band === '5%'  ? myPrice * 0.05
                   : band === '10%' ? myPrice * 0.1
                   : Number(band);

  let query = supabase
    .from('apt_rent_prices')
    .select(COLS)
    .gte('avg_deposit', myPrice - PRICE_BAND)
    .lte('avg_deposit', myPrice + PRICE_BAND);

  if (base) query = query.neq('name', String(base.name));

  // 범위 기준값
  const refSido = priceMode ? sidoParam : String(base!.sido);
  const refGu   = priceMode ? guParam   : String(base!.gu);
  const refDong = priceMode ? ''        : String(base!.dong);
  const sidoOnly = priceMode && !refGu;

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
        if (sidoOnly) query = query.eq('sido', refSido);
        else if (priceMode) query = query.eq('sido', refSido).eq('gu', refGu);
        else query = query.eq('sido', refSido).eq('gu', refGu).eq('dong', refDong);
        break;
      case 'gu':
        query = (sidoOnly || !refGu)
          ? query.eq('sido', refSido)
          : query.eq('sido', refSido).eq('gu', refGu);
        break;
      case 'all':
        query = query.eq('sido', refSido);
        break;
      case 'neighbors':
        const neighborSidos = NEIGHBORS[refSido] ?? [];
        query = neighborSidos.length > 0
          ? query.in('sido', neighborSidos)
          : query.eq('sido', refSido);
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

  const basePayload = priceMode
    ? { id: 0, name: '', sido: sidoParam, gu: guParam, dong: '', price: myPrice,
        pyeong: 0, area: 0, year: null, hh: null,
        dealCount: 0, latestDate: '', freshness: 'fresh_high' as const,
        latestPrice: 0, latestFloor: null, latestContractDate: '',
        priceMode: true }
    : { id: Number(base!.id), name: String(base!.name), sido: String(base!.sido),
        gu: String(base!.gu), dong: String(base!.dong), price: myPrice,
        pyeong: Math.round(Number(base!.pyeong)), area: Math.round(Number(base!.area_sqm)),
        year: base!.year_built as number | null, hh: base!.hh as number | null,
        dealCount: base!.deal_count as number, latestDate: String(base!.latest_date),
        freshness: base!.freshness as 'fresh_high'|'fresh_mid'|'fresh_low'|'scarce',
        latestPrice: Number(base!.latest_deposit), latestFloor: null,
        latestContractDate: String(base!.latest_contract_date), priceMode: false };

  return NextResponse.json({
    base: basePayload,
    total, items,
  });
}
