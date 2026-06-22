'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import type { SortKey, SortDir, AddedRegion } from '../types';
import { getScopeChips, SIDO_SHORT, NEIGHBOR_LABEL } from '@/lib/regions';

function won(n: number): string {
  const v = Math.abs(n);
  const t = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return t + '억';
}

const THUMB_COLORS = ['#F2B705', '#6AB7A8', '#E8855B', '#9C8AD6', '#7FA6E0'];

interface BaseApt {
  id: number; name: string; sido: string; gu: string; dong: string;
  price: number; pyeong: number; area: number; year: number | null; hh: number | null;
  dealCount: number; latestDate: string; freshness: Freshness;
  latestPrice: number; latestFloor: number | null; latestContractDate: string;
  priceMode?: boolean;
}
type Freshness = 'fresh_high' | 'fresh_mid' | 'fresh_low' | 'scarce';

interface RecItem {
  id: number; name: string; sido: string; gu: string; dong: string;
  price: number; pyeong: number; area: number; year: number | null; hh: number | null;
  km: number | null; mins: string | null;
  dealCount: number; latestDate: string; freshness: Freshness;
  latestPrice: number; latestFloor: number | null; latestContractDate: string;
}

const FRESHNESS_CONFIG: Record<Freshness, { label: string; color: string; bg: string }> = {
  fresh_high: { label: '3건 · 1개월↓', color: '#0A8A4A', bg: '#E2F5EC' }, // 진초록
  fresh_mid:  { label: '3건 · 3개월↓', color: '#16A06A', bg: '#EDF7F2' }, // 연초록
  fresh_low:  { label: '3건 · 6개월↓', color: '#B07D00', bg: '#FFF8DC' }, // 노랑
  scarce:     { label: '',              color: '#E8552D', bg: '#FBEAE2' }, // 주황 (건수 동적)
};

interface ApiResult { base: BaseApt; total: number; items: RecItem[]; }

export default function RecommendContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const aptId = Number(searchParams.get('aptId') ?? '0');
  const priceMode = !aptId && !!searchParams.get('price');
  const priceParam = Number(searchParams.get('price') ?? '0');
  const sidoParam  = searchParams.get('sido') ?? '';
  const guParam    = searchParams.get('gu')   ?? '';

  const [dealMode, setDealMode] = useState<'buy' | 'rent'>(
    searchParams.get('deal') === 'rent' ? 'rent' : 'buy'
  );

  const [scope, setScope] = useState(priceMode ? 'gu' : 'gu');
  const [sort, setSort] = useState<SortKey>('diff');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);
  const [band, setBand] = useState('5%');
  // null=전체, 'fresh_high'=1개월3건, 'fresh_mid_up'=3개월3건이상
  const [freshnessFilter, setFreshnessFilter] = useState<null | 'fresh_high' | 'fresh_mid_up'>(null);
  const [addedRegions, setAddedRegions] = useState<AddedRegion[]>([]);
  const [regionId, setRegionId] = useState<string | null>(null);

  const [data, setData] = useState<ApiResult | null>(null);
  const [loading, setLoading] = useState(true);

  const [liked, setLiked] = useState<Record<number, boolean>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{
    name: string; sido: string; gu: string; dong: string; year_built: number | null; hh: number | null;
    variants: { aptId: number; pyeong: number; area: number; price: number }[];
  }>>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedAptId, setSelectedAptId] = useState<number | null>(null);
  type SearchComplex = typeof searchResults[0];
  const [selectedComplex, setSelectedComplex] = useState<SearchComplex | null>(null);

  const [regionOpen, setRegionOpen] = useState(false);
  const [sheetSido, setSheetSido] = useState<string | null>(null);
  const [sidoList, setSidoList] = useState<string[]>([]);
  const [guList, setGuList] = useState<{ gu: string; count: number }[]>([]);
  const [guLoading, setGuLoading] = useState(false);
  const [toast, setToast] = useState(false);

  // 추천 API 호출
  const fetchRecommend = useCallback(async () => {
    if (!aptId && !priceMode) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        ...(priceMode
          ? { price: String(priceParam), sido: sidoParam, gu: guParam }
          : { aptId: String(aptId) }),
        scope,
        sort,
        dir: sortDir,
        page: String(page),
        band,
        ...(freshnessFilter ? { freshnessFilter } : {}),
        ...(regionId ? { regionId } : {}),
      });
      const endpoint = dealMode === 'rent' ? '/api/rent' : '/api/recommend';
      const res = await fetch(`${endpoint}?${params}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [aptId, priceMode, priceParam, sidoParam, guParam, scope, sort, sortDir, page, band, freshnessFilter, regionId, dealMode]);

  useEffect(() => { fetchRecommend(); }, [fetchRecommend]);

  // 시/도 목록 (최초 1회)
  useEffect(() => {
    fetch('/api/regions')
      .then(r => r.json())
      .then(setSidoList)
      .catch(() => {});
  }, []);

  // 시군구 목록 (시/도 선택 시)
  useEffect(() => {
    if (!sheetSido) return;
    setGuLoading(true);
    setGuList([]);
    fetch(`/api/regions?sido=${encodeURIComponent(sheetSido)}`)
      .then(r => r.json())
      .then(setGuList)
      .catch(() => {})
      .finally(() => setGuLoading(false));
  }, [sheetSido]);

  // 검색 API 호출
  useEffect(() => {
    if (!searchOpen || q.trim().length < 1) { setSearchResults([]); return; }
    const t = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        setSearchResults(await res.json());
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q, searchOpen]);

  function handleSetSort(k: SortKey) {
    const defaults: Record<SortKey, SortDir> = { diff: 'asc', dist: 'asc', area: 'desc', year: 'desc' };
    if (sort === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSort(k); setSortDir(defaults[k]); }
    setPage(0);
  }

  function handleSelectScope(k: string, rid: string | null = null) {
    setScope(k); setRegionId(rid); setPage(0);
  }

  function toggleRegion(id: string, sido: string, gu: string) {
    setAddedRegions(prev => {
      const exists = prev.some(a => a.id === id);
      if (exists) {
        const next = prev.filter(a => a.id !== id);
        if (regionId === id) { setScope('seoul'); setRegionId(null); }
        return next;
      }
      handleSelectScope(id, id);
      return [...prev, { id, sido, gu }];
    });
    setPage(0);
  }

  function handleCardClick(r: RecItem) {
    router.push(`/recommend?aptId=${r.id}`);
    setPage(0);
  }

  function handlePickComplex(c: typeof searchResults[0]) {
    if (c.variants.length === 1) {
      router.push(`/recommend?aptId=${c.variants[0].aptId}`);
      setSearchOpen(false);
    } else {
      setSelectedComplex(c);
      setSelectedAptId(null);
    }
  }

  function handlePickPyeong(aid: number) {
    router.push(`/recommend?aptId=${aid}`);
    setSearchOpen(false); setSelectedComplex(null); setQ(''); setPage(0); setScope('gu');
  }

  function showToast() { setToast(true); setTimeout(() => setToast(false), 2000); }

  const my = data?.base;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const allShown = items.length >= total;

  const scopeChips = my
    ? getScopeChips(my.sido, my.gu).map(c => ({ ...c, active: c.key === scope && !regionId }))
    : [];
  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'diff', label: '가격차순' },
    { key: 'area', label: '평형순' },
    { key: 'year', label: '준공순' },
  ];

  return (
    <div className="min-h-screen bg-[#F5F5F1] flex flex-col items-center">
      <div className="w-full max-w-[390px] relative">

        {/* Top nav */}
        <div className="flex items-center px-[18px] pt-[14px] pb-[2px]">
          <button onClick={() => router.push('/')}
            className="flex items-center gap-[5px] border-none bg-transparent cursor-pointer p-0 text-[#8A8A82] hover:text-[#191919] transition-colors">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M9 2L2 9l7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M2 9h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <span className="text-[13px] font-semibold">처음으로</span>
          </button>
        </div>

        {/* 매매/전세 스위치 */}
        <div className="flex bg-[#EAEAE4] rounded-[12px] p-[3px] mx-[18px] mb-[10px]">
          {(['buy', 'rent'] as const).map(m => (
            <button key={m} onClick={() => { setDealMode(m); setPage(0); setScope('gu'); }}
              className={`flex-1 text-[13px] font-bold py-[7px] rounded-[9px] transition-all cursor-pointer border-none ${dealMode === m ? 'bg-white text-[#191919] shadow-sm' : 'bg-transparent text-[#8A8A82]'}`}>
              {m === 'buy' ? '매매' : '전세'}
            </button>
          ))}
        </div>

        {/* My apartment header */}
        <div className="px-[18px] pt-[8px] pb-[14px]">
          <div className="bg-white rounded-[20px] p-[15px_17px] shadow-[0_2px_10px_rgba(0,0,0,.04)]">
            <div className="flex justify-between items-center mb-[9px]">
              <span className="text-[11px] font-extrabold text-[#C99A00] bg-[#FFF6D6] px-[9px] py-[4px] rounded-[8px]">
                {my?.priceMode ? '기준 — 가격대 탐색' : dealMode === 'rent' ? '기준 — 전세 시세' : '기준 — 내 관심 아파트'}
              </span>
              <button onClick={() => my?.priceMode ? router.push('/') : (setSearchOpen(true), setQ(''), setSelectedComplex(null))}
                className="border-none bg-[#F2F2EE] text-[#3A3A36] text-[12px] font-bold px-[13px] py-[7px] rounded-[10px] cursor-pointer">
                {my?.priceMode ? '변경' : '검색·변경'}
              </button>
            </div>
            {loading && !my ? (
              <div className="h-[52px] bg-[#F4F4F0] rounded-[12px] animate-pulse" />
            ) : my?.priceMode ? (
              /* 가격대 탐색 모드 카드 */
              <div className="flex items-center justify-between gap-[10px]">
                <div className="min-w-0">
                  <div className="text-[18px] font-extrabold text-[#191919] tracking-tight">{won(my.price)}대</div>
                  <div className="text-[12.5px] text-[#8A8A82] mt-[3px]">{SIDO_SHORT[my.sido] ?? my.sido} {my.gu}</div>
                </div>
                <div className="text-right flex-none">
                  <div className="text-[11px] text-[#ADADA4]">가격 기준 탐색</div>
                </div>
              </div>
            ) : my ? (
              <div className="flex items-start justify-between gap-[10px]">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-[6px]">
                    <div className="text-[18px] font-extrabold text-[#191919] tracking-tight line-clamp-2 break-keep">{my.name}</div>
                    <button onClick={showToast} className="border-none cursor-pointer text-[12px] leading-none px-[5px] py-[2px] bg-[#F4F4F0] text-[#ADADA4] rounded-[5px] hover:bg-[#EAEAE4] transition-colors flex-none">›</button>
                  </div>
                  <div className="flex items-center gap-[6px] mt-[3px]">
                    <span className="text-[12.5px] text-[#8A8A82]">{my.gu} {my.dong} · {my.pyeong}평 · {my.year ?? '-'}년</span>
                    {my.freshness && (() => {
                      const f = FRESHNESS_CONFIG[my.freshness];
                      const label = my.freshness === 'scarce' ? `${my.dealCount}건 · 6개월↓` : f.label;
                      return (
                        <span className="text-[10px] font-bold px-[6px] py-[2px] rounded-[5px] whitespace-nowrap flex-none"
                          style={{ color: f.color, background: f.bg }}>{label}</span>
                      );
                    })()}
                  </div>
                </div>
                <div className="text-right flex-none">
                  <div className="text-[20px] font-extrabold text-[#191919]">{won(my.price)}</div>
                  {my.latestContractDate && (
                    <div className="text-[11px] text-[#ADADA4] mt-[2px]">
                      최근 {my.latestContractDate.slice(0, 7).replace('-', '.')}
                      {my.latestFloor ? ` · ${my.latestFloor}층` : ''} {won(my.latestPrice)}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* Scope chips */}
        <div className="flex gap-[8px] px-[18px] pb-[10px] pt-[2px] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {scopeChips.map(c => (
            <button key={c.key} onClick={() => handleSelectScope(c.key, null)}
              className={`flex-none border cursor-pointer text-[13px] px-[15px] py-[9px] rounded-[13px] whitespace-nowrap transition-all ${c.active ? 'bg-[#FFD400] text-[#1A1A1A] font-extrabold border-transparent shadow-[0_3px_9px_rgba(255,212,0,.45)]' : 'border-[#EAEAE4] bg-white text-[#76766E] font-bold'}`}
            >{c.label}</button>
          ))}
          {addedRegions.map(a => (
            <button key={a.id} onClick={() => handleSelectScope(a.id, a.id)}
              className={`flex-none border cursor-pointer text-[13px] px-[15px] py-[9px] rounded-[13px] whitespace-nowrap transition-all ${regionId === a.id ? 'bg-[#FFD400] text-[#1A1A1A] font-extrabold border-transparent shadow-[0_3px_9px_rgba(255,212,0,.45)]' : 'border-[#EAEAE4] bg-white text-[#76766E] font-bold'}`}
            >{a.gu ? a.gu : `${SIDO_SHORT[a.sido] ?? a.sido} 전체`}</button>
          ))}
          <button onClick={() => setRegionOpen(true)} className="flex-none border border-dashed border-[#D2D2CA] bg-white cursor-pointer text-[13px] font-bold px-[14px] py-[9px] rounded-[13px] text-[#6E6E66] whitespace-nowrap">＋ 지역</button>
        </div>

        {/* Subtitle */}
        <div className="px-[22px] pb-[10px] text-[12.5px] text-[#8A8A82]">
          {regionId
            ? (regionId.includes('/') ? regionId.replace('/', ' ') : `${SIDO_SHORT[regionId] ?? regionId} 전체`)
            : scopeChips.find(c => c.key === scope)?.label ?? ''
          } · 가격차 {band === '5%' ? '5% 이내' : band === '10%' ? '10% 이내' : `${band}억 이내`} · {total}곳
        </div>

        {/* Freshness filter */}
        <div className="flex gap-[6px] px-[18px] pb-[10px] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden items-center">
          <span className="text-[11px] text-[#A0A098] font-bold flex-none">신뢰도</span>
          {([
            { key: null,           label: '전체',           dot: '#C0C0B8' },
            { key: 'fresh_mid_up', label: '3건 · 3개월↓',  dot: '#16A06A' },
            { key: 'fresh_high',   label: '3건 · 1개월↓',  dot: '#0A8A4A' },
          ] as const).map(opt => {
            const on = freshnessFilter === opt.key;
            return (
              <button key={String(opt.key)} onClick={() => { setFreshnessFilter(opt.key); setPage(0); }}
                className={`flex items-center gap-[5px] flex-none border cursor-pointer text-[12px] font-bold px-[12px] py-[6px] rounded-[10px] transition-all ${on ? 'bg-[#1A1A1A] text-white border-transparent' : 'border-[#EAEAE4] bg-white text-[#76766E]'}`}
              >
                <span className="w-[6px] h-[6px] rounded-full flex-none" style={{ background: on ? 'white' : opt.dot }} />
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* Band chips */}
        <div className="flex gap-[6px] px-[18px] pb-[10px] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden items-center">
          <span className="text-[11px] text-[#A0A098] font-bold flex-none">가격범위</span>
          {(['5%', '10%', '1', '2'] as const).map(b => {
            const label = b === '5%' ? '±5%' : b === '10%' ? '±10%' : `±${b}억`;
            const on = band === b;
            return (
              <button key={b} onClick={() => { setBand(b); setPage(0); }}
                className={`flex-none border cursor-pointer text-[12px] px-[12px] py-[6px] rounded-[10px] whitespace-nowrap transition-all ${on ? 'bg-[#1A1A1A] text-white font-extrabold border-transparent' : 'border-[#EAEAE4] bg-white text-[#80807A] font-semibold'}`}
              >{label}</button>
            );
          })}
        </div>

        {/* Sort chips */}
        <div className="flex gap-[6px] px-[18px] pb-[12px] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden items-center">
          <span className="text-[11px] text-[#A0A098] font-bold flex-none">정렬</span>
          {sortOptions.map(o => {
            const on = sort === o.key;
            return (
              <button key={o.key} onClick={() => handleSetSort(o.key)}
                className={`flex-none border cursor-pointer text-[12px] px-[12px] py-[6px] rounded-[10px] whitespace-nowrap transition-all ${on ? 'bg-[#1A1A1A] text-white font-extrabold border-transparent' : 'border-[#EAEAE4] bg-white text-[#80807A] font-semibold'}`}
              >{o.label}{on ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}</button>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-[6px] px-[22px] pb-[12px] text-[11px] text-[#B0B0A8] font-semibold">
          <span className="text-[#16A06A]">◂ 더 저렴</span>
          <span className="flex-1" />
          <span className="text-[#E8552D]">더 비쌈 ▸</span>
        </div>

        {/* Cards */}
        <div className="flex flex-col gap-[10px] px-[16px] pb-[4px]">
          {loading && items.length === 0 ? (
            [0,1,2].map(i => <div key={i} className="h-[120px] bg-white rounded-[16px] animate-pulse" />)
          ) : items.map((r, idx) => {
            const diff = +(r.price - (my?.price ?? 0)).toFixed(1);
            const pos = diff > 0;
            const isLiked = !!liked[r.id];
            const barW = Math.min(Math.round(Math.abs(diff) * 52), 66);
            const center = 70;
            let barLeft: number, barWidth: number, barColor: string;
            if (diff === 0) { barLeft = center-1; barWidth = 2; barColor = '#C8C8C0'; }
            else if (pos) { barLeft = center; barWidth = barW; barColor = '#E8552D'; }
            else { barLeft = center-barW; barWidth = barW; barColor = '#16A06A'; }
            const diffText = diff === 0 ? '내 관심과 동일' : pos ? `${won(diff)} 높아요` : `${won(Math.abs(diff))} 저렴해요`;
            const diffColor = diff === 0 ? '#8A8A82' : pos ? '#E8552D' : '#16A06A';
            const color = THUMB_COLORS[idx % THUMB_COLORS.length];

            return (
              <div key={r.id} onClick={() => handleCardClick(r)}
                className="bg-white rounded-[16px] p-[13px_14px] shadow-[0_2px_9px_rgba(0,0,0,.04)] cursor-pointer active:scale-[0.99] transition-transform">
                <div className="flex justify-between items-center gap-[10px]">
                  <div className="flex items-center gap-[11px] min-w-0">
                    <div className="flex-none w-[46px] h-[46px] rounded-[11px] relative overflow-hidden"
                      style={{ backgroundColor: `${color}26`, backgroundImage: `repeating-linear-gradient(135deg, ${color}3d 0 7px, transparent 7px 15px)` }}>
                      <span className="absolute bottom-[4px] left-[4px] font-mono text-[7px] text-black/40 leading-none">단지</span>
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-[6px]">
                        <span className="text-[14.5px] font-extrabold text-[#191919] line-clamp-2 break-keep">{r.name}</span>
                        <button onClick={e => { e.stopPropagation(); showToast(); }}
                          className="border-none cursor-pointer text-[12px] leading-none px-[5px] py-[2px] bg-[#F4F4F0] text-[#ADADA4] rounded-[5px] hover:bg-[#EAEAE4] transition-colors flex-none">›</button>
                        <button onClick={e => { e.stopPropagation(); setLiked(l => ({ ...l, [r.id]: !l[r.id] })); }}
                          className="border-none cursor-pointer text-[15px] leading-none p-0 bg-transparent"
                          style={{ color: isLiked ? '#FF4D4F' : '#CFCFC8' }}>
                          {isLiked ? '♥' : '♡'}
                        </button>
                      </div>
                      <div className="text-[11px] text-[#9A9A92] mt-[2px]">
                        {SIDO_SHORT[r.sido] ?? r.sido} {r.gu} {r.dong}{r.km ? ` · 직선 ${r.km}km · ${r.mins}` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="text-[16px] font-extrabold text-[#191919] whitespace-nowrap">{won(r.price)}</div>
                </div>
                <div className="flex items-center gap-[10px] mt-[11px]">
                  <div className="relative w-[140px] h-[10px] bg-[#F2F2EE] rounded-[5px] flex-none">
                    <div className="absolute left-[69px] top-0 bottom-0 w-[2px] bg-[#D8D8D0]" />
                    <div className="absolute top-[1px] bottom-[1px] rounded-[4px]" style={{ left: barLeft, width: barWidth, background: barColor }} />
                  </div>
                  <span className="text-[12px] font-extrabold" style={{ color: diffColor }}>{diffText}</span>
                </div>
                <div className="mt-[9px] border-t border-[#F4F4F0] pt-[9px]">
                  {/* 최근 실거래 */}
                  <div className="flex items-center justify-between mb-[5px]">
                    <span className="text-[11px] text-[#ADADA4]">
                      {dealMode === 'rent' ? '최근 전세' : '최근 거래'}
                      {r.latestFloor ? ` · ${r.latestFloor}층` : ''}
                      {' · '}{r.latestContractDate?.slice(0, 7).replace('-', '.')}
                    </span>
                    <span className="text-[12px] font-bold text-[#ADADA4]">{won(r.latestPrice)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                  <span className="text-[11px] text-[#ADADA4]">
                    {r.pyeong}평({r.area}㎡) · {r.year ?? '-'}년 · {r.hh ? r.hh.toLocaleString() + '세대' : '-'}
                  </span>
                  {(() => {
                    const f = FRESHNESS_CONFIG[r.freshness];
                    const label = r.freshness === 'scarce'
                      ? `${r.dealCount}건 · 6개월↓`
                      : f.label;
                    return (
                      <span className="text-[10px] font-bold px-[6px] py-[2px] rounded-[5px] whitespace-nowrap flex-none"
                        style={{ color: f.color, background: f.bg }}>
                        {label}
                      </span>
                    );
                  })()}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* More / fold */}
        {total > 3 && (
          <div className="px-[18px] pt-[14px] pb-[28px]">
            <button onClick={() => { if (allShown) setPage(0); else setPage(p => p + 1); }}
              className="w-full border border-[#E6E6E0] bg-white text-[#3A3A36] text-[14px] font-extrabold py-[14px] rounded-[15px] cursor-pointer">
              {allShown ? '접기' : `더보기 · 남은 ${total - items.length}곳`}
            </button>
          </div>
        )}

        {/* Region bottom sheet */}
        {regionOpen && (
          <>
            <div className="absolute inset-0 bg-[rgba(20,20,18,.34)]" onClick={() => setRegionOpen(false)} />
            <div className="absolute left-0 right-0 bottom-0 bg-white rounded-t-[26px] px-[20px] pt-[10px] pb-[26px] max-h-[88%] overflow-y-auto" style={{animation:'sheetUp .26s cubic-bezier(.22,1,.36,1)'}}>
              <div className="w-[38px] h-[4px] bg-[#E2E2DC] rounded-[3px] mx-auto mb-[16px] mt-[6px]" />
              <div className="flex justify-between items-center mb-[5px]">
                <div className="text-[17px] font-extrabold text-[#191919]">{addedRegions.length > 0 ? `지역 추가 · ${addedRegions.length}곳 선택됨` : '지역 추가'}</div>
                <button onClick={() => setRegionOpen(false)} className="border-none bg-[#FFD400] text-[#1A1A1A] text-[13px] font-extrabold px-[16px] py-[8px] rounded-[11px] cursor-pointer">완료</button>
              </div>
              <div className="text-[12.5px] text-[#9A9A92] mb-[14px]">전국에서 비교할 지역을 골라 칩으로 추가하세요</div>

              {/* 시/도 그리드 */}
              <div className="grid grid-cols-2 gap-[8px] mb-[16px]">
                {sidoList.map(sd => {
                  const on = sd === sheetSido;
                  return (
                    <button key={sd} onClick={() => setSheetSido(sd)}
                      className={`border cursor-pointer text-[13px] px-[14px] py-[10px] rounded-[12px] text-left transition-all ${on ? 'bg-[#1A1A1A] text-white font-extrabold border-transparent' : 'border-[#EAEAE4] bg-white text-[#3A3A36] font-semibold'}`}
                    >{sd}</button>
                  );
                })}
              </div>

              {/* 시군구 목록 */}
              {sheetSido && (
                <>
                  <div className="text-[12px] font-bold text-[#A0A098] mb-[10px]">{sheetSido} · 시군구 선택</div>
                  {/* 시도 전체 선택 버튼 */}
                  {(() => {
                    const sidoChecked = addedRegions.some(a => a.id === sheetSido);
                    return (
                      <button
                        onClick={() => {
                          setAddedRegions(prev => {
                            const exists = prev.some(a => a.id === sheetSido);
                            if (exists) {
                              if (regionId === sheetSido) { setScope('gu'); setRegionId(null); }
                              return prev.filter(a => a.id !== sheetSido);
                            }
                            setRegionId(sheetSido);
                            setScope(sheetSido);
                            setPage(0);
                            return [...prev, { id: sheetSido, sido: sheetSido, gu: '' }];
                          });
                        }}
                        className={`flex justify-between items-center w-full cursor-pointer px-[14px] py-[13px] rounded-[14px] mb-[9px] ${sidoChecked ? 'border-[1.5px] border-[#FFD400] bg-[#FFFBE6]' : 'border border-[#EAEAE4] bg-[#F8F8F6]'}`}
                      >
                        <div className="text-left">
                          <div className="text-[14.5px] font-extrabold text-[#191919]">{SIDO_SHORT[sheetSido] ?? sheetSido} 전체</div>
                          <div className="text-[11.5px] text-[#9A9A92] mt-[1px]">시군구 구분 없이 전체 검색</div>
                        </div>
                        <span className="text-[18px] font-extrabold" style={{ color: sidoChecked ? '#C99A00' : '#B8B8B0' }}>{sidoChecked ? '✓' : '＋'}</span>
                      </button>
                    );
                  })()}
                  {guLoading ? (
                    <div className="text-center text-[13px] text-[#ADADA4] py-[20px]">불러오는 중...</div>
                  ) : (
                    <div className="flex flex-col gap-[9px]">
                      {guList.map(({ gu, count }) => {
                        const id = `${sheetSido}/${gu}`;
                        const checked = addedRegions.some(a => a.id === id);
                        return (
                          <button key={gu} onClick={() => sheetSido && toggleRegion(id, sheetSido, gu)}
                            className={`flex justify-between items-center gap-[8px] w-full cursor-pointer px-[14px] py-[13px] rounded-[14px] ${checked ? 'border-[1.5px] border-[#FFD400] bg-[#FFFBE6]' : 'border border-[#EDEDE7] bg-white'}`}>
                            <div className="text-left">
                              <div className="text-[14.5px] font-bold text-[#191919]">{gu}</div>
                              <div className="text-[11.5px] text-[#9A9A92] mt-[2px]">{count.toLocaleString()}개 단지</div>
                            </div>
                            <span className="text-[18px] font-extrabold" style={{ color: checked ? '#C99A00' : '#B8B8B0' }}>{checked ? '✓' : '＋'}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {/* Search bottom sheet */}
        {searchOpen && (
          <>
            <div className="absolute inset-0 bg-[rgba(20,20,18,.34)]" onClick={() => { setSearchOpen(false); setSelectedComplex(null); setQ(''); }} />
            <div className="absolute left-0 right-0 bottom-0 bg-white rounded-t-[26px] px-[20px] pt-[10px] pb-[26px] max-h-[84%] overflow-y-auto" style={{animation:'sheetUp .26s cubic-bezier(.22,1,.36,1)'}}>
              <div className="w-[38px] h-[4px] bg-[#E2E2DC] rounded-[3px] mx-auto mb-[16px] mt-[6px]" />
              {selectedComplex ? (
                <>
                  <button onClick={() => setSelectedComplex(null)} className="flex items-center gap-[6px] text-[13px] text-[#9A9A92] font-semibold mb-[14px] border-none bg-transparent cursor-pointer p-0">‹ 다시 검색</button>
                  <div className="text-[17px] font-extrabold text-[#191919] mb-[4px]">{selectedComplex.name}</div>
                  <div className="text-[12.5px] text-[#8A8A82] mb-[20px]">{selectedComplex.gu} {selectedComplex.dong} · {selectedComplex.year_built ?? '-'}년</div>
                  <div className="text-[12px] font-bold text-[#A0A098] mb-[12px]">평형을 선택하세요</div>
                  <div className="flex flex-col gap-[9px]">
                    {selectedComplex.variants.map(v => (
                      <button key={v.aptId} onClick={() => handlePickPyeong(v.aptId)}
                        className="flex items-center justify-between border border-[#EDEDE7] bg-white rounded-[14px] px-[16px] py-[14px] cursor-pointer w-full hover:border-[#FFD400] hover:bg-[#FFFBE6] transition-colors">
                        <div className="text-left">
                          <div className="text-[15px] font-extrabold text-[#191919]">{v.pyeong}평</div>
                          <div className="text-[11.5px] text-[#9A9A92] mt-[2px]">{v.area}㎡</div>
                        </div>
                        <span className="text-[16px] font-extrabold text-[#191919]">{won(v.price)}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-[17px] font-extrabold text-[#191919] mb-[13px]">관심 아파트 선택</div>
                  <div className="flex items-center gap-[8px] bg-[#F4F4F0] rounded-[14px] px-[14px] py-[12px] mb-[16px]">
                    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                      <circle cx="6.5" cy="6.5" r="5" stroke="#B0B0A8" strokeWidth="2"/>
                      <path d="M10.5 10.5L13 13" stroke="#B0B0A8" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                    <input value={q} onChange={e => setQ(e.target.value)} placeholder="아파트명으로 검색" autoFocus
                      className="border-none bg-transparent outline-none text-[14px] flex-1 text-[#191919] placeholder:text-[#ADADA4]" />
                  </div>
                  <div className="text-[12px] font-bold text-[#A0A098] mb-[9px]">검색 결과</div>
                  {searchLoading && <div className="text-center text-[13px] text-[#ADADA4] py-[16px]">검색 중...</div>}
                  <div className="flex flex-col gap-[8px]">
                    {searchResults.map(c => (
                      <button key={`${c.name}-${c.gu}`} onClick={() => handlePickComplex(c)}
                        className="flex items-center justify-between gap-[10px] border border-[#EFEFE9] bg-white rounded-[14px] px-[14px] py-[12px] cursor-pointer w-full hover:border-[#FFD400] hover:bg-[#FFFBE6] transition-colors">
                        <div className="text-left min-w-0">
                          <div className="flex items-center gap-[6px]">
                            <span className="text-[14.5px] font-bold text-[#191919] truncate">{c.name}</span>
                            <span className="text-[10px] font-semibold text-[#C99A00] bg-[#FFF6D6] px-[5px] py-[1px] rounded-[4px] flex-none whitespace-nowrap">
                              {c.sido.replace('특별시','').replace('광역시','').replace('특별자치시','').replace('특별자치도','').replace('도','').replace('시','')}
                            </span>
                          </div>
                          <div className="text-[11.5px] text-[#9A9A92] mt-[2px]">{c.gu} {c.dong} · {c.variants.map(v => `${v.pyeong}평`).join('/')}</div>
                        </div>
                        <span className="text-[12px] text-[#9A9A92] whitespace-nowrap">평형 선택 ›</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {/* Toast */}
        <div className={`fixed bottom-[32px] left-1/2 -translate-x-1/2 bg-[#1A1A1A] text-white text-[13px] font-semibold px-[18px] py-[11px] rounded-[12px] shadow-lg transition-all duration-200 whitespace-nowrap pointer-events-none z-50 ${toast ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>
          서비스 준비중입니다
        </div>

      </div>
    </div>
  );
}
