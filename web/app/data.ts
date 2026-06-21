import type { BaseApt, RecApt, ResolvedBaseApt } from './types';

export const BASE_APTS: BaseApt[] = [
  {
    id: 1, name: '마포래미안푸르지오', gu: '마포구', dong: '아현동', year: 2014, hh: 3885,
    variants: [
      { pyeong: 25, area: 59, price: 9.5 },
      { pyeong: 33, area: 84, price: 13.8 },
      { pyeong: 42, area: 114, price: 18.2 },
    ],
  },
  {
    id: 2, name: '공덕자이', gu: '마포구', dong: '공덕동', year: 2015, hh: 1164,
    variants: [
      { pyeong: 24, area: 59, price: 9.8 },
      { pyeong: 33, area: 84, price: 14.2 },
      { pyeong: 43, area: 115, price: 19.0 },
    ],
  },
  {
    id: 3, name: '신촌숲아이파크', gu: '서대문구', dong: '남가좌동', year: 2019, hh: 1015,
    variants: [
      { pyeong: 25, area: 59, price: 9.1 },
      { pyeong: 34, area: 84, price: 13.5 },
    ],
  },
  {
    id: 4, name: 'e편한세상신촌', gu: '서대문구', dong: '북아현동', year: 2017, hh: 1910,
    variants: [
      { pyeong: 24, area: 59, price: 8.8 },
      { pyeong: 33, area: 84, price: 13.2 },
      { pyeong: 40, area: 108, price: 17.5 },
    ],
  },
  {
    id: 5, name: '마포프레스티지자이', gu: '마포구', dong: '염리동', year: 2021, hh: 1694,
    variants: [
      { pyeong: 25, area: 59, price: 10.2 },
      { pyeong: 35, area: 84, price: 14.9 },
      { pyeong: 46, area: 120, price: 20.5 },
    ],
  },
];

export function resolveApt(apt: BaseApt, pyeong: number): ResolvedBaseApt {
  const v = apt.variants.find(v => v.pyeong === pyeong) ?? apt.variants[0];
  return { ...apt, pyeong: v.pyeong, area: v.area, price: v.price };
}

export const REC_POOLS: Record<string, RecApt[]> = {
  dong: [
    { id: 101, name: '공덕자이', gu: '마포구', dong: '공덕동', price: 14.2, pyeong: 33, area: 84, year: 2015, hh: 1164, km: 0.8, mins: '도보 11분', color: '#F2B705' },
    { id: 102, name: '신촌숲아이파크', gu: '서대문구', dong: '남가좌동', price: 13.5, pyeong: 34, area: 84, year: 2019, hh: 1015, km: 1.2, mins: '도보 16분', color: '#6AB7A8' },
    { id: 103, name: 'e편한세상신촌', gu: '서대문구', dong: '북아현동', price: 13.2, pyeong: 33, area: 84, year: 2017, hh: 1910, km: 0.9, mins: '도보 12분', color: '#E8855B' },
    { id: 104, name: '아현아이파크', gu: '마포구', dong: '아현동', price: 14.6, pyeong: 35, area: 84, year: 2020, hh: 497, km: 0.5, mins: '도보 7분', color: '#9C8AD6' },
    { id: 105, name: '공덕더샵', gu: '마포구', dong: '공덕동', price: 13.0, pyeong: 32, area: 80, year: 2015, hh: 472, km: 1.4, mins: '차로 6분', color: '#7FA6E0' },
  ],
  gu: [
    { id: 201, name: '마포프레스티지자이', gu: '마포구', dong: '염리동', price: 14.9, pyeong: 35, area: 84, year: 2021, hh: 1694, km: 1.5, mins: '차로 7분', color: '#F2B705' },
    { id: 202, name: '신촌그랑자이', gu: '마포구', dong: '대흥동', price: 13.6, pyeong: 34, area: 84, year: 2020, hh: 1248, km: 2.1, mins: '차로 9분', color: '#6AB7A8' },
    { id: 203, name: '마포자이3차', gu: '마포구', dong: '염리동', price: 13.1, pyeong: 33, area: 84, year: 2018, hh: 927, km: 1.8, mins: '차로 8분', color: '#E8855B' },
    { id: 204, name: '래미안웰스트림', gu: '마포구', dong: '신수동', price: 14.4, pyeong: 34, area: 84, year: 2016, hh: 773, km: 2.4, mins: '차로 10분', color: '#9C8AD6' },
    { id: 205, name: '공덕SK리더스뷰', gu: '마포구', dong: '공덕동', price: 14.0, pyeong: 33, area: 84, year: 2019, hh: 472, km: 1.3, mins: '차로 6분', color: '#7FA6E0' },
  ],
  city: [
    { id: 301, name: '철산센트럴자이', gu: '광명시', dong: '철산동', price: 12.5, pyeong: 34, area: 84, year: 2021, hh: 798, km: 9.2, mins: '차로 24분', color: '#F2B705' },
    { id: 302, name: '킨텍스원시티', gu: '고양시', dong: '일산서구', price: 11.8, pyeong: 38, area: 99, year: 2019, hh: 1880, km: 18.4, mins: '차로 35분', color: '#6AB7A8' },
    { id: 303, name: '한강신도시반도유보라', gu: '김포시', dong: '장기동', price: 9.9, pyeong: 35, area: 84, year: 2018, hh: 1474, km: 22.1, mins: '차로 41분', color: '#E8855B' },
    { id: 304, name: '광명푸르지오포레나', gu: '광명시', dong: '광명동', price: 13.4, pyeong: 33, area: 84, year: 2022, hh: 1187, km: 8.7, mins: '차로 22분', color: '#9C8AD6' },
    { id: 305, name: '중동센트럴파크푸르지오', gu: '부천시', dong: '중동', price: 11.2, pyeong: 36, area: 84, year: 2020, hh: 999, km: 14.6, mins: '차로 30분', color: '#7FA6E0' },
  ],
  seoul: [
    { id: 401, name: '마곡13단지힐스테이트', gu: '강서구', dong: '마곡동', price: 13.4, pyeong: 33, area: 84, year: 2017, hh: 1194, km: 12.5, mins: '차로 28분', color: '#F2B705' },
    { id: 402, name: '고덕그라시움', gu: '강동구', dong: '상일동', price: 14.1, pyeong: 34, area: 84, year: 2019, hh: 4932, km: 16.8, mins: '차로 33분', color: '#6AB7A8' },
    { id: 403, name: '답십리파크자이', gu: '동대문구', dong: '답십리동', price: 12.7, pyeong: 33, area: 84, year: 2019, hh: 802, km: 9.4, mins: '차로 22분', color: '#E8855B' },
    { id: 404, name: '길음래미안위브', gu: '성북구', dong: '길음동', price: 12.9, pyeong: 33, area: 84, year: 2016, hh: 2003, km: 8.1, mins: '차로 19분', color: '#9C8AD6' },
    { id: 405, name: '보라매자이더포레스트', gu: '동작구', dong: '신대방동', price: 14.6, pyeong: 34, area: 84, year: 2023, hh: 959, km: 7.3, mins: '차로 17분', color: '#7FA6E0' },
  ],
};

type RegionData = Record<string, Record<string, Array<[string, string, number, number, number, number, number, string]>>>;

export const REGION_DATA: RegionData = {
  서울: {
    강남구: [['도곡렉슬','도곡동',14.7,33,2006,3002,11.2,'차로 26분'],['역삼e편한세상','역삼동',14.2,32,2005,840,10.4,'차로 24분'],['논현아이파크','논현동',15.0,33,2018,635,12.1,'차로 27분']],
    송파구: [['헬리오시티','가락동',13.9,33,2018,9510,9.8,'차로 22분'],['잠실엘스','잠실동',14.6,33,2008,5678,11.0,'차로 25분'],['리센츠','잠실동',14.8,33,2008,5563,11.3,'차로 25분']],
    노원구: [['상계주공7단지','상계동',8.9,31,1988,2634,13.5,'차로 31분'],['중계무지개','중계동',9.4,32,1991,2433,12.8,'차로 30분']],
  },
  경기: {
    '분당구(성남)': [['정자동파크뷰','정자동',13.2,34,2004,1829,19.2,'차로 38분'],['이매촌삼성','이매동',12.4,33,1993,1162,20.1,'차로 40분'],['수내동양지마을','수내동',12.9,33,1992,1162,18.7,'차로 37분']],
    '영통구(수원)': [['광교호수마을','이의동',11.8,34,2012,1188,28.4,'차로 52분'],['영통롯데캐슬','영통동',9.6,33,1997,1162,30.2,'차로 55분']],
    '일산동구(고양)': [['식사위시티블루밍','식사동',9.2,38,2010,2659,21.4,'차로 41분'],['백석요진와이시티','백석동',10.8,35,2016,2404,17.8,'차로 35분']],
  },
  인천: {
    '연수구(송도)': [['더샵퍼스트월드','송도동',12.6,34,2009,1597,29.0,'차로 54분'],['더샵센트럴파크','송도동',13.1,33,2010,729,29.5,'차로 55분']],
  },
  부산: {
    해운대구: [['두산위브더제니스','우동',13.8,40,2011,1788,318,'기차 2시간 40분'],['마린시티자이','우동',14.4,38,2018,258,320,'기차 2시간 40분']],
    수영구: [['남천삼익비치','남천동',13.2,35,1979,3060,322,'기차 2시간 45분']],
  },
  대구: {
    수성구: [['범어롯데캐슬','범어동',11.4,34,2009,469,238,'기차 1시간 50분'],['수성롯데캐슬더퍼스트','만촌동',10.6,33,2016,498,240,'기차 1시간 50분']],
  },
  대전: {
    유성구: [['도룡SK뷰','도룡동',12.8,34,2018,383,146,'기차 1시간'],['죽동대원칸타빌','죽동',9.2,33,2017,933,148,'기차 1시간 5분']],
  },
};

const COLORS = ['#F2B705', '#6AB7A8', '#E8855B', '#9C8AD6', '#7FA6E0'];

export function buildRegionPools(): Record<string, RecApt[]> {
  const pools: Record<string, RecApt[]> = {};
  let uid = 600;
  for (const sido of Object.keys(REGION_DATA)) {
    for (const gu of Object.keys(REGION_DATA[sido])) {
      const key = `${sido}/${gu}`;
      pools[key] = REGION_DATA[sido][gu].map((r, i) => ({
        id: uid++,
        name: r[0],
        gu: gu.replace(/\(.*\)/, ''),
        dong: r[1],
        price: r[2],
        pyeong: r[3],
        area: Math.round(r[3] * 2.55),
        year: r[4],
        hh: r[5],
        km: r[6],
        mins: r[7],
        color: COLORS[i % COLORS.length],
      }));
    }
  }
  return pools;
}

export const SCOPE_META: Record<string, { label: string; area: string }> = {
  dong: { label: '우리 동네', area: '마포 아현 인근' },
  gu:   { label: '우리 구',   area: '마포구 전역' },
  city: { label: '주변 시',   area: '광명·고양·김포·부천' },
  seoul:{ label: '서울 전체', area: '서울시 전 지역' },
};
