export type SortKey = 'diff' | 'dist' | 'area' | 'year';
export type SortDir = 'asc' | 'desc';
export type ScopeKey = 'dong' | 'gu' | 'city' | 'seoul' | string;

export interface AptVariant {
  pyeong: number;
  area: number;
  price: number;
}

export interface BaseApt {
  id: number;
  name: string;
  gu: string;
  dong: string;
  year: number;
  hh: number;
  variants: AptVariant[];
}

export interface ResolvedBaseApt extends BaseApt {
  pyeong: number;
  area: number;
  price: number;
}

export interface RecApt {
  id: number;
  name: string;
  gu: string;
  dong: string;
  price: number;
  pyeong: number;
  area: number;
  year: number;
  hh: number;
  km: number;
  mins: string;
  color: string;
  region?: string;
}

export interface AddedRegion {
  id: string;
  sido: string;
  gu: string;
}
