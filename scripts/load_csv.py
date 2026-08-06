"""
국토부 아파트 실거래가 CSV → Supabase 적재 스크립트

사용법:
  pip install pandas psycopg2-binary python-dotenv tqdm
  python scripts/load_csv.py --dir ./data/updates/buy
  python scripts/load_csv.py --dir ./data/updates/buy --keep-csv   # CSV 보존

폴더 안의 모든 CSV를 적재한다. 적재에 성공한 파일은 삭제하고
(원본은 국토부 사이트에 있고 DB가 실제 저장소다), 실패한 파일은
원인 파악을 위해 남긴다. --keep-csv로 삭제를 끌 수 있다.
"""

import argparse
import glob
import os
import sys
import time

import pandas as pd
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from tqdm import tqdm

sys.stdout.reconfigure(line_buffering=True)  # CI 로그에 진행 상황이 바로 찍히도록

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_log import Entry, RunLogger  # noqa: E402

load_dotenv()

# 비밀번호에 특수문자(@, ! 등)가 있어도 안전하게 개별 파라미터로 연결
DB_PARAMS = {
    "host":     os.environ["SUPABASE_DB_HOST"],
    "port":     os.environ.get("SUPABASE_DB_PORT", "5432"),
    "dbname":   os.environ.get("SUPABASE_DB_NAME", "postgres"),
    "user":     os.environ.get("SUPABASE_DB_USER", "postgres"),
    "password": os.environ["SUPABASE_DB_PASSWORD"],
    "sslmode":  "require",
    "connect_timeout": 10,
}


# ── CSV 전처리 ──────────────────────────────────────────────

def parse_sido_gu_dong(시군구: str):
    """'서울특별시 도봉구 방학동' → ('서울특별시', '도봉구', '방학동')"""
    parts = 시군구.strip().split()
    sido = parts[0] if len(parts) > 0 else ""
    gu   = parts[1] if len(parts) > 1 else ""
    dong = parts[2] if len(parts) > 2 else ""
    return sido, gu, dong


def parse_price(val: str) -> int:
    """'48,500' → 48500"""
    return int(str(val).replace(",", "").strip())


def parse_date(년월: str, 일: str) -> str:
    """'202606', '12' → '2026-06-12'"""
    년월 = str(년월).strip()
    일   = str(일).strip().zfill(2)
    return f"{년월[:4]}-{년월[4:6]}-{일}"


def parse_floor(val) -> int | None:
    try:
        return int(str(val).strip())
    except Exception:
        return None


def detect_encoding(path: str) -> str:
    """utf-8-sig → cp949 순서로 인코딩 자동 감지"""
    for enc in ("utf-8-sig", "cp949", "euc-kr"):
        try:
            with open(path, encoding=enc) as f:
                f.read(4096)
            return enc
        except UnicodeDecodeError:
            continue
    return "cp949"


def find_header_row(path: str, encoding: str) -> int:
    """'NO' 컬럼이 있는 실제 헤더 행 번호를 찾는다."""
    with open(path, encoding=encoding, errors="replace") as f:
        for i, line in enumerate(f):
            if '"NO"' in line and '"시군구"' in line:
                return i
    return 0


def load_csv(path: str) -> pd.DataFrame:
    enc = detect_encoding(path)
    header_row = find_header_row(path, enc)
    df = pd.read_csv(path, dtype=str, encoding=enc, skiprows=header_row)
    df.columns = [c.strip() for c in df.columns]
    return df


def preprocess(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    # 시군구 파싱
    parsed = df["시군구"].apply(parse_sido_gu_dong)
    df["sido"] = parsed.apply(lambda x: x[0])
    df["gu"]   = parsed.apply(lambda x: x[1])
    df["dong"] = parsed.apply(lambda x: x[2])

    # 면적
    df["area_sqm"] = pd.to_numeric(df["전용면적(㎡)"], errors="coerce")

    # 가격
    df["price_man"] = df["거래금액(만원)"].apply(parse_price)

    # 계약일
    df["contract_date"] = df.apply(
        lambda r: parse_date(r["계약년월"], r["계약일"]), axis=1
    )

    # 층
    df["floor"] = df["층"].apply(parse_floor)

    # 건축년도
    df["year_built"] = pd.to_numeric(df["건축년도"], errors="coerce").astype("Int64")

    # 거래유형
    df["deal_type"] = df["거래유형"].str.strip()

    # 도로명주소
    df["address"] = df.get("도로명", pd.Series(dtype=str)).str.strip()

    # 단지명
    df["name"] = df["단지명"].str.strip()

    # 유효 행만
    df = df.dropna(subset=["area_sqm", "price_man", "contract_date", "name", "gu", "dong"])

    return df


# ── DB 적재 ─────────────────────────────────────────────────

# 단지 upsert/거래 insert의 SQL은 각 함수 안에 인라인으로 있다.
# 이 조회만 캐시에 빠진 단지를 메우는 안전망으로 따로 쓴다.
SELECT_APT = """
select id from apts where name=%s and gu=%s and dong=%s and area_sqm=%s;
"""

# 한 statement에 묶는 행수. 왕복 횟수를 줄이는 값이라 클수록 좋지만,
# 쿼리 문자열이 그만큼 커진다 (거래 1,000행이면 약 60KB).
APT_PAGE_SIZE = 500
TX_PAGE_SIZE  = 1000
# 커밋 간격. 커밋도 왕복 한 번이라 행마다 하면 그 비용이 그대로 쌓인다.
TX_COMMIT_ROWS = 10_000


def copy_transactions(cur, rows: list[tuple]) -> int:
    """대량 insert (중복은 unique constraint로 자동 스킵). 실제 삽입된 행수를 반환."""
    inserted = psycopg2.extras.execute_values(
        cur,
        """insert into transactions (apt_id, contract_date, price_man, floor, deal_type)
           values %s
           on conflict (apt_id, contract_date, price_man, floor) do nothing
           returning id""",
        rows,
        page_size=TX_PAGE_SIZE,
        fetch=True,
    )
    return len(inserted)


def upsert_apts(cur, conn, apt_rows: list[tuple]) -> dict[tuple, int]:
    """단지를 일괄 upsert하고 (name, gu, dong, area_sqm) → id 캐시를 돌려준다."""
    # fetch=True가 핵심이다. 빼면 psycopg2가 page_size 단위로 execute를 반복하면서
    # 앞 페이지의 RETURNING 결과를 덮어쓰고, 뒤이은 cur.fetchall()이 마지막 한 페이지만
    # 돌려준다(psycopg2.extras.execute_values 구현 참고). 예전 코드가 그래서 나머지
    # 단지를 전부 단건 SELECT로 다시 읽었고, 그 왕복이 적재 시간의 대부분이었다.
    returned = psycopg2.extras.execute_values(
        cur,
        """insert into apts (name, sido, gu, dong, address, area_sqm, year_built)
           values %s
           on conflict (name, gu, dong, area_sqm) do update set name=excluded.name
           returning id, name, gu, dong, area_sqm""",
        apt_rows, page_size=APT_PAGE_SIZE, fetch=True,
    )
    conn.commit()
    return {
        (name, gu, dong, float(area)): apt_id
        for apt_id, name, gu, dong, area in returned
    }


def fill_missing_apts(cur, apt_cache: dict[tuple, int], keys: list[tuple]) -> None:
    """캐시에 빠진 단지를 단건 조회로 메운다.

    on conflict do update는 입력 행마다 하나씩 되돌려주므로 여기 걸릴 것이 없어야
    정상이다. 그래도 비워두면 그 단지의 거래가 통째로 버려지므로 안전망은 남긴다.
    수가 많다면 왕복 비용이 그대로 돌아온 것이니 눈에 띄어야 한다.
    """
    missing = [key for key in keys if key not in apt_cache]
    if not missing:
        return
    print(f"  [경고] 단지 {len(missing):,}개가 upsert 결과에 없어 단건 조회로 메웁니다")
    for key in missing:
        cur.execute(SELECT_APT, key)
        res = cur.fetchone()
        if res:
            apt_cache[key] = res[0]


def load_to_db(df: pd.DataFrame, conn) -> int:
    """적재 후 새로 삽입된 거래 행수를 반환한다."""
    cur = conn.cursor()

    # 1단계: 고유 단지 일괄 upsert
    df["area_sqm"] = df["area_sqm"].round(2)
    unique_apts = df.drop_duplicates(subset=["name", "gu", "dong", "area_sqm"])
    print(f"  단지 upsert 중... (고유 단지 {len(unique_apts):,}개)")
    apt_rows = [
        (name, sido, gu, dong, address, float(area),
         int(year) if pd.notna(year) else None)
        for name, sido, gu, dong, address, area, year in zip(
            unique_apts["name"], unique_apts["sido"], unique_apts["gu"],
            unique_apts["dong"], unique_apts["address"],
            unique_apts["area_sqm"], unique_apts["year_built"],
        )
    ]
    apt_cache = upsert_apts(cur, conn, apt_rows)
    fill_missing_apts(
        cur, apt_cache,
        [(r[0], r[2], r[3], r[5]) for r in apt_rows],  # (name, gu, dong, area_sqm)
    )

    # 2단계: 거래 일괄 insert
    # iterrows()는 행마다 Series를 만들어 느리다. 큰 지역은 수십만 행이라
    # 컬럼을 통째로 zip해서 튜플만 뽑는다.
    tx_rows = [
        (apt_id, contract_date, int(price), floor, deal)
        for apt_id, contract_date, price, floor, deal in zip(
            (apt_cache.get(key) for key in zip(
                df["name"], df["gu"], df["dong"], df["area_sqm"].astype(float))),
            df["contract_date"], df["price_man"], df["floor"], df["deal_type"],
        )
        if apt_id
    ]
    dropped = len(df) - len(tx_rows)
    if dropped:
        print(f"  [경고] 단지를 못 찾아 건너뛴 거래 {dropped:,}건")

    print(f"  거래 insert 중... ({len(tx_rows):,}건)")
    inserted = 0
    chunks = range(0, len(tx_rows), TX_COMMIT_ROWS)
    for i in tqdm(chunks, desc="  batches", leave=False):
        inserted += copy_transactions(cur, tx_rows[i:i + TX_COMMIT_ROWS])
        conn.commit()

    cur.close()
    return inserted


# ── 메인 ────────────────────────────────────────────────────

def discard(path: str) -> None:
    """적재를 마친 CSV를 지운다. 삭제 실패가 적재 결과를 뒤집지는 않는다."""
    try:
        size = os.path.getsize(path)
        os.remove(path)
        print(f"  CSV 삭제 ({size / 1024 / 1024:.1f} MB)")
    except OSError as e:
        print(f"  [경고] CSV 삭제 실패 (무시): {e}")


# 일시적 DB 장애(Supabase 재시작, 커넥션 끊김)로 지역 하나가 다음 스케줄까지
# 통째로 빠지지 않도록 재시도한다. 파싱 오류처럼 다시 해도 같은 결과인 것은
# 재시도하지 않는다 — 시간만 쓰고 결과가 같다.
LOAD_MAX_ATTEMPTS = 3
LOAD_BACKOFF_SEC  = 20
TRANSIENT = (psycopg2.OperationalError, psycopg2.InterfaceError)


def ensure_conn(conn):
    """끊긴 커넥션이면 새로 연결해 돌려준다."""
    if conn is not None and not conn.closed:
        try:
            with conn.cursor() as cur:
                cur.execute("select 1")
            return conn
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
    return psycopg2.connect(**DB_PARAMS)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", default="./data/csv", help="CSV 파일이 있는 폴더")
    parser.add_argument(
        "--keep-csv", action="store_true",
        help="적재에 성공한 CSV를 삭제하지 않고 남긴다 (기본: 삭제)",
    )
    args = parser.parse_args()

    csv_files = sorted(set(
        glob.glob(os.path.join(args.dir, "**/*.csv"), recursive=True) +
        glob.glob(os.path.join(args.dir, "*.csv"))
    ))

    if not csv_files:
        print(f"CSV 파일을 찾을 수 없습니다: {args.dir}")
        return

    print(f"CSV 파일 {len(csv_files)}개 발견")

    conn = None
    run_log = RunLogger()

    total_rows = 0
    failed = 0
    for path in csv_files:
        region_key = os.path.splitext(os.path.basename(path))[0]
        print(f"\n▶ {os.path.basename(path)}")

        entry = Entry()
        ok = False
        for attempt in range(1, LOAD_MAX_ATTEMPTS + 1):
            entry.attempts = attempt
            try:
                conn = ensure_conn(conn)
                df = load_csv(path)
                df = preprocess(df)
                entry.rows_total = len(df)
                print(f"  유효 행: {len(df):,}")
                entry.rows_new = load_to_db(df, conn)
                print(f"  신규 적재: {entry.rows_new:,}건")
                total_rows += len(df)
                ok = True
                break
            except Exception as e:
                if conn is not None:
                    try:
                        conn.rollback()
                    except Exception:
                        pass

                transient = isinstance(e, TRANSIENT)
                if transient and attempt < LOAD_MAX_ATTEMPTS:
                    print(f"  ! {attempt}차 실패: {e} — {LOAD_BACKOFF_SEC}초 후 재시도")
                    time.sleep(LOAD_BACKOFF_SEC)
                    continue

                print(f"  [오류] {e}")
                entry.error = str(e).splitlines()[0][:1000]
                break

        run_log.write("load", "buy", region_key, "success" if ok else "failed", entry)

        if not ok:
            failed += 1
            continue

        # DB에 들어갔으면 CSV는 역할이 끝났다. 실패한 파일은 원인 파악을 위해 남긴다.
        if not args.keep_csv:
            discard(path)

    if conn is not None and not conn.closed:
        conn.close()
    print(f"\n[완료] 총 {total_rows:,}건 처리, 실패 {failed}건")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
