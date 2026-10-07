import { areaLabel } from './regions';

/**
 * 네이버지도·네이버 부동산으로 가는 바깥 링크.
 *
 * 둘 다 검색 URL이다. 네이버 쪽 단지 식별자(좌표, 부동산 단지번호)를 아직 갖고 있지
 * 않아서 "구 동 단지명"으로 검색을 건다. 동을 붙이는 이유는 국토부 단지명이 흔해서
 * ('현대', '삼성' 등) 이름만으로는 엉뚱한 지역 단지가 먼저 걸리기 때문이다.
 *
 * 부동산 단지번호(complexNo)를 매핑하게 되면 naverLandUrl만
 * https://new.land.naver.com/complexes/{complexNo} 로 바꾸면 된다.
 */
interface Place { name: string; sido: string; gu: string; dong: string; }

function query(p: Place): string {
  return encodeURIComponent(`${areaLabel(p.sido, p.gu, p.dong)} ${p.name}`.trim());
}

export function naverMapUrl(p: Place): string {
  return `https://map.naver.com/p/search/${query(p)}`;
}

export function naverLandUrl(p: Place): string {
  return `https://m.land.naver.com/search/result/${query(p)}`;
}
