"""
보존 기간이 지난 거래 삭제

사용법:
  python scripts/prune_old.py                # 13개월 넘은 거래 삭제
  python scripts/prune_old.py --dry-run      # 몇 행이 지워질지만 세어 본다
  python scripts/prune_old.py --months 18    # 보존 기간을 바꿔서

왜 필요한가: 수집 창이 롤링 1년이라는 건 "다시 받아오는 범위"일 뿐이고 DB에서
지우는 것은 아무것도 없었다. 그래서 계약일이 1년을 넘긴 행이 계속 쌓여 실측
기준 연 420MB씩 늘었다. 무료 플랜 500MB에서는 1년을 못 버틴다.

왜 13개월인가: 두 뷰가 최근 12개월(거래량)까지만 본다. 13개월이면 한 달치
여유를 두고 그 바깥만 지우므로 화면에 나오는 값이 달라지지 않는다.
matview의 current_date가 refresh 시점으로 굳는 것(최대 3~4일)까지 이 여유
안에 들어온다.

⚠ 과거분 적재(backfill.yml)와 정면으로 충돌한다. 이 스크립트가 워크플로에
  들어가 있는 한, 과거 거래를 넣어도 다음 실행에서 지워진다. 과거분을 쌓을
  거라면 워크플로에서 이 단계를 빼야 한다.
"""

import argparse
import os
import sys

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
    "sslmode":  os.environ.get("SUPABASE_DB_SSLMODE", "require"),
    "connect_timeout": 10,
}

# 뷰가 12개월까지 보므로 그보다 짧게 자르면 화면의 거래량이 줄어든다.
# 오타 하나로 데이터를 날리는 일이 없게 여기서 막는다.
MIN_MONTHS = 13

# 첫 실행은 지울 것이 많을 수 있다. 기본 statement_timeout에 걸리지 않게 넉넉히.
PRUNE_TIMEOUT_MS = 10 * 60 * 1000


def main():
    parser = argparse.ArgumentParser(description="보존 기간이 지난 거래 삭제")
    parser.add_argument(
        "--months", type=int, default=13,
        help=f"보존 기간(개월). {MIN_MONTHS} 미만은 거부한다 (기본: 13)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="지우지 않고 대상 행수만 센다",
    )
    args = parser.parse_args()

    if args.months < MIN_MONTHS:
        print(
            f"보존 기간이 {args.months}개월입니다. 뷰가 최근 12개월까지 보므로"
            f" {MIN_MONTHS}개월 미만으로는 자를 수 없습니다."
        )
        sys.exit(2)

    cutoff = f"{args.months} months"
    conn = psycopg2.connect(**DB_PARAMS)
    cur  = conn.cursor()
    cur.execute(f"set statement_timeout = {PRUNE_TIMEOUT_MS}")

    cur.execute("select current_date - interval %s", (cutoff,))
    print(f"기준일: {cur.fetchone()[0]:%Y-%m-%d} ({args.months}개월)")

    total = 0
    for table in ("transactions", "rent_transactions"):
        if args.dry_run:
            cur.execute(
                f"select count(*) from {table} where contract_date < current_date - interval %s",
                (cutoff,),
            )
            n = cur.fetchone()[0]
        else:
            cur.execute(
                f"delete from {table} where contract_date < current_date - interval %s",
                (cutoff,),
            )
            n = cur.rowcount
        total += n
        print(f"  {table:18} {n:>9,}행")

    # 거래가 하나도 안 남은 단지는 어느 뷰에도 안 나오면서 자리만 차지한다.
    # (apts는 행당 600바이트로 거래의 두 배가 넘는다)
    # 다음 적재에서 그 단지의 거래가 다시 들어오면 upsert가 되살린다.
    orphan_sql = """
      from apts a
     where not exists (select 1 from transactions      t where t.apt_id = a.id)
       and not exists (select 1 from rent_transactions r where r.apt_id = a.id)
    """
    if args.dry_run:
        cur.execute("select count(*) " + orphan_sql)
        n = cur.fetchone()[0]
    else:
        cur.execute("delete " + orphan_sql)
        n = cur.rowcount
    total += n
    print(f"  {'apts (거래 0건)':18} {n:>9,}행")

    if args.dry_run:
        print(f"\n[dry-run] 지웠다면 총 {total:,}행")
        conn.rollback()
    else:
        conn.commit()
        print(f"\n[완료] 총 {total:,}행 삭제")
        # delete는 자리를 비워둘 뿐 파일을 줄이지 않는다. 다음 적재가 그 자리를
        # 재사용하므로 평소에는 이걸로 충분하다. OS까지 돌려받아야 하면
        # vacuum full을 따로 돌린다 (테이블을 통째로 잠근다).
        if total:
            print("공간은 다음 적재가 재사용한다. 파일 크기를 줄이려면 vacuum full.")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
