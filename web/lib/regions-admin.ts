/**
 * 수집 스크립트의 region_key ↔ 화면 이름 ↔ DB의 sido 값 대응.
 * scripts/download_csv.py의 BUY_REGIONS와 순서·내용이 같아야 한다.
 *
 * sidos가 배열인 이유: 국토부 사이트의 시도 선택지 하나가 DB의 sido 여러 개에
 * 해당할 수 있다. 적재 스크립트는 CSV의 시군구 첫 토큰을 그대로 apts.sido에 넣는데
 * (load_csv.py의 parse_sido_gu_dong), 사이트가 선택지로만 합쳐놓은 지역은 데이터
 * 안의 시도명이 원래대로 남는다. 전남광주통합특별시가 그렇다 — 한 선택지로 받지만
 * 행마다 광주광역시 또는 전라남도로 들어간다.
 *
 * region_data_stats 뷰가 apts.sido로 묶으므로, 이 대응이 빠지면 적재는 멀쩡한데
 * 화면 집계만 0에 가깝게 나온다. 2026-08-06에 실제로 그랬다
 * (신규 +16,806건인데 총 건수 826건).
 */
export const COLLECTED_REGIONS: { key: string; label: string; sidos: string[] }[] = [
  { key: 'seoul',         label: '서울특별시',       sidos: ['서울특별시'] },
  { key: 'jeonranam',     label: '전남광주통합특별시',
    sidos: ['전남광주통합특별시', '광주광역시', '전라남도'] },
  { key: 'busan',         label: '부산광역시',       sidos: ['부산광역시'] },
  { key: 'daegu',         label: '대구광역시',       sidos: ['대구광역시'] },
  { key: 'incheon',       label: '인천광역시',       sidos: ['인천광역시'] },
  { key: 'daejeon',       label: '대전광역시',       sidos: ['대전광역시'] },
  { key: 'ulsan',         label: '울산광역시',       sidos: ['울산광역시'] },
  { key: 'sejong',        label: '세종특별자치시',   sidos: ['세종특별자치시'] },
  { key: 'gyeonggi',      label: '경기도',           sidos: ['경기도'] },
  { key: 'choongbuk',     label: '충청북도',         sidos: ['충청북도'] },
  { key: 'choongnam',     label: '충청남도',         sidos: ['충청남도'] },
  { key: 'kyeongsangbuk', label: '경상북도',         sidos: ['경상북도'] },
  { key: 'kyeongsangnam', label: '경상남도',         sidos: ['경상남도'] },
  { key: 'jeju',          label: '제주특별자치도',   sidos: ['제주특별자치도'] },
  { key: 'gangwon',       label: '강원특별자치도',   sidos: ['강원특별자치도'] },
  { key: 'jeonbuktuk',    label: '전북특별자치도',   sidos: ['전북특별자치도'] },
];

export const DEAL_TYPES = ['buy', 'rent'] as const;
export type DealType = (typeof DEAL_TYPES)[number];

export const DEAL_LABEL: Record<DealType, string> = { buy: '매매', rent: '전월세' };
