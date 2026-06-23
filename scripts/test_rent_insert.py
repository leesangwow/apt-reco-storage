import os
from dotenv import load_dotenv
import psycopg2
import psycopg2.extras

load_dotenv()
print("연결 중...")

conn = psycopg2.connect(
    host=os.environ["SUPABASE_DB_HOST"],
    port=os.environ["SUPABASE_DB_PORT"],
    dbname=os.environ.get("SUPABASE_DB_NAME", "postgres"),
    user=os.environ["SUPABASE_DB_USER"],
    password=os.environ["SUPABASE_DB_PASSWORD"],
    sslmode="require",
    connect_timeout=10,
)
print("연결 성공!")
cur = conn.cursor()

# 기존 apt 하나 조회
cur.execute("SELECT id FROM apts LIMIT 1")
apt_id = cur.fetchone()[0]
print(f"테스트 apt_id: {apt_id}")

# 테스트 전세 데이터 10건 insert
rows = [
    (apt_id, '2026-05-01', 50000, 0, '전세', '신규', 5, '202605~202805'),
    (apt_id, '2026-04-15', 48000, 0, '전세', '신규', 3, '202604~202804'),
    (apt_id, '2026-03-20', 52000, 0, '전세', '갱신', 7, '202603~202803'),
    (apt_id, '2026-02-10', 45000, 300, '월세', '신규', 2, '202602~202702'),
    (apt_id, '2026-01-05', 49000, 0, '전세', '신규', 9, '202601~202801'),
    (apt_id, '2026-05-20', 51000, 0, '전세', '신규', 11, '202605~202805'),
    (apt_id, '2026-04-01', 47000, 0, '전세', '갱신', 4, '202604~202604'),
    (apt_id, '2026-03-10', 53000, 0, '전세', '신규', 6, '202603~202803'),
    (apt_id, '2026-02-20', 46000, 200, '월세', '신규', 1, '202602~202702'),
    (apt_id, '2026-01-15', 50500, 0, '전세', '신규', 8, '202601~202801'),
]

print("10건 insert 중...")
psycopg2.extras.execute_values(
    cur,
    """insert into rent_transactions
         (apt_id, contract_date, deposit_man, monthly_man, deal_type, contract_type, floor, contract_period)
       values %s
       on conflict (apt_id, contract_date, deposit_man, monthly_man, floor, deal_type) do nothing""",
    rows,
)
conn.commit()
print("insert 완료!")

cur.execute("SELECT count(*) FROM rent_transactions")
print(f"rent_transactions 총 행수: {cur.fetchone()[0]}")

conn.close()
print("완료!")
