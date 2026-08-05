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

# 수집 기간: 당해연도 1월 1일 ~ 오늘 (HTML date input 형식: YYYY-MM-DD)
YEAR       = datetime.now().year
START_DATE = f"{YEAR}-01-01"
END_DATE   = datetime.now().strftime("%Y-%m-%d")

# 저장 경로
REPO_ROOT = Path(__file__).resolve().parent.parent
BUY_DIR   = REPO_ROOT / "data" / "updates" / "buy"
RENT_DIR  = REPO_ROOT / "data" / "updates" / "rent"

# 수집 지역: (저장파일명, srhSidoCd 값)
# --diagnose 에서 확인된 5자리 코드 사용
BUY_REGIONS = [
    ("choongbuk",     "43000"),  # 충청북도
    ("jeonbuktuk",    "52000"),  # 전북특별자치도
    ("jeonranam",     "12000"),  # 전남광주통합특별시 (구 전라남도)
    ("kyeongsangbuk", "47000"),  # 경상북도
]
RENT_REGIONS = BUY_REGIONS[:]  # 전세도 같은 지역 수집 (필요시 수정)

# ─── 거래유형 설정 ─────────────────────────────────────────────────────────
# srhDelngSecd hidden input으로 거래유형 지정
# 값은 사이트 동작 확인 후 조정 (빈 문자열 = 사이트 기본값)
DEAL_TYPE_VALUE = {
    "buy":  "",   # 매매: 사이트 기본값 사용 (xlsTab1 = 아파트 기본 로드 시 매매)
    "rent": "B",  # 전세: 값 확인 필요 시 --diagnose 후 업데이트
}
# ─────────────────────────────────────────────────────────────────────────────


def screenshot_path(step: str, region_key: str) -> str:
    return f"debug_{step}_{region_key}.png"


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

    # ── 1. 페이지 로드 ─────────────────────────────────────────────
    await page.goto(XLS_URL, wait_until="domcontentloaded", timeout=30_000)
    await page.wait_for_timeout(1_500)

    if debug:
        print(f"     URL: {page.url}")
        await page.screenshot(path=screenshot_path("01_loaded", region_key))

    # ── 1-b. 아파트 탭 활성화 (ID 셀렉터로 폼 탭 정확히 클릭) ────
    await page.click("a#xlsTab1")
    await page.wait_for_timeout(800)

    if debug:
        await page.screenshot(path=screenshot_path("01b_tab", region_key))

    # ── 2. 거래유형 hidden 필드 설정 ─────────────────────────────
    deal_val = DEAL_TYPE_VALUE.get(deal_type, "")
    await page.evaluate(
        f"() => {{ "
        f"  var el = document.getElementById('srhDelngSecd'); "
        f"  if (el) el.value = '{deal_val}'; "
        f"}}"
    )

    if debug:
        print(f"     URL after deal type set: {page.url}")
        await page.screenshot(path=screenshot_path("02_deal", region_key))

    # ── 3. 시작일 / 종료일 설정 (type=date, 형식: YYYY-MM-DD) ─────
    await page.fill("input[name='srhFromDt']", START_DATE)
    await page.fill("input[name='srhToDt']",   END_DATE)

    if debug:
        await page.screenshot(path=screenshot_path("03_date", region_key))

    # ── 4. 시도 선택 ─────────────────────────────────────────────
    await page.select_option("select[name='srhSidoCd']", value=sido_code)
    await page.wait_for_timeout(800)

    if debug:
        print(f"     URL after sido select: {page.url}")
        await page.screenshot(path=screenshot_path("04_sido", region_key))

    # ── 5. CSV 다운로드 ───────────────────────────────────────────
    save_path.parent.mkdir(parents=True, exist_ok=True)
    async with page.expect_download(timeout=60_000) as dl_info:
        await page.click("button:has-text('CSV 다운')")

    dl = await dl_info.value
    suggested = dl.suggested_filename
    await dl.save_as(save_path)

    if debug:
        await page.screenshot(path=screenshot_path("05_done", region_key))

    print(f"  ✓ 저장: {save_path.name}  (원본: {suggested})")


async def diagnose(headless: bool = False):
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

        html_path = Path("xls_page.html")
        html_path.write_text(await page.content(), encoding="utf-8")
        print(f"HTML 저장: {html_path.resolve()}\n")

        await page.screenshot(path="diagnose.png", full_page=True)
        print("스크린샷 저장: diagnose.png\n")

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

            print(f"\n[{label}] {len(regions)}개 지역 수집 시작 ({START_DATE} ~ {END_DATE})")
            for region_key, sido_code in regions:
                save_path = save_dir / f"{region_key}_{YEAR}.csv"
                try:
                    await download_one(page, deal_type, region_key, sido_code, save_path, debug)
                    await asyncio.sleep(2)
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
        asyncio.run(diagnose(headless=False))
        return

    deal_types = ["buy", "rent"] if args.type == "all" else [args.type]
    asyncio.run(run(deal_types, headless, args.debug))


if __name__ == "__main__":
    main()
