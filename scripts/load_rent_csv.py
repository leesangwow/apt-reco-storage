"""
국토부 아파트 전월세 CSV → Supabase 적재 스크립트

사용법:
  python scripts/load_rent_csv.py --dir ./data/updates/rent
"""

import argparse
import glob
import os

import pandas as pd
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from tqdm import tqdm

load_dotenv()

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

def detect_encoding(path: str) -> str:
    for enc in ("utf-8-sig", "cp949", "euc-kr"):
        try:
            with open(path, encoding=enc) as f:
                f.read(4096)
            return enc
        except UnicodeDecodeError:
            continue
    return "cp949"


def find_header_row(path: str, encoding: str) -> int:
    with open(path, encoding=encoding, errors="replace") as f:
        for i, line in enumerate(f):
            if '"NO"' in line and '"시군구"' in line:
                return i
    return 0


def parse_sido_gu_dong(시군구: str):
    parts = 시군구.strip().split()
    sido = parts[0] if len(parts) > 0 else ""
    gu   = parts[1] if len(parts) > 1 else ""
    dong = parts[2] if len(parts) > 2 else ""
    return sido, gu, dong


def parse_price(val) -> int:
    try:
        return int(str(val).replace(",", "").strip())
    except Exception:
        return 0


def parse_date(년월: str, 일: str) -> str:
    년월 = str(년월).strip()
    일   = str(일).strip().zfill(2)
    return f"{년월[:4]}-{년월[4:6]}-{일}"


def parse_floor(val) -> int | None:
    try:
        return int(str(val).strip())
    except Exception:
        return None


def load_csv(path: str) -> pd.DataFrame:
    enc = detect_encoding(path)
    header_row = find_header_row(path, enc)
    df = pd.read_csv(path, dtype=str, encoding=enc, skiprows=header_row)
    df.columns = [c.strip() for c in df.columns]
    return df


def preprocess(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    parsed = df["시군구"].apply(parse_sido_gu_dong)
    df["sido"] = parsed.apply(lambda x: x[0])
    df["gu"]   = parsed.apply(lambda x: x[1])
    df["dong"] = parsed.apply(lambda x: x[2])

    df["area_sqm"]      = pd.to_numeric(df["전용면적(㎡)"], errors="coerce")
    df["deposit_man"]   = df["보증금(만원)"].apply(parse_price)
    df["monthly_man"]   = df["월세금(만원)"].apply(parse_price)
    df["deal_type"]     = df["전월세구분"].str.strip()       # 전세 | 월세
    df["contract_type"] = df["계약구분"].str.strip()         # 신규 | 갱신
    df["contract_date"] = df.apply(lambda r: parse_date(r["계약년월"], r["계약일"]), axis=1)
    df["floor"]         = df["층"].apply(parse_floor)
    df["year_built"]    = pd.to_numeric(df["건축년도"], errors="coerce").astype("Int64")
    df["address"]       = df.get("도로명", pd.Series(dtype=str)).str.strip()
    df["name"]          = df["단지명"].str.strip()
    df["contract_period"] = df.get("계약기간", pd.Series(dtype=str)).str.strip()

    # 아파트만
    if "주택유형" in df.columns:
        df = df[df["주택유형"].str.strip() == "아파트"]

    df = df.dropna(subset=["area_sqm", "deposit_man", "contract_date", "name", "gu", "dong"])
    return df


# ── DB 적재 ─────────────────────────────────────────────────

UPSERT_APT = """
insert into apts (name, sido, gu, dong, address, area_sqm, year_built)
values (%s, %s, %s, %s, %s, %s, %s)
on conflict (name, gu, dong, area_sqm) do update set name=excluded.name
returning id;
"""

SELECT_APT = """
select id from apts where name=%s and gu=%s and dong=%s and area_sqm=%s;
"""


def insert_rent_transactions(cur, rows: list[tuple]):
    psycopg2.extras.execute_values(
        cur,
        """insert into rent_transactions
             (apt_id, contract_date, deposit_man, monthly_man, deal_type, contract_type, floor, contract_period)
           values %s
           on conflict (apt_id, contract_date, deposit_man, monthly_man, floor, deal_type) do nothing""",
        rows,
        page_size=500,
    )


def load_to_db(df: pd.DataFrame, conn):
    cur = conn.cursor()

    # 1단계: 고유 단지 목록 추출 후 일괄 upsert
    print("  단지 upsert 중...", flush=True)
    df["area_sqm"] = df["area_sqm"].round(2)
    unique_apts = df.drop_duplicates(subset=["name", "gu", "dong", "area_sqm"])
    print(f"  고유 단지 수: {len(unique_apts):,}", flush=True)
    apt_rows = [
        (row["name"], row["sido"], row["gu"], row["dong"],
         row["address"], float(row["area_sqm"]),
         int(row["year_built"]) if pd.notna(row["year_built"]) else None)
        for _, row in unique_apts.iterrows()
    ]
    # 500개씩 나눠서 upsert (대용량 배치 방지)
    apt_cache: dict[tuple, int] = {}
    BATCH = 500
    for i in range(0, len(apt_rows), BATCH):
        batch = apt_rows[i:i+BATCH]
        print(f"  단지 배치 {i//BATCH+1}/{(len(apt_rows)-1)//BATCH+1} ...", flush=True)
        psycopg2.extras.execute_values(
            cur,
            """insert into apts (name, sido, gu, dong, address, area_sqm, year_built)
               values %s
               on conflict (name, gu, dong, area_sqm) do update set name=excluded.name
               returning id, name, gu, dong, area_sqm""",
            batch, page_size=500,
        )
        for row in cur.fetchall():
            apt_id, name, gu, dong, area = row
            apt_cache[(name, gu, dong, float(area))] = apt_id
        conn.commit()
    # 캐시에 없는 항목은 DB에서 조회
    missing_keys = [
        (row["name"], row["gu"], row["dong"], float(row["area_sqm"]))
        for _, row in unique_apts.iterrows()
        if (row["name"], row["gu"], row["dong"], float(row["area_sqm"])) not in apt_cache
    ]
    if missing_keys:
        for key in missing_keys:
            cur.execute(SELECT_APT, key)
            res = cur.fetchone()
            if res:
                apt_cache[key] = res[0]

    # 3단계: 거래 일괄 insert
    print("  거래 insert 중...", flush=True)
    tx_rows = []
    for _, row in tqdm(df.iterrows(), total=len(df), desc="  rows", leave=False):
        key = (row["name"], row["gu"], row["dong"], float(row["area_sqm"]))
        apt_id = apt_cache.get(key)
        if not apt_id:
            continue
        tx_rows.append((
            apt_id,
            row["contract_date"],
            int(row["deposit_man"]),
            int(row["monthly_man"]),
            row["deal_type"],
            row["contract_type"] if pd.notna(row.get("contract_type", pd.NA)) else None,
            row["floor"],
            row["contract_period"] if pd.notna(row.get("contract_period", pd.NA)) else None,
        ))
        if len(tx_rows) >= 1000:
            insert_rent_transactions(cur, tx_rows)
            tx_rows.clear()
            conn.commit()

    if tx_rows:
        insert_rent_transactions(cur, tx_rows)
        conn.commit()

    cur.close()


# ── 메인 ────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", default="./data/updates/rent")
    parser.add_argument("--file", default=None, help="특정 파일만 처리")
    args = parser.parse_args()

    if args.file:
        csv_files = [args.file]
    else:
        csv_files = sorted(set(
            glob.glob(os.path.join(args.dir, "**/*.csv"), recursive=True) +
            glob.glob(os.path.join(args.dir, "*.csv"))
        ))

    if not csv_files:
        print(f"CSV 파일을 찾을 수 없습니다: {args.dir}")
        return

    print(f"CSV 파일 {len(csv_files)}개 발견")
    conn = psycopg2.connect(**DB_PARAMS)

    total = 0
    for path in csv_files:
        print(f"\n▶ {os.path.basename(path)}")
        try:
            df = load_csv(path)
            df = preprocess(df)
            print(f"  유효 행: {len(df):,}")
            load_to_db(df, conn)
            total += len(df)
        except Exception as e:
            print(f"  [오류] {e}")
            conn.rollback()

    conn.close()
    print(f"\n[완료] 총 {total:,}건 적재")


if __name__ == "__main__":
    main()
