import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { NEIGHBORS } from '@/lib/regions';
import { dedupeByTier } from '@/lib/tier';

const COLS = 'id, name, sido, gu, dong, pyeong, pyeong_supply, area_sqm, avg_deposit, year_built, hh, deal_count, deal_count_12m, latest_date, oldest_date, freshness, latest_deposit, latest_contract_date, size_tier, size_label, tier_deal_count_12m';

// 화면에 내보내는 한 건. 평형 표시와 거래량은 평형 구간 기준이다
// (전용 84㎡ → 통칭 34평, 거래량은 쪼개진 면적들을 합친 값).
type Row = Record<string, any>;
const toItem = (r: Row) => ({
  id: r.id, name: r.name, sido: r.sido, gu: r.gu, dong: r.dong,
  price: Number(r.avg_deposit),
  pyeong: r.pyeong_supply,
  area: Math.round(Number(r.area_sqm)),
  sizeTier: r.size_tier, sizeLabel: r.size_label,
  year: r.year_built, hh: r.hh,
  km: null, mins: null,
  dealCount: r.deal_count, annualDeals: r.tier_deal_count_12m,
  latestDate: r.latest_date, freshness: r.freshness,
  latestPrice: Number(r.latest_deposit),
  latestFloor: null,
  latestContractDate: r.latest_contract_date,
});

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

  // 같은 단지의 다른 평형. 59㎡와 84㎡는 보증금이 크게 벌어져 본 목록의 가격 band에
  // 안 걸리므로 band 없이 따로 받는다. 기준 단지가 없는 가격대 탐색 모드에서는 건너뛴다.
  //
  // 기준 단지의 행 하나(neq id)만 빼면 안 된다. 같은 34평이 84.40·84.74·84.97로
  // 쪼개져 있으면 나머지 13개가 "다른 평형"으로 올라온다. 구간째로 빼야 한다.
  const sameComplexQuery = base
    ? supabase
        .from('apt_rent_prices')
        .select(COLS)
        .eq('name', String(base.name))
        .eq('gu', String(base.gu))
        .eq('dong', String(base.dong))
        .neq('size_tier', Number(base.size_tier))
        .order('area_sqm')
    : null;

  const [{ data: rows, error: re }, sameRes] = await Promise.all([
    query.limit(500),
    sameComplexQuery ?? Promise.resolve({ data: [], error: null }),
  ]);
  if (re) return NextResponse.json({ error: re.message }, { status: 500 });

  // 단지당 1개 (기준가와 가장 가까운 평형)
  const complexMap = new Map<string, typeof rows[0]>();
  for (const r of (rows ?? [])) {
    // 기준 단지 본인만 뺀다. 이름만 비교하면 다른 구·동의 동명 단지까지 사라진다
    // (현대·주공·e편한세상처럼 흔한 이름은 전국에 널려 있다).
    if (base && r.name === base.name && r.gu === base.gu && r.dong === base.dong) continue;
    const key = `${r.name}||${r.gu}||${r.dong}`;
    const cur = complexMap.get(key);
    if (!cur || Math.abs(Number(r.avg_deposit) - myPrice) < Math.abs(Number(cur.avg_deposit) - myPrice)) {
      complexMap.set(key, r);
    }
  }

  const asc = dir === 'asc';
  const sorted = Array.from(complexMap.values()).sort((a, b) => {
    let v = 0;
    if      (sort === 'diff')  v = Math.abs(Number(a.avg_deposit) - myPrice) - Math.abs(Number(b.avg_deposit) - myPrice);
    else if (sort === 'price') v = Number(a.avg_deposit) - Number(b.avg_deposit);
    else if (sort === 'area')  v = Number(a.pyeong) - Number(b.pyeong);
    else if (sort === 'year')  v = (a.year_built ?? 0) - (b.year_built ?? 0);
    // 거래량은 구간 합계로 비교한다. 행별 값은 같은 평형이 쪼개진 만큼 나뉘어 있어
    // 파편이 많은 단지일수록 거래가 적어 보인다.
    else if (sort === 'deals') v = Number(a.tier_deal_count_12m ?? 0) - Number(b.tier_deal_count_12m ?? 0);
    else                       v = Math.abs(Number(a.avg_deposit) - myPrice) - Math.abs(Number(b.avg_deposit) - myPrice);
    return asc ? v : -v;
  });

  const total = sorted.length;
  const items = sorted.slice(0, (page + 1) * 3).map(toItem);

  const basePayload = priceMode
    ? { id: 0, name: '', sido: sidoParam, gu: guParam, dong: '', price: myPrice,
        pyeong: 0, area: 0, sizeTier: 0, sizeLabel: '', year: null, hh: null,
        dealCount: 0, annualDeals: 0, latestDate: '', freshness: 'fresh_high' as const,
        latestPrice: 0, latestFloor: null, latestContractDate: '',
        priceMode: true }
    : { ...toItem(base!), price: myPrice,
        freshness: base!.freshness as 'fresh_high'|'fresh_mid'|'fresh_low'|'scarce',
        priceMode: false };

  const sameComplex = dedupeByTier(sameRes.data ?? []).map(toItem);

  return NextResponse.json({
    base: basePayload,
    total, items, sameComplex,
  });
}
