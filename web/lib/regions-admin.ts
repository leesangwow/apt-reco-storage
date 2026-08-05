/** 수집 스크립트의 region_key ↔ DB의 sido 이름 대응 (scripts/download_csv.py와 같은 순서) */
export const COLLECTED_REGIONS: { key: string; sido: string }[] = [
  { key: 'choongbuk',     sido: '충청북도' },
  { key: 'jeonbuktuk',    sido: '전북특별자치도' },
  { key: 'jeonranam',     sido: '전남광주통합특별시' },
  { key: 'kyeongsangbuk', sido: '경상북도' },
];

export const DEAL_TYPES = ['buy', 'rent'] as const;
export type DealType = (typeof DEAL_TYPES)[number];

export const DEAL_LABEL: Record<DealType, string> = { buy: '매매', rent: '전월세' };
