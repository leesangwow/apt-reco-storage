'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

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

type Step = 'search' | 'pyeong';

export default function LandingPage() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Complex[]>([]);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<Step>('search');
  const [selectedComplex, setSelectedComplex] = useState<Complex | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

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
    setStep('pyeong');
  }

  function handleSelectPyeong(aptId: number) {
    router.push(`/recommend?aptId=${aptId}`);
  }

  function handleBack() {
    setStep('search');
    setSelectedComplex(null);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  return (
    <div className="min-h-screen bg-[#F5F5F1] flex flex-col items-center justify-center px-[20px]">

      {/* Logo */}
      <div className="mb-[48px] text-center">
        <div className="text-[28px] font-extrabold text-[#191919] tracking-tight leading-tight mb-[8px]">비슷한집</div>
        <div className="text-[14px] text-[#8A8A82] font-medium">관심 아파트와 가격대가 닮은 단지를 찾아드려요</div>
      </div>

      <div className="w-full max-w-[390px]">
        {step === 'search' ? (
          <div className="bg-white rounded-[24px] shadow-[0_4px_24px_rgba(0,0,0,.07)] overflow-hidden">
            {/* Input */}
            <div className="flex items-center gap-[10px] px-[18px] py-[16px] border-b border-[#F2F2EE]">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="flex-none">
                <circle cx="7.5" cy="7.5" r="5.5" stroke="#B0B0A8" strokeWidth="2"/>
                <path d="M12.5 12.5L15.5 15.5" stroke="#B0B0A8" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              <input
                ref={inputRef}
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="관심 아파트 이름을 입력하세요"
                className="flex-1 border-none bg-transparent outline-none text-[15px] text-[#191919] placeholder:text-[#ADADA4] font-medium"
              />
              {q && (
                <button onClick={() => { setQ(''); setResults([]); inputRef.current?.focus(); }}
                  className="flex-none border-none bg-transparent cursor-pointer text-[#ADADA4] text-[18px] leading-none p-0">×</button>
              )}
            </div>

            {/* Results */}
            <div className="max-h-[360px] overflow-y-auto">
              {loading && (
                <div className="px-[18px] py-[24px] text-center text-[13px] text-[#ADADA4]">검색 중...</div>
              )}
              {!loading && q.trim() && results.length === 0 && (
                <div className="px-[18px] py-[32px] text-center text-[14px] text-[#ADADA4]">검색 결과가 없어요</div>
              )}
              {!loading && results.length > 0 && (
                <div className="flex flex-col">
                  {results.map((c, i) => (
                    <button key={`${c.name}-${c.gu}-${c.dong}`} onClick={() => handleSelectComplex(c)}
                      className={`flex items-center justify-between gap-[12px] px-[18px] py-[14px] cursor-pointer bg-transparent border-none text-left w-full hover:bg-[#FAFAF8] transition-colors ${i !== 0 ? 'border-t border-[#F4F4F0]' : ''}`}
                    >
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
                        <div className="text-[13px] font-semibold text-[#9A9A92]">
                          {won(Math.min(...c.variants.map(v => v.price)))} ~
                        </div>
                        <div className="text-[11px] text-[#C0C0B8] mt-[1px]">평형 선택 ›</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {!q.trim() && (
                <div className="px-[18px] py-[32px] text-center text-[13px] text-[#ADADA4]">
                  단지명을 입력하면 검색 결과가 나타납니다
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Pyeong selection */
          <div className="bg-white rounded-[24px] shadow-[0_4px_24px_rgba(0,0,0,.07)] overflow-hidden">
            <div className="px-[18px] py-[16px] border-b border-[#F2F2EE]">
              <button onClick={handleBack}
                className="flex items-center gap-[5px] text-[13px] text-[#9A9A92] font-semibold border-none bg-transparent cursor-pointer p-0 mb-[12px]">
                ‹ 다시 검색
              </button>
              <div className="text-[17px] font-extrabold text-[#191919] mb-[2px]">{selectedComplex?.name}</div>
              <div className="text-[12.5px] text-[#8A8A82]">
                {selectedComplex?.gu} {selectedComplex?.dong} · {selectedComplex?.year_built ?? '-'}년
                {selectedComplex?.hh ? ` · ${selectedComplex.hh.toLocaleString()}세대` : ''}
              </div>
            </div>
            <div className="px-[18px] py-[20px]">
              <div className="text-[12px] font-bold text-[#A0A098] mb-[14px]">평형을 선택하세요</div>
              <div className="flex flex-col gap-[10px]">
                {selectedComplex?.variants.map(v => (
                  <button key={v.aptId} onClick={() => handleSelectPyeong(v.aptId)}
                    className="flex items-center justify-between border border-[#EDEDE7] bg-white rounded-[16px] px-[16px] py-[15px] cursor-pointer w-full hover:border-[#FFD400] hover:bg-[#FFFBE6] transition-colors group">
                    <div className="text-left">
                      <div className="text-[16px] font-extrabold text-[#191919]">
                        {v.pyeong}평
                        <span className="ml-[8px] text-[13px] font-medium text-[#9A9A92]">{v.area}㎡</span>
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
          </div>
        )}
      </div>

      <div className="mt-[32px] text-[12px] text-[#ADADA4] text-center">
        국토교통부 실거래가 기준 · 최근 6개월 평균
      </div>
    </div>
  );
}
