"""
조회용 매터리얼라이즈드 뷰 갱신

사용법:
  python scripts/refresh_views.py
  python scripts/refresh_views.py --type buy    # 매매만
  python scripts/refresh_views.py --type rent   # 전월세만

apt_prices_mv / apt_rent_prices_mv는 적재된 거래를 미리 계산해 둔 표다.
적재가 끝나면 여기서 갱신해야 새 거래가 화면에 나온다. 갱신하지 않으면
DB에는 들어갔는데 앱에는 안 보이는 상태가 된다.

concurrently를 쓰는 이유: 일반 refresh는 ACCESS EXCLUSIVE 락을 잡아 갱신하는
동안 앱 조회가 통째로 막힌다. concurrently는 새 내용을 옆에 만든 뒤 바꿔치기해
읽기를 막지 않는다. 대신 유니크 인덱스가 있어야 하고(schema.sql의 *_mv_id),
조금 더 오래 걸린다 (운영 규모 실측: 7.6초 → 8.1초).
"""

import argparse
import os
import sys
import time

import psycopg2
from dotenv import load_dotenv

sys.stdout.reconfigure(line_buffering=True)  # CI 로그에 진행 상황이 바로 찍히도록

load_dotenv()

DB_PARAMS = {
    "host":     os.environ["SUPABASE_DB_HOST"],
    "port":     os.environ.get("SUPABASE_DB_PORT", "5432"),
    "dbname":   os.environ.get("SUPABASE_DB_NAME", "postgres"),
    "user":     os.environ.get("SUPABASE_DB_USER", "postgres"),
    "password": os.environ["SUPABASE_DB_PASSWORD"],
    # 운영(Supabase)은 require. 로컬 검증용으로만 낮출 수 있게 열어 둔다.
    "sslmode":  os.environ.get("SUPABASE_DB_SSLMODE", "require"),
    "connect_timeout": 10,
}

VIEWS = {"buy": "apt_prices_mv", "rent": "apt_rent_prices_mv"}

# 27만 행을 다시 계산하므로 기본 statement_timeout에 걸릴 수 있다.
REFRESH_TIMEOUT_MS = 15 * 60 * 1000


def refresh(cur, view: str) -> float:
    started = time.time()
    # concurrently는 트랜잭션 안에서 못 돌기 때문에 autocommit으로 연결해 둔다.
    cur.execute(f"refresh materialized view concurrently {view}")
    return time.time() - started


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--type", choices=["buy", "rent", "both"], default="both",
        help="갱신할 뷰 (기본: 둘 다)",
    )
    args = parser.parse_args()

    targets = list(VIEWS) if args.type == "both" else [args.type]

    conn = psycopg2.connect(**DB_PARAMS)
    conn.autocommit = True  # refresh concurrently는 트랜잭션 블록 안에서 실패한다
    failed = []
    try:
        with conn.cursor() as cur:
            cur.execute(f"set statement_timeout = {REFRESH_TIMEOUT_MS}")
            for key in targets:
                view = VIEWS[key]
                print(f"{view} 갱신 중...")
                try:
                    took = refresh(cur, view)
                except Exception as e:
                    # 한쪽이 실패해도 다른 쪽은 갱신해 둔다. 매매가 안 됐다고
                    # 전월세까지 옛날 데이터로 남을 이유는 없다.
                    print(f"  [실패] {view}: {e}")
                    failed.append(view)
                    continue
                cur.execute(f"select count(*) from {view}")
                rows = cur.fetchone()[0]
                print(f"  완료 — {rows:,}행, {took:.1f}초")
    finally:
        conn.close()

    if failed:
        # 실패를 조용히 넘기면 앱이 옛날 데이터를 보여주는데 워크플로는 초록색이 된다.
        print(f"갱신 실패: {', '.join(failed)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
