#!/usr/bin/env python3
"""
국토부 실거래가 공개시스템에서 아파트 CSV 자동 다운로드

사용법:
  pip install playwright
  playwright install chromium

  python scripts/download_csv.py --diagnose         # 페이지 폼 구조 확인 (셀렉터 파악용)
  python scripts/download_csv.py --type buy         # 매매 CSV
  python scripts/download_csv.py --type rent        # 전세 CSV
  python scripts/download_csv.py --type all         # 전체 (기본값)
  python scripts/download_csv.py --type buy --debug # 각 단계 스크린샷 저장
  python scripts/download_csv.py --type buy --show  # 브라우저 화면 표시 (셀렉터 확인용)

셀렉터 조정이 필요하면 아래 SELECTORS 딕셔너리를 수정하세요.
"""

import argparse
import asyncio
import sys
from datetime import datetime
from pathlib import Path

try:
    from playwright.async_api import async_playwright, TimeoutError as PWTimeout
except ImportError:
    print("playwright가 설치되지 않았습니다. 다음 명령을 실행하세요:")
    print("  pip install playwright && playwright install chromium")
    sys.exit(1)


# ─── 설정 ──────────────────────────────────────────────────────────────────
XLS_URL = "https://rt.molit.go.kr/pt/xls/xls.do?mobileAt="

# 수집 기간: 당해연도 1월 1일 ~ 오늘
YEAR       = datetime.now().year
START_DATE = f"{YEAR}0101"
END_DATE   = datetime.now().strftime("%Y%m%d")

# 저장 경로
REPO_ROOT = Path(__file__).resolve().parent.parent
BUY_DIR   = REPO_ROOT / "data" / "updates" / "buy"
RENT_DIR  = REPO_ROOT / "data" / "updates" / "rent"

# 수집 지역: (저장파일명, 시도코드)
# 시도코드: 서울11 부산26 대구27 인천28 광주29 대전30 울산31 세종36
#           경기41 강원42 충북43 충남44 전북45 전남46 경북47 경남48 제주50
BUY_REGIONS = [
    ("choongbuk",     "43"),  # 충청북도
    ("jeonbuktuk",    "45"),  # 전북특별자치도
    ("jeonranam",     "46"),  # 전라남도
    ("kyeongsangbuk", "47"),  # 경상북도
]
RENT_REGIONS = BUY_REGIONS[:]  # 전세도 같은 지역 수집 (필요시 수정)

# ─── 셀렉터 ── --diagnose 결과 확인 후 이 값을 업데이트하세요 ────────────────
SELECTORS = {
    # 거래유형 select (--diagnose 로 name/id 확인 후 업데이트)
    # 매매 value, 전세 value도 option 목록에서 확인 필요
    "deal_type_select": (
        "select[name='srhThingSecd'],"
        "select[name='dealType'],"
        "select[name='thingSecd'],"
        "select[name='srhDealType']"
    ),
    "deal_type_buy":  "A",   # 매매 option value (--diagnose 후 확인)
    "deal_type_rent": "B",   # 전세 option value (--diagnose 후 확인)

    # 기간 입력 (YYYYMMDD 형식)
    "start_date": (
        "input[name='startDt'],"
        "input[id='startDt'],"
        "input[name='srchStartDt'],"
        "input[placeholder*='시작']"
    ),
    "end_date": (
        "input[name='endDt'],"
        "input[id='endDt'],"
        "input[name='srchEndDt'],"
        "input[placeholder*='종료']"
    ),

    # 시도 선택 드롭다운
    "sido": (
        "select[name='srhSidoCd'],"
        "select[name='sidoCd'],"
        "select[name='sido'],"
        "select[name='srhArea1']"
    ),

    # 조회 버튼
    "search": (
        "button:has-text('조회'),"
        "input[type='submit'][value*='조회'],"
        "a:has-text('조회')"
    ),

    # 다운로드 버튼 (CSV 우선, 없으면 Excel)
    "download_csv":   "button:has-text('CSV'), a:has-text('CSV')",
    "download_excel": "button:has-text('다운로드'), a:has-text('다운로드'), button:has-text('엑셀'), a:has-text('엑셀')",
}
# ─────────────────────────────────────────────────────────────────────────────


def screenshot_path(step: str, region_key: str) -> str:
    return f"debug_{step}_{region_key}.png"


async def fill_date(page, selector_str: str, value: str):
    """날짜 input 채우기 - 여러 셀렉터를 순서대로 시도"""
    loc = page.locator(selector_str).first
    try:
        await loc.wait_for(timeout=5_000)
        await loc.triple_click()
        await loc.fill(value)
        await loc.press("Tab")
    except PWTimeout:
        raise RuntimeError(f"날짜 input을 찾지 못했습니다. 셀렉터 확인: {selector_str}")


async def select_sido(page, selector_str: str, sido_code: str):
    """시도 드롭다운 선택"""
    loc = page.locator(selector_str).first
    try:
        await loc.wait_for(timeout=5_000)
        await loc.select_option(value=sido_code)
        await page.wait_for_timeout(800)
    except PWTimeout:
        raise RuntimeError(f"시도 드롭다운을 찾지 못했습니다. 셀렉터 확인: {selector_str}")


async def click_first(page, selector_str: str, timeout: int = 8_000, required: bool = True):
    """여러 셀렉터 중 처음 발견된 요소 클릭"""
    for sel in [s.strip() for s in selector_str.split(",")]:
        try:
            await page.click(sel, timeout=timeout)
            return True
        except PWTimeout:
            continue
    if required:
        raise RuntimeError(f"클릭 대상을 찾지 못했습니다: {selector_str}")
    return False


async def download_one(
    page,
    deal_type: str,
    region_key: str,
    sido_code: str,
    save_path: Path,
    debug: bool = False,
):
    """한 지역·한 거래유형의 CSV 다운로드"""
    label = "매매" if deal_type == "buy" else "전세"
    print(f"  [{label}] {region_key} (시도코드={sido_code}) 다운로드 중...")

    # ── 1. 페이지 이동 ────────────────────────────────────────────
    await page.goto(XLS_URL, wait_until="domcontentloaded", timeout=30_000)
    await page.wait_for_timeout(1_000)

    if debug:
        print(f"     현재 URL: {page.url}")
        await page.screenshot(path=screenshot_path("01_loaded", region_key))
        print(f"     스크린샷 저장: {screenshot_path('01_loaded', region_key)}")

    # ── 2. 거래유형 select로 선택 (네비게이션 없이) ────────────────
    deal_value = SELECTORS["deal_type_buy"] if deal_type == "buy" else SELECTORS["deal_type_rent"]
    deal_loc = page.locator(SELECTORS["deal_type_select"]).first
    try:
        await deal_loc.wait_for(timeout=5_000)
        await deal_loc.select_option(value=deal_value)
        await page.wait_for_timeout(500)
    except PWTimeout:
        print(f"     경고: 거래유형 select를 찾지 못했습니다 — --diagnose로 확인 필요")

    if debug:
        print(f"     현재 URL: {page.url}")
        await page.screenshot(path=screenshot_path("02_type", region_key))

    # ── 4. 기간 입력 ─────────────────────────────────────────────
    await fill_date(page, SELECTORS["start_date"], START_DATE)
    await fill_date(page, SELECTORS["end_date"],   END_DATE)

    # ── 5. 시도 선택 ─────────────────────────────────────────────
    await select_sido(page, SELECTORS["sido"], sido_code)

    if debug:
        await page.screenshot(path=screenshot_path("03_region", region_key))

    # ── 6. 조회 ──────────────────────────────────────────────────
    await click_first(page, SELECTORS["search"])
    await page.wait_for_load_state("networkidle", timeout=30_000)

    if debug:
        await page.screenshot(path=screenshot_path("04_results", region_key))

    # ── 7. 다운로드 ───────────────────────────────────────────────
    save_path.parent.mkdir(parents=True, exist_ok=True)
    async with page.expect_download(timeout=60_000) as dl_info:
        if not await click_first(page, SELECTORS["download_csv"], timeout=5_000, required=False):
            await click_first(page, SELECTORS["download_excel"])

    dl = await dl_info.value
    suggested = dl.suggested_filename
    await dl.save_as(save_path)

    if debug:
        await page.screenshot(path=screenshot_path("05_done", region_key))

    print(f"  ✓ 저장: {save_path}  (원본파일명: {suggested})")


async def diagnose(headless: bool):
    """xls.do 페이지의 폼 구조를 출력하고 HTML을 저장 (셀렉터 파악용)"""
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=headless,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        page = await browser.new_page()
        print(f"페이지 로딩 중: {XLS_URL}")
        await page.goto(XLS_URL, wait_until="domcontentloaded", timeout=30_000)
        await page.wait_for_timeout(2_000)
        print(f"현재 URL: {page.url}\n")

        # HTML 저장
        html = await page.content()
        html_path = Path("xls_page.html")
        html_path.write_text(html, encoding="utf-8")
        print(f"HTML 저장: {html_path.resolve()}\n")

        # 스크린샷
        await page.screenshot(path="diagnose.png", full_page=True)
        print("스크린샷 저장: diagnose.png\n")

        # 폼 요소 출력
        elements = await page.evaluate("""() => {
            const r = { selects: [], inputs: [], buttons: [] };
            document.querySelectorAll('select').forEach(el => {
                r.selects.push({
                    name: el.name, id: el.id,
                    options: Array.from(el.options).map(o => o.value + ' → ' + o.text.trim())
                });
            });
            document.querySelectorAll('input').forEach(el => {
                r.inputs.push({
                    name: el.name, id: el.id, type: el.type,
                    value: el.value, placeholder: el.placeholder
                });
            });
            document.querySelectorAll('button, input[type=submit], a[onclick]').forEach(el => {
                const txt = (el.innerText || el.value || '').trim();
                if (txt) r.buttons.push({ tag: el.tagName, text: txt, id: el.id, name: el.name });
            });
            return r;
        }""")

        print("=== SELECT 요소 ===")
        for s in elements["selects"]:
            print(f"  name='{s['name']}' id='{s['id']}'")
            for opt in s["options"]:
                print(f"    {opt}")

        print("\n=== INPUT 요소 ===")
        for i in elements["inputs"]:
            print(f"  type={i['type']} name='{i['name']}' id='{i['id']}' placeholder='{i['placeholder']}'")

        print("\n=== BUTTON/SUBMIT/LINK 요소 ===")
        for b in elements["buttons"]:
            print(f"  <{b['tag']}> text='{b['text']}' id='{b['id']}' name='{b['name']}'")

        await browser.close()
        print("\n확인 후 SELECTORS 딕셔너리를 업데이트하세요.")


async def run(deal_types: list, headless: bool, debug: bool):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=headless,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = await browser.new_context(accept_downloads=True)
        page = await context.new_page()
        page.set_default_timeout(20_000)

        failed = []
        for deal_type in deal_types:
            regions  = BUY_REGIONS  if deal_type == "buy"  else RENT_REGIONS
            save_dir = BUY_DIR      if deal_type == "buy"  else RENT_DIR
            label    = "매매"       if deal_type == "buy"  else "전세"

            print(f"\n[{label}] {len(regions)}개 지역 수집 시작 ({START_DATE}~{END_DATE})")
            for region_key, sido_code in regions:
                save_path = save_dir / f"{region_key}_{YEAR}.csv"
                try:
                    await download_one(page, deal_type, region_key, sido_code, save_path, debug)
                    await asyncio.sleep(2)  # 서버 부하 방지
                except Exception as exc:
                    print(f"  ✗ {region_key} 실패: {exc}")
                    if debug:
                        try:
                            await page.screenshot(path=screenshot_path("error", region_key))
                        except Exception:
                            pass
                    failed.append((deal_type, region_key, str(exc)))

        await browser.close()

    if failed:
        print("\n실패 목록:")
        for dt, rk, err in failed:
            print(f"  - [{dt}] {rk}: {err}")
        sys.exit(1)
    else:
        print("\n모든 다운로드 완료")


def main():
    parser = argparse.ArgumentParser(description="국토부 실거래가 CSV 자동 다운로드")
    parser.add_argument(
        "--diagnose", action="store_true",
        help="xls.do 페이지 폼 구조 출력 + HTML 저장 (셀렉터 파악용)",
    )
    parser.add_argument(
        "--type", choices=["buy", "rent", "all"], default="all",
        help="수집 유형 (기본값: all)",
    )
    parser.add_argument(
        "--debug", action="store_true",
        help="각 단계 스크린샷 저장 (문제 파악용)",
    )
    parser.add_argument(
        "--show", action="store_true",
        help="브라우저 화면 표시 (헤드리스 OFF, 셀렉터 확인용)",
    )
    args = parser.parse_args()

    headless = not args.show

    if args.diagnose:
        asyncio.run(diagnose(headless=False))  # 진단 시 항상 브라우저 표시
        return

    deal_types = ["buy", "rent"] if args.type == "all" else [args.type]
    asyncio.run(run(deal_types, headless, args.debug))


if __name__ == "__main__":
    main()
