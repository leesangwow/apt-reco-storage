"""
국토부 아파트 실거래가 CSV → Supabase 적재 스크립트

사용법:
  pip install pandas psycopg2-binary python-dotenv tqdm
  python scripts/load_csv.py --dir ./data/csv

CSV 파일은 data/csv/ 폴더 안에 여러 개 넣어두면 됩니다.
"""

import argparse
import glob
import os
import re
from io import StringIO

import pandas as pd
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from tqdm import tqdm

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

UPSERT_APT = """
insert into apts (name, sido, gu, dong, address, area_sqm, year_built)
values (%s, %s, %s, %s, %s, %s, %s)
on conflict (name, gu, dong, area_sqm) do update set name=excluded.name
returning id;
"""

INSERT_TX = """
insert into transactions (apt_id, contract_date, price_man, floor, deal_type)
values %s
on conflict do nothing;
"""


def copy_transactions(cur, rows: list[tuple]):
    """executemany로 대량 insert (중복은 unique constraint로 자동 스킵)"""
    psycopg2.extras.execute_values(
        cur,
        """insert into transactions (apt_id, contract_date, price_man, floor, deal_type)
           values %s
           on conflict (apt_id, contract_date, price_man, floor) do nothing""",
        rows,
        page_size=500,
    )


def load_to_db(df: pd.DataFrame, conn):
    cur = conn.cursor()

    # 단지 캐시 (name, gu, dong, area_sqm) → apt_id
    apt_cache: dict[tuple, int] = {}

    tx_rows = []

    for _, row in tqdm(df.iterrows(), total=len(df), desc="  rows", leave=False):
        key = (row["name"], row["gu"], row["dong"], float(row["area_sqm"]))

        if key not in apt_cache:
            cur.execute(UPSERT_APT, (
                row["name"], row["sido"], row["gu"], row["dong"],
                row["address"], float(row["area_sqm"]),
                int(row["year_built"]) if pd.notna(row["year_built"]) else None,
            ))
            result = cur.fetchone()
            apt_cache[key] = result[0]

        tx_rows.append((
            apt_cache[key],
            row["contract_date"],
            int(row["price_man"]),
            row["floor"],
            row["deal_type"],
        ))

        # 배치 단위로 flush
        if len(tx_rows) >= 1000:
            copy_transactions(cur, tx_rows)
            tx_rows.clear()
            conn.commit()

    if tx_rows:
        copy_transactions(cur, tx_rows)
        conn.commit()

    cur.close()


# ── 메인 ────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", default="./data/csv", help="CSV 파일이 있는 폴더")
    args = parser.parse_args()

    csv_files = sorted(set(
        glob.glob(os.path.join(args.dir, "**/*.csv"), recursive=True) +
        glob.glob(os.path.join(args.dir, "*.csv"))
    ))

    if not csv_files:
        print(f"CSV 파일을 찾을 수 없습니다: {args.dir}")
        return

    print(f"CSV 파일 {len(csv_files)}개 발견")

    conn = psycopg2.connect(**DB_PARAMS)

    total_rows = 0
    for path in csv_files:
        print(f"\n▶ {os.path.basename(path)}")
        try:
            df = load_csv(path)
            df = preprocess(df)
            print(f"  유효 행: {len(df):,}")
            load_to_db(df, conn)
            total_rows += len(df)
        except Exception as e:
            print(f"  [오류] {e}")
            conn.rollback()

    conn.close()
    print(f"\n[완료] 총 {total_rows:,}건 적재")


if __name__ == "__main__":
    main()
