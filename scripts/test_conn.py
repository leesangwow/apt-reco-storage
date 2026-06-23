import os
from dotenv import load_dotenv
import psycopg2

load_dotenv()
print("연결 시도 중...")
print(f"HOST: {os.environ['SUPABASE_DB_HOST']}")
print(f"PORT: {os.environ['SUPABASE_DB_PORT']}")

try:
    conn = psycopg2.connect(
        host=os.environ["SUPABASE_DB_HOST"],
        port=os.environ["SUPABASE_DB_PORT"],
        dbname=os.environ.get("SUPABASE_DB_NAME", "postgres"),
        user=os.environ["SUPABASE_DB_USER"],
        password=os.environ["SUPABASE_DB_PASSWORD"],
        sslmode="require",
        connect_timeout=10,
    )
    cur = conn.cursor()
    cur.execute("SELECT count(*) FROM apts")
    print(f"연결 성공! apts 행수: {cur.fetchone()[0]}")
    conn.close()
except Exception as e:
    print(f"연결 실패: {e}")
