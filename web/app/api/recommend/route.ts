import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { NEIGHBORS } from '@/lib/regions';
import { dedupeByTier } from '@/lib/tier';

const COLS = 'id, name, sido, gu, dong, pyeong, pyeong_supply, area_sqm, avg_price, year_built, hh, deal_count, deal_count_12m, latest_date, oldest_date, freshness, latest_price, latest_floor, latest_contract_date, size_tier, size_label, tier_deal_count_12m';

// 화면에 보여줄 단지 수 상한. 사용자가 100곳 넘게 훑어보는 일은 없다.
const MAX_COMPLEXES = 100;
// DB에서 받아올 행 수. 같은 단지의 여러 평형이 하나로 접히므로 상한보다 넉넉히 받는다.
const FETCH_ROWS = 500;

// 화면에 내보내는 한 건. 평형 표시와 거래량은 평형 구간 기준이다
// (전용 84㎡ → 통칭 34평, 거래량은 쪼개진 면적들을 합친 값).
type Row = Record<string, any>;
const toItem = (r: Row) => ({
  id: r.id, name: r.name, sido: r.sido, gu: r.gu, dong: r.dong,
  price: Number(r.avg_price),
  pyeong: r.pyeong_supply,
  area: Math.round(Number(r.area_sqm)),
  // 정렬 전용. area는 정수 ㎡로 반올림돼 있어 84.28과 84.74를 구분하지 못한다.
  areaExact: Number(r.area_sqm),
  sizeTier: r.size_tier, sizeLabel: r.size_label,
  year: r.year_built, hh: r.hh,
  km: null, mins: null,
  dealCount: r.deal_count, annualDeals: r.tier_deal_count_12m,
  latestDate: r.latest_date, freshness: r.freshness,
  latestPrice: Number(r.latest_price),
  latestFloor: r.latest_floor,
  latestContractDate: r.latest_contract_date,
});

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const aptId           = Number(p.get('aptId'));
  const scope           = p.get('scope')           ?? 'gu';
  const sort            = p.get('sort')            ?? 'diff';
  const dir             = p.get('dir')             ?? 'asc';
  const band            = p.get('band')            ?? '5%';
  const freshnessFilter = p.get('freshnessFilter');
  const regionId        = p.get('regionId');

  // 가격대 탐색 모드
  const priceMode = !aptId && !!p.get('price');
  const priceParam = Number(p.get('price') ?? '0');
  const sidoParam  = p.get('sido') ?? '';
  const guParam    = p.get('gu')   ?? '';

  let base: { id: number; name: string; sido: string; gu: string; dong: string; pyeong: number; pyeong_supply: number; area_sqm: number; avg_price: number; year_built: number | null; hh: number | null; deal_count: number; deal_count_12m: number; latest_date: string; freshness: string; latest_price: number; latest_floor: number | null; latest_contract_date: string; size_tier: number; size_label: string; tier_deal_count_12m: number } | null = null;
  let myPrice = priceParam;

  if (!priceMode) {
    const { data, error: be } = await supabase
      .from('apt_prices_mv')
      .select(COLS)
      .eq('id', aptId)
      .single();
    if (be || !data) return NextResponse.json({ error: 'base apt not found' }, { status: 404 });
    base = data;
    myPrice = Number(base.avg_price);
  }

  const PRICE_BAND = band === '5%'  ? myPrice * 0.05
                   : band === '10%' ? myPrice * 0.1
                   : Number(band);

  // 쿼리 빌드. 가격차순은 기준가 아래·위를 따로 받아야 해서 두 번 만든다.
  const buildQuery = () => {
    let query = supabase
      .from('apt_prices_mv')
      .select(COLS)
      .gte('avg_price', myPrice - PRICE_BAND)
      .lte('avg_price', myPrice + PRICE_BAND);


    // 범위 필터
    if (regionId) {
      if (regionId.includes('/')) {
        // 시군구 단위: "서울특별시/강남구"
        const [sido, gu] = regionId.split('/');
        query = query.eq('sido', sido).eq('gu', gu);
      } else {
        // 시도 전체: "서울특별시"
        query = query.eq('sido', regionId);
      }
    } else {
      // price 모드 기본 범위: 선택한 gu
      const refSido    = priceMode ? sidoParam : base!.sido;
      const refGu      = priceMode ? guParam   : base!.gu;
      const refDong    = priceMode ? ''        : base!.dong;
      const sidoOnly   = priceMode && !refGu;

      switch (scope) {
        case 'dong':
          if (sidoOnly) {
            query = query.eq('sido', refSido);
          } else if (priceMode) {
            query = query.eq('sido', refSido).eq('gu', refGu);
          } else {
            query = query.eq('sido', refSido).eq('gu', refGu).eq('dong', refDong);
          }
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
          if (neighborSidos.length > 0) {
            query = query.in('sido', neighborSidos);
          } else {
            query = query.eq('sido', refSido);
          }
          break;
      }
    }

    // 신뢰도 필터
    if (freshnessFilter === 'fresh_high') {
      query = query.eq('freshness', 'fresh_high');
    } else if (freshnessFilter === 'fresh_mid_up') {
      query = query.in('freshness', ['fresh_high', 'fresh_mid']);
    }

    return query;
  };

  // 같은 단지의 다른 평형. 59㎡와 84㎡는 가격이 크게 벌어져 본 목록의 가격 band에
  // 안 걸리므로 band 없이 따로 받는다. 기준 단지가 없는 가격대 탐색 모드에서는 건너뛴다.
  //
  // 기준 단지의 행 하나(neq id)만 빼면 안 된다. 같은 34평이 84.40·84.74·84.97로
  // 쪼개져 있으면 나머지 13개가 "다른 평형"으로 올라온다. 구간째로 빼야 한다.
  const sameComplexQuery = base
    ? supabase
        .from('apt_prices_mv')
        .select(COLS)
        .eq('name', base.name).eq('gu', base.gu).eq('dong', base.dong)
        .neq('size_tier', base.size_tier)
        .order('area_sqm')
    : null;

  // 정렬을 DB에 맡긴다. 예전에는 정렬 없이 500행을 받아 서버에서 줄을 세웠는데,
  // 조건에 맞는 곳이 500을 넘으면(운영 실측: 수도권 6.5억 ±10%에서 3,698곳)
  // 어느 500곳이 오는지 정해지지 않아 1위가 진짜 1위가 아닐 수 있었다.
  // matview 덕분에 order by가 인덱스로 처리돼 정확한 상위 N을 그대로 받는다.
  const asc = dir === 'asc';
  const ORDER_COL: Record<string, string> = {
    price: 'avg_price', area: 'area_sqm', year: 'year_built', deals: 'tier_deal_count_12m',
  };

  // 가격차순만 정렬 키가 abs(avg_price - 기준가)라 컬럼 하나로 표현이 안 된다.
  // 기준가 아래에서 가까운 순, 위에서 가까운 순을 따로 받아 합치면 결과는 같다
  // (가장 가까운 N곳은 반드시 이 두 묶음 안에 있다).
  const listQueries = ORDER_COL[sort]
    ? [buildQuery().order(ORDER_COL[sort], { ascending: asc, nullsFirst: false }).limit(FETCH_ROWS)]
    : [
        buildQuery().lte('avg_price', myPrice).order('avg_price', { ascending: false }).limit(FETCH_ROWS),
        buildQuery().gt('avg_price',  myPrice).order('avg_price', { ascending: true  }).limit(FETCH_ROWS),
      ];

  const [sameRes, ...listRes] = await Promise.all([
    sameComplexQuery ?? Promise.resolve({ data: [], error: null }),
    ...listQueries,
  ]);
  const listErr = listRes.find(r => r.error)?.error;
  if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
  const rows = listRes.flatMap(r => r.data ?? []);

  // DB가 상한만큼 꽉 채워 보냈다면 뒤에 더 있다는 뜻이다.
  const truncated = listRes.some(r => (r.data?.length ?? 0) >= FETCH_ROWS);

  // 단지당 1개 (기준가와 가장 가까운 평형)
  const complexMap = new Map<string, typeof rows[0]>();
  for (const r of (rows ?? [])) {
    // 기준 단지 본인만 뺀다. 이름만 비교하면 다른 구·동의 동명 단지까지 사라진다
    // (현대·주공·e편한세상처럼 흔한 이름은 전국에 널려 있다).
    if (base && r.name === base.name && r.gu === base.gu && r.dong === base.dong) continue;
    const key = `${r.name}||${r.gu}||${r.dong}`;
    const cur = complexMap.get(key);
    if (!cur || Math.abs(Number(r.avg_price) - myPrice) < Math.abs(Number(cur.avg_price) - myPrice)) {
      complexMap.set(key, r);
    }
  }

  // 정렬과 페이지 나누기는 브라우저가 한다. 여기서 잘라 보내면 "더보기" 한 번에
  // 추천 3곳을 더 얻으려고 이 요청 전체(단지 500곳 뷰 계산 + 왕복 2번)를 다시 치러야 한다.
  // 정렬 키는 전부 아래 payload에 실려 있어 다시 조회할 이유가 없다.
  // 순서는 추린 그대로 둔다 — 미리 정렬해 보내면 동점 항목 순서가 달라진다.
  // DB가 정렬해 줬지만 여기서 한 번 더 줄을 세운다. 가격차순은 두 묶음을 합친
  // 결과라 순서가 섞여 있고, 나머지도 이렇게 두면 화면 순서가 항상 이 기준과 같다.
  const sorted = Array.from(complexMap.values()).sort((a, b) => {
    let v = 0;
    if      (sort === 'price') v = Number(a.avg_price) - Number(b.avg_price);
    else if (sort === 'area')  v = Number(a.area_sqm) - Number(b.area_sqm);
    else if (sort === 'year')  v = (a.year_built ?? 0) - (b.year_built ?? 0);
    else if (sort === 'deals') v = Number(a.tier_deal_count_12m ?? 0) - Number(b.tier_deal_count_12m ?? 0);
    else                       v = Math.abs(Number(a.avg_price) - myPrice) - Math.abs(Number(b.avg_price) - myPrice);
    return asc ? v : -v;
  });

  // 100곳을 넘겨 봐야 아무도 안 본다. 더보기는 이 안에서 브라우저가 처리한다.
  const items = sorted.slice(0, MAX_COMPLEXES).map(toItem);

  const basePayload = priceMode
    ? { id: 0, name: '', sido: sidoParam, gu: guParam, dong: '', price: myPrice,
        pyeong: 0, area: 0, areaExact: 0, sizeTier: 0, sizeLabel: '', year: null, hh: null,
        dealCount: 0, annualDeals: 0, latestDate: '', freshness: 'fresh_high' as const,
        latestPrice: 0, latestFloor: null, latestContractDate: '',
        priceMode: true }
    : { ...toItem(base!), price: myPrice,
        freshness: base!.freshness as 'fresh_high'|'fresh_mid'|'fresh_low'|'scarce',
        priceMode: false };

  const sameComplex = dedupeByTier(sameRes.data ?? []).map(toItem);

  return NextResponse.json({ base: basePayload, total: items.length, truncated: truncated || sorted.length > MAX_COMPLEXES, items, sameComplex });
}
