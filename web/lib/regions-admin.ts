/**
 * 수집 스크립트의 region_key ↔ DB의 sido 이름 대응.
 * scripts/download_csv.py의 BUY_REGIONS와 순서·내용이 같아야 한다.
 */
export const COLLECTED_REGIONS: { key: string; sido: string }[] = [
  { key: 'seoul',         sido: '서울특별시' },
  { key: 'jeonranam',     sido: '전남광주통합특별시' },
  { key: 'busan',         sido: '부산광역시' },
  { key: 'daegu',         sido: '대구광역시' },
  { key: 'incheon',       sido: '인천광역시' },
  { key: 'daejeon',       sido: '대전광역시' },
  { key: 'ulsan',         sido: '울산광역시' },
  { key: 'sejong',        sido: '세종특별자치시' },
  { key: 'gyeonggi',      sido: '경기도' },
  { key: 'choongbuk',     sido: '충청북도' },
  { key: 'choongnam',     sido: '충청남도' },
  { key: 'kyeongsangbuk', sido: '경상북도' },
  { key: 'kyeongsangnam', sido: '경상남도' },
  { key: 'jeju',          sido: '제주특별자치도' },
  { key: 'gangwon',       sido: '강원특별자치도' },
  { key: 'jeonbuktuk',    sido: '전북특별자치도' },
];

export const DEAL_TYPES = ['buy', 'rent'] as const;
export type DealType = (typeof DEAL_TYPES)[number];

export const DEAL_LABEL: Record<DealType, string> = { buy: '매매', rent: '전월세' };
