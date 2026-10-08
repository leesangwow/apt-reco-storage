import { areaLabel, guName } from './regions';

/**
 * 네이버지도·네이버 부동산으로 가는 바깥 링크.
 *
 * 네이버 쪽 단지 식별자(좌표, 부동산 단지번호)를 아직 갖고 있지 않아 둘 다 검색 URL이다.
 *
 * 지도는 도로명주소로 검색한다. 단지명으로 찾으면 이름이 비슷한 이웃 단지가 먼저
 * 걸리는 일이 있었다 ('동래구 사직동 사직쌍용예가'). 주소는 건물 하나로 떨어져서
 * 그런 혼동이 없다. 국토부 자료의 도로명은 시군구가 빠진 '율하3로 100' 꼴이라
 * 시도·시군구를 앞에 붙인다 ('중구 ○○로 1'은 여러 도시에 있다).
 *
 * 부동산 단지번호(complexNo)를 매핑하게 되면 naverLandUrl만
 * https://new.land.naver.com/complexes/{complexNo} 로 바꾸면 된다.
 */
interface Place { name: string; sido: string; gu: string; dong: string; address: string | null; }

/** 건물번호까지 있는 도로명만 쓴다. 비었거나 '-'·도로 이름만 있으면 위치가 안 정해진다. */
function roadAddress(p: Place): string | null {
  const a = p.address?.trim();
  if (!a || !/\d+(-\d+)?$/.test(a)) return null;
  return [p.sido, guName(p.sido, p.gu), a].filter(Boolean).join(' ');
}

/** 이름 검색어. 국토부 단지명은 흔해서('현대', '삼성') 동을 붙여 지역을 좁힌다. */
function nameQuery(p: Place): string {
  return `${areaLabel(p.sido, p.gu, p.dong)} ${p.name}`.trim();
}

export function naverMapUrl(p: Place): string {
  return `https://map.naver.com/p/search/${encodeURIComponent(roadAddress(p) ?? nameQuery(p))}`;
}

export function naverLandUrl(p: Place): string {
  return `https://m.land.naver.com/search/result/${encodeURIComponent(nameQuery(p))}`;
}
