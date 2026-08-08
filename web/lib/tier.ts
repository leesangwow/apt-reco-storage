// 평형 구간(size_tier) 관련 공통 처리.
//
// apts의 키가 (단지명, 구, 동, 전용면적)이라 같은 평형이 84.28·84.74·84.97처럼 여러
// 행으로 쪼개진다. 운영 데이터에서 해밀마을1단지 34평은 14개 행이었다. 화면에 그대로
// 내보내면 같은 평형이 14번 나열되므로, 구간마다 대표 한 개만 남긴다.

type TierRow = { size_tier: number; deal_count: number; area_sqm: number | string };

/**
 * 같은 평형 구간의 행들을 하나로 접는다. 면적 오름차순으로 돌려준다.
 *
 * 대표는 6개월 거래가 가장 많은 면적으로 고른다. 파편 중 1건짜리가 대표가 되면
 * 평균가가 그 한 건에 좌우된다. 동률이면 작은 면적으로 고정해 매번 같은 결과를 낸다.
 */
export function dedupeByTier<T extends TierRow>(rows: T[]): T[] {
  const best = new Map<number, T>();
  for (const r of rows) {
    const cur = best.get(r.size_tier);
    if (!cur
        || r.deal_count > cur.deal_count
        || (r.deal_count === cur.deal_count && Number(r.area_sqm) < Number(cur.area_sqm))) {
      best.set(r.size_tier, r);
    }
  }
  return Array.from(best.values()).sort((a, b) => Number(a.area_sqm) - Number(b.area_sqm));
}
