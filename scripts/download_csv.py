#!/usr/bin/env python3
"""
국토부 실거래가 공개시스템에서 아파트 CSV 자동 다운로드

사용법:
  pip install playwright
  playwright install chromium

  python scripts/download_csv.py --diagnose         # 페이지 폼 구조 확인 (셀렉터 파악용)
  python scripts/download_csv.py --type buy         # 매매 CSV
  python scripts/download_csv.py --type rent        # 전월세 CSV
  python scripts/download_csv.py --type all         # 전체 (기본값)
  python scripts/download_csv.py --type buy --debug # 각 단계 스크린샷 저장
  python scripts/download_csv.py --type buy --show  # 브라우저 화면 표시 (셀렉터 확인용)

  # 실패한 지역만 재실행
  python scripts/download_csv.py --list-regions
  python scripts/download_csv.py --region gyeonggi,seoul
"""

import argparse
import asyncio
import sys
from datetime import datetime, timedelta
from pathlib import Path

# 수집은 수십 분이 걸리고 CI 로그·파일로 리다이렉트되는 일이 많다.
# 기본 블록 버퍼링이면 끝날 때까지 진행 상황이 한 줄도 안 보인다.
sys.stdout.reconfigure(line_buffering=True)

try:
    from playwright.async_api import async_playwright, TimeoutError as PWTimeout
except ImportError:
    print("playwright가 설치되지 않았습니다. 다음 명령을 실행하세요:")
    print("  pip install playwright && playwright install chromium")
    sys.exit(1)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_log import RunLogger  # noqa: E402


# ─── 설정 ──────────────────────────────────────────────────────────────────
XLS_URL = "https://rt.molit.go.kr/pt/xls/xls.do?mobileAt="

# 수집 기간: 오늘로부터 1년 전 ~ 오늘 (HTML date input 형식: YYYY-MM-DD)
#
# 연초에 "당해 1월 1일부터"로 잡으면, 계약 후 30일 이내 신고 규정 때문에
# 전년 12월 계약분이 1월에 신고될 때 어떤 실행의 수집 범위에도 안 들어와 영구 누락된다.
# 롤링 1년 창으로 잡으면 지연 신고분이 다음 주 실행에서 다시 걸린다.
# (사이트 제한: 시도별 조회는 최대 366일)
_TODAY     = datetime.now()
START_DATE = (_TODAY - timedelta(days=365)).strftime("%Y-%m-%d")
END_DATE   = _TODAY.strftime("%Y-%m-%d")

# 저장 경로
REPO_ROOT = Path(__file__).resolve().parent.parent
BUY_DIR   = REPO_ROOT / "data" / "updates" / "buy"
RENT_DIR  = REPO_ROOT / "data" / "updates" / "rent"

# 수집 지역: (저장파일명, srhSidoCd 값)
# 사이트가 제공하는 시도 전체(16개). 코드는 --diagnose로 확인한 5자리 값.
# 순서는 시도코드 오름차순 — 사이트 셀렉트 박스와 같다.
BUY_REGIONS = [
    ("seoul",         "11000"),  # 서울특별시
    ("jeonranam",     "12000"),  # 전남광주통합특별시 (광주 포함)
    ("busan",         "26000"),  # 부산광역시
    ("daegu",         "27000"),  # 대구광역시
    ("incheon",       "28000"),  # 인천광역시
    ("daejeon",       "30000"),  # 대전광역시
    ("ulsan",         "31000"),  # 울산광역시
    ("sejong",        "36000"),  # 세종특별자치시
    ("gyeonggi",      "41000"),  # 경기도 — 가장 큼 (전월세 64MB)
    ("choongbuk",     "43000"),  # 충청북도
    ("choongnam",     "44000"),  # 충청남도
    ("kyeongsangbuk", "47000"),  # 경상북도
    ("kyeongsangnam", "48000"),  # 경상남도
    ("jeju",          "50000"),  # 제주특별자치도
    ("gangwon",       "51000"),  # 강원특별자치도
    ("jeonbuktuk",    "52000"),  # 전북특별자치도
]
RENT_REGIONS = BUY_REGIONS[:]  # 전월세도 같은 지역 수집

# ─── 거래유형 설정 ─────────────────────────────────────────────────────────
# 페이지의 fnRtToLr(val) 에 넘기는 값 (srhDelngSecd hidden input 값)
DEAL_TYPE_VALUE = {
    "buy":  "1",  # 매매
    "rent": "2",  # 전월세
}

# 물건구분: fnThingChange(val) — A=아파트
THING_APARTMENT = "A"

DEAL_LABEL = {"buy": "매매", "rent": "전월세"}

# ─── 타임아웃 / 재시도 ──────────────────────────────────────────────────────
# 1년치 시도 단위 조회는 서버에서 파일을 만드는 데만 수 분이 걸릴 수 있고,
# 큰 조회 직후에는 후속 요청까지 함께 느려진다. 넉넉히 잡고 실패 시 재시도한다.
GOTO_TIMEOUT_MS     = 90_000
DOWNLOAD_TIMEOUT_MS = 300_000
MAX_ATTEMPTS        = 3
RETRY_BACKOFF_SEC   = 30   # 재시도 전 대기 (서버 회복 시간)
BETWEEN_REGIONS_SEC = 5    # 지역 간 간격

# 사이트가 통째로 응답하지 않을 때(심야 점검 등) 남은 지역을 계속 두드려봐야 전부 실패한다.
# 2026-08-06 새벽 실행이 32건 × 3회 재시도를 다 돌면서 2시간을 태우고 한 건도 못 받았다.
# 연속으로 이만큼 지역이 실패하면 개별 지역 문제가 아니라고 보고 나머지를 포기한다.
ABORT_AFTER_CONSECUTIVE_FAILURES = 3
# ─────────────────────────────────────────────────────────────────────────────


def screenshot_path(step: str, region_key: str) -> str:
    return f"debug_{step}_{region_key}.png"


async def download_one(
    page,
    deal_type: str,
    region_key: str,
    sido_code: str,
    save_path: Path,
    alerts: list,
    debug: bool = False,
):
    """한 지역·한 거래유형의 CSV 다운로드"""
    label = DEAL_LABEL[deal_type]
    print(f"  [{label}] {region_key} (시도코드={sido_code}) 다운로드 중...")

    # ── 1. 페이지 로드 ─────────────────────────────────────────────
    # 큰 조회 직후에는 서버가 느려져 페이지 로드부터 오래 걸린다.
    await page.goto(XLS_URL, wait_until="domcontentloaded", timeout=GOTO_TIMEOUT_MS)
    await page.wait_for_timeout(1_500)
    alerts.clear()

    if debug:
        await page.screenshot(path=screenshot_path("01_loaded", region_key))

    # ── 2. 물건구분(아파트) · 거래유형(매매/전월세) 전환 ──────────
    # hidden input을 직접 쓰면 사이트가 폼을 재구성하지 않아 다운로드가 실패한다.
    # 반드시 페이지 함수를 호출해 fnSetSearch()까지 태워야 한다.
    await page.evaluate(f"fnThingChange('{THING_APARTMENT}')")
    await page.wait_for_timeout(1_000)
    await page.evaluate(f"fnRtToLr('{DEAL_TYPE_VALUE[deal_type]}')")
    await page.wait_for_timeout(1_000)

    if debug:
        await page.screenshot(path=screenshot_path("02_deal", region_key))

    # ── 3. 시작일 / 종료일 설정 (type=date, 형식: YYYY-MM-DD) ─────
    await page.fill("#srhFromDt", START_DATE)
    await page.fill("#srhToDt",   END_DATE)

    if debug:
        await page.screenshot(path=screenshot_path("03_date", region_key))

    # ── 4. 시도 선택 (읍면동/단지 목록 ajax 재조회 대기) ──────────
    await page.select_option("#srhSidoCd", value=sido_code)
    await page.wait_for_timeout(1_500)

    if debug:
        serialized = await page.evaluate("() => $('#frm_xls').serialize()")
        print(f"     form: {serialized}")
        await page.screenshot(path=screenshot_path("04_sido", region_key))

    # ── 5. CSV 다운로드 ───────────────────────────────────────────
    save_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        async with page.expect_download(timeout=DOWNLOAD_TIMEOUT_MS) as dl_info:
            await page.click("button:has-text('CSV 다운')")
        dl = await dl_info.value
    except PWTimeout:
        # 사이트는 실패 원인을 alert()으로만 알려준다.
        hint = " / ".join(alerts) if alerts else "alert 없음 (네트워크 지연 가능)"
        raise RuntimeError(f"CSV 다운로드 응답 없음 — {hint}") from None

    suggested = dl.suggested_filename
    await dl.save_as(save_path)

    size = save_path.stat().st_size
    if size == 0:
        raise RuntimeError(f"다운로드 파일이 비어 있음: {save_path.name}")

    if debug:
        await page.screenshot(path=screenshot_path("05_done", region_key))

    print(f"  ✓ 저장: {save_path.name}  ({size:,} bytes, 원본: {suggested})")


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


async def run(deal_types: list, headless: bool, debug: bool, only: set | None = None):
    run_log = RunLogger()

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=headless,
            # 화면 표시 모드에서는 각 동작을 눈으로 확인할 수 있게 천천히 실행
            slow_mo=0 if headless else 500,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = await browser.new_context(accept_downloads=True)
        page = await context.new_page()
        page.set_default_timeout(20_000)

        # 사이트는 검증/다운로드 실패를 alert()으로만 알린다. 메시지를 모아 오류에 첨부한다.
        alerts: list = []

        async def on_dialog(dialog):
            alerts.append(dialog.message.replace("\n", " "))
            await dialog.dismiss()

        page.on("dialog", lambda d: asyncio.ensure_future(on_dialog(d)))

        # 거래유형·지역을 한 줄로 펼쳐 둔다. 중간에 포기할 때 남은 작업이
        # 무엇인지 그대로 집어내려면 평평한 목록이 필요하다.
        jobs = []
        for deal_type in deal_types:
            regions = BUY_REGIONS if deal_type == "buy" else RENT_REGIONS
            if only:
                regions = [r for r in regions if r[0] in only]
            jobs += [(deal_type, region_key, sido_code) for region_key, sido_code in regions]

        failed  = []
        skipped = []
        consecutive_failures = 0
        current_deal = None

        for idx, (deal_type, region_key, sido_code) in enumerate(jobs):
            if deal_type != current_deal:
                current_deal = deal_type
                count = sum(1 for job in jobs if job[0] == deal_type)
                print(
                    f"\n[{DEAL_LABEL[deal_type]}] {count}개 지역 수집 시작"
                    f" ({START_DATE} ~ {END_DATE})"
                )

            save_dir = BUY_DIR if deal_type == "buy" else RENT_DIR
            # 롤링 1년 창이라 연도를 파일명에 넣지 않는다.
            # (연도를 넣으면 해가 바뀔 때 옛 파일이 남아 매 실행마다 불필요하게 재적재된다)
            save_path = save_dir / f"{region_key}.csv"

            # 국토부 서버는 조회량이 많으면 응답이 크게 느려진다.
            # 일시적 지연으로 한 지역이 통째로 빠지지 않도록 재시도한다.
            try:
                with run_log.track("download", deal_type, region_key) as entry:
                    entry.from_date = START_DATE
                    entry.to_date   = END_DATE

                    for attempt in range(1, MAX_ATTEMPTS + 1):
                        entry.attempts = attempt
                        try:
                            await download_one(
                                page, deal_type, region_key, sido_code,
                                save_path, alerts, debug,
                            )
                            entry.file_bytes = save_path.stat().st_size
                            await asyncio.sleep(BETWEEN_REGIONS_SEC)
                            break
                        except Exception as exc:
                            last_error = str(exc).splitlines()[0]
                            if attempt >= MAX_ATTEMPTS:
                                raise
                            print(
                                f"  ! {region_key} {attempt}차 실패: {last_error}"
                                f" — {RETRY_BACKOFF_SEC}초 후 재시도"
                            )
                            await asyncio.sleep(RETRY_BACKOFF_SEC)
            except Exception as exc:
                last_error = str(exc).splitlines()[0]
                print(f"  ✗ {region_key} 실패 ({MAX_ATTEMPTS}회 시도): {last_error}")
                if debug:
                    try:
                        await page.screenshot(path=screenshot_path("error", region_key))
                    except Exception:
                        pass
                failed.append((deal_type, region_key, last_error))

                consecutive_failures += 1
                if consecutive_failures >= ABORT_AFTER_CONSECUTIVE_FAILURES:
                    skipped = jobs[idx + 1:]
                    print(
                        f"\n연속 {consecutive_failures}개 지역이 모두 실패했습니다"
                        f" (지역마다 {MAX_ATTEMPTS}회 시도). 개별 지역 문제가 아니라"
                        f" 사이트가 통째로 응답하지 않는 상황으로 보고"
                        f" 남은 {len(skipped)}건을 포기합니다."
                    )
                    break
            else:
                # 한 번이라도 성공하면 사이트는 살아 있다. 카운터를 되돌린다.
                consecutive_failures = 0

        await browser.close()

    if skipped:
        print(f"\n건너뛴 목록 ({len(skipped)}건):")
        for dt, rk, _ in skipped:
            print(f"  - [{dt}] {rk}")

    if failed:
        print(f"\n실패 목록 ({len(failed)}건):")
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
    parser.add_argument(
        "--region", default="",
        help="특정 지역만 수집 (쉼표 구분). 실패한 지역만 재실행할 때 쓴다. "
             "예: --region gyeonggi,seoul",
    )
    parser.add_argument(
        "--list-regions", action="store_true",
        help="수집 대상 지역 키 목록 출력",
    )
    args = parser.parse_args()

    if args.list_regions:
        for key, code in BUY_REGIONS:
            print(f"{key:16} {code}")
        return

    headless = not args.show

    if args.diagnose:
        asyncio.run(diagnose(headless=False))
        return

    only = None
    if args.region:
        only = {r.strip() for r in args.region.split(",") if r.strip()}
        known = {key for key, _ in BUY_REGIONS}
        unknown = only - known
        if unknown:
            # 오타로 아무것도 수집하지 않고 조용히 성공하는 일이 없게 한다.
            print(f"알 수 없는 지역 키: {', '.join(sorted(unknown))}")
            print(f"사용 가능: {', '.join(sorted(known))}")
            sys.exit(2)
        print(f"지역 한정 수집: {', '.join(sorted(only))}")

    deal_types = ["buy", "rent"] if args.type == "all" else [args.type]
    asyncio.run(run(deal_types, headless, args.debug, only))


if __name__ == "__main__":
    main()
