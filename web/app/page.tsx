'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { SIDO_SHORT } from '@/lib/regions';

const SIDO_ORDER = [
  '서울특별시', '경기도', '인천광역시', '부산광역시', '대구광역시',
  '대전광역시', '광주광역시', '울산광역시', '세종특별자치시',
  '강원특별자치도', '충청북도', '충청남도', '전북특별자치도',
  '전라남도', '경상북도', '경상남도', '제주특별자치도',
];

function won(n: number): string {
  const v = Math.abs(n);
  const t = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return t + '억';
}

interface AptVariant { aptId: number; pyeong: number; area: number; price: number; }
interface Complex {
  name: string; sido: string; gu: string; dong: string;
  year_built: number | null; hh: number | null;
  variants: AptVariant[];
}

type Tab = 'name' | 'price';
type NameStep = 'search' | 'pyeong';

export default function LandingPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('name');

  // 아파트명 검색
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Complex[]>([]);
  const [loading, setLoading] = useState(false);
  const [nameStep, setNameStep] = useState<NameStep>('search');
  const [selectedComplex, setSelectedComplex] = useState<Complex | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 가격대 탐색
  const [priceInput, setPriceInput] = useState('');
  const [sidoList, setSidoList] = useState<string[]>([]);
  const [selectedSido, setSelectedSido] = useState('');
  const [guList, setGuList] = useState<{ gu: string; count: number }[]>([]);
  const [selectedGu, setSelectedGu] = useState('');
  const [guLoading, setGuLoading] = useState(false);

  useEffect(() => {
    if (tab === 'name') inputRef.current?.focus();
  }, [tab]);

  // 시도 목록 로드
  useEffect(() => {
    fetch('/api/regions')
      .then(r => r.json())
      .then(setSidoList)
      .catch(() => {});
  }, []);

  // 구 목록 lazy load
  useEffect(() => {
    if (!selectedSido) return;
    setSelectedGu('');
    setGuList([]);
    setGuLoading(true);
    fetch(`/api/regions?sido=${encodeURIComponent(selectedSido)}`)
      .then(r => r.json())
      .then(setGuList)
      .catch(() => {})
      .finally(() => setGuLoading(false));
  }, [selectedSido]);

  // 아파트명 검색
  const fetchSearch = useCallback(async (keyword: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(keyword)}`);
      const data = await res.json();
      setResults(Array.isArray(data) ? data : []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 1) { setResults([]); return; }
    debounceRef.current = setTimeout(() => fetchSearch(q.trim()), 300);
  }, [q, fetchSearch]);

  function handleSelectComplex(c: Complex) {
    if (c.variants.length === 1) {
      router.push(`/recommend?aptId=${c.variants[0].aptId}`);
      return;
    }
    setSelectedComplex(c);
    setNameStep('pyeong');
  }

  function handleSelectPyeong(aptId: number) {
    router.push(`/recommend?aptId=${aptId}`);
  }

  function handlePriceSearch() {
    const price = parseFloat(priceInput);
    if (!price || price <= 0) return;
    if (!selectedSido || !selectedGu) return;
    const params = new URLSearchParams({
      price: String(price),
      sido: selectedSido,
      gu: selectedGu,
    });
    router.push(`/recommend?${params.toString()}`);
  }

  const priceReady = priceInput && parseFloat(priceInput) > 0 && selectedSido && selectedGu;

  return (
    <div className="min-h-screen bg-[#F5F5F1] flex flex-col items-center justify-center px-[20px]">

      {/* Logo */}
      <div className="mb-[48px] text-center">
        <div className="text-[28px] font-extrabold text-[#191919] tracking-tight leading-tight mb-[8px]">비슷한집</div>
        <div className="text-[14px] text-[#8A8A82] font-medium">관심 아파트와 가격대가 닮은 단지를 찾아드려요</div>
      </div>

      <div className="w-full max-w-[390px]">

        {/* 탭 */}
        <div className="flex bg-[#EAEAE4] rounded-[14px] p-[3px] mb-[12px]">
          {(['name', 'price'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 text-[13px] font-bold py-[8px] rounded-[11px] transition-all cursor-pointer border-none ${tab === t ? 'bg-white text-[#191919] shadow-sm' : 'bg-transparent text-[#8A8A82]'}`}>
              {t === 'name' ? '아파트명으로 검색' : '가격대로 찾기'}
            </button>
          ))}
        </div>

        {/* 아파트명 검색 */}
        {tab === 'name' && (
          <div className="bg-white rounded-[24px] shadow-[0_4px_24px_rgba(0,0,0,.07)] overflow-hidden">
            {nameStep === 'search' ? (
              <>
                <div className="flex items-center gap-[10px] px-[18px] py-[16px] border-b border-[#F2F2EE]">
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="flex-none">
                    <circle cx="7.5" cy="7.5" r="5.5" stroke="#B0B0A8" strokeWidth="2"/>
                    <path d="M12.5 12.5L15.5 15.5" stroke="#B0B0A8" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)}
                    placeholder="관심 아파트 이름을 입력하세요"
                    className="flex-1 border-none bg-transparent outline-none text-[15px] text-[#191919] placeholder:text-[#ADADA4] font-medium" />
                  {q && (
                    <button onClick={() => { setQ(''); setResults([]); inputRef.current?.focus(); }}
                      className="flex-none border-none bg-transparent cursor-pointer text-[#ADADA4] text-[18px] leading-none p-0">×</button>
                  )}
                </div>
                <div className="max-h-[360px] overflow-y-auto">
                  {loading && <div className="px-[18px] py-[24px] text-center text-[13px] text-[#ADADA4]">검색 중...</div>}
                  {!loading && q.trim() && results.length === 0 && (
                    <div className="px-[18px] py-[32px] text-center text-[14px] text-[#ADADA4]">검색 결과가 없어요</div>
                  )}
                  {!loading && results.length > 0 && (
                    <div className="flex flex-col">
                      {results.map((c, i) => (
                        <button key={`${c.name}-${c.gu}-${c.dong}`} onClick={() => handleSelectComplex(c)}
                          className={`flex items-center justify-between gap-[12px] px-[18px] py-[14px] cursor-pointer bg-transparent border-none text-left w-full hover:bg-[#FAFAF8] transition-colors ${i !== 0 ? 'border-t border-[#F4F4F0]' : ''}`}>
                          <div className="min-w-0">
                            <div className="flex items-center gap-[6px]">
                              <span className="text-[15px] font-bold text-[#191919] line-clamp-2 break-keep">{c.name}</span>
                              <span className="text-[10px] font-semibold text-[#C99A00] bg-[#FFF6D6] px-[5px] py-[1px] rounded-[4px] flex-none whitespace-nowrap">
                                {c.sido.replace('특별시','').replace('광역시','').replace('특별자치시','').replace('특별자치도','').replace('도','').replace('시','')}
                              </span>
                            </div>
                            <div className="text-[12px] text-[#9A9A92] mt-[2px]">
                              {c.gu} {c.dong} · {c.year_built ?? '-'}년 · {c.variants.map(v => `${v.pyeong}평`).join(' / ')}
                            </div>
                          </div>
                          <div className="flex-none text-right">
                            <div className="text-[13px] font-semibold text-[#9A9A92]">{won(Math.min(...c.variants.map(v => v.price)))} ~</div>
                            <div className="text-[11px] text-[#C0C0B8] mt-[1px]">평형 선택 ›</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  {!q.trim() && (
                    <div className="px-[18px] py-[32px] text-center text-[13px] text-[#ADADA4]">단지명을 입력하면 검색 결과가 나타납니다</div>
                  )}
                </div>
              </>
            ) : (
              <div className="px-[18px] py-[16px]">
                <button onClick={() => { setNameStep('search'); setSelectedComplex(null); }}
                  className="flex items-center gap-[5px] text-[13px] text-[#9A9A92] font-semibold border-none bg-transparent cursor-pointer p-0 mb-[12px]">
                  ‹ 다시 검색
                </button>
                <div className="text-[17px] font-extrabold text-[#191919] mb-[2px]">{selectedComplex?.name}</div>
                <div className="text-[12.5px] text-[#8A8A82] mb-[20px]">
                  {selectedComplex?.gu} {selectedComplex?.dong} · {selectedComplex?.year_built ?? '-'}년
                </div>
                <div className="text-[12px] font-bold text-[#A0A098] mb-[14px]">평형을 선택하세요</div>
                <div className="flex flex-col gap-[10px]">
                  {selectedComplex?.variants.map(v => (
                    <button key={v.aptId} onClick={() => handleSelectPyeong(v.aptId)}
                      className="flex items-center justify-between border border-[#EDEDE7] bg-white rounded-[16px] px-[16px] py-[15px] cursor-pointer w-full hover:border-[#FFD400] hover:bg-[#FFFBE6] transition-colors">
                      <div className="text-left">
                        <div className="text-[16px] font-extrabold text-[#191919]">
                          {v.pyeong}평<span className="ml-[8px] text-[13px] font-medium text-[#9A9A92]">{v.area}㎡</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-[8px]">
                        <span className="text-[17px] font-extrabold text-[#191919]">{won(v.price)}</span>
                        <span className="text-[#C0C0B8] text-[16px]">›</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 가격대로 찾기 */}
        {tab === 'price' && (
          <div className="bg-white rounded-[24px] shadow-[0_4px_24px_rgba(0,0,0,.07)] overflow-hidden">
            <div className="px-[18px] py-[20px] flex flex-col gap-[16px]">

              {/* 금액 입력 */}
              <div>
                <div className="text-[12px] font-bold text-[#A0A098] mb-[8px]">기준 금액</div>
                <div className="flex items-center gap-[8px] border border-[#EAEAE4] rounded-[14px] px-[14px] py-[12px]">
                  <input
                    value={priceInput}
                    onChange={e => setPriceInput(e.target.value.replace(/[^0-9.]/g, ''))}
                    placeholder="예) 8, 13.5"
                    className="flex-1 border-none bg-transparent outline-none text-[18px] font-extrabold text-[#191919] placeholder:text-[#ADADA4] placeholder:font-medium placeholder:text-[14px]"
                  />
                  <span className="text-[15px] font-bold text-[#8A8A82] flex-none">억</span>
                </div>
              </div>

              {/* 시도 선택 */}
              <div>
                <div className="text-[12px] font-bold text-[#A0A098] mb-[8px]">시도</div>
                <div className="flex flex-wrap gap-[6px]">
                  {[...sidoList].sort((a, b) => {
                    const ai = SIDO_ORDER.indexOf(a);
                    const bi = SIDO_ORDER.indexOf(b);
                    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
                  }).map(sd => (
                    <button key={sd} onClick={() => setSelectedSido(sd)}
                      className={`border cursor-pointer text-[13px] px-[13px] py-[7px] rounded-[11px] whitespace-nowrap transition-all ${selectedSido === sd ? 'bg-[#1A1A1A] text-white font-extrabold border-transparent' : 'border-[#EAEAE4] bg-white text-[#76766E] font-semibold'}`}>
                      {SIDO_SHORT[sd] ?? sd}
                    </button>
                  ))}
                </div>
              </div>

              {/* 구 선택 */}
              {selectedSido && (
                <div>
                  <div className="text-[12px] font-bold text-[#A0A098] mb-[8px]">{SIDO_SHORT[selectedSido] ?? selectedSido} · 구/시 선택</div>
                  {guLoading ? (
                    <div className="text-center text-[13px] text-[#ADADA4] py-[12px]">불러오는 중...</div>
                  ) : (
                    <div className="grid grid-cols-2 gap-[6px] max-h-[200px] overflow-y-auto">
                      {guList.map(({ gu }) => (
                        <button key={gu} onClick={() => setSelectedGu(gu)}
                          className={`border cursor-pointer text-[13px] px-[12px] py-[9px] rounded-[11px] text-left transition-all ${selectedGu === gu ? 'bg-[#FFD400] text-[#1A1A1A] font-extrabold border-transparent' : 'border-[#EAEAE4] bg-white text-[#3A3A36] font-semibold'}`}>
                          {gu}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 탐색 버튼 */}
              <button
                onClick={handlePriceSearch}
                disabled={!priceReady}
                className={`w-full py-[14px] rounded-[15px] text-[15px] font-extrabold transition-all border-none cursor-pointer ${priceReady ? 'bg-[#FFD400] text-[#1A1A1A]' : 'bg-[#F2F2EE] text-[#ADADA4] cursor-not-allowed'}`}>
                {priceReady ? `${priceInput}억대 · ${SIDO_SHORT[selectedSido] ?? selectedSido} ${selectedGu} 탐색` : '금액과 지역을 선택해주세요'}
              </button>

            </div>
          </div>
        )}
      </div>

      <div className="mt-[32px] text-[12px] text-[#ADADA4] text-center">
        국토교통부 실거래가 기준 · 최근 6개월 평균
      </div>
    </div>
  );
}
