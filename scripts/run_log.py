"""수집·적재 실행 이력을 ingestion_runs 테이블에 기록한다.

설계 원칙 — 기록은 어디까지나 부가 기능이다:
  * DB 접속 정보가 없으면 조용히 건너뛴다 (로컬에서 다운로드만 돌릴 때)
  * 기록에 실패해도 예외를 밖으로 던지지 않는다 (수집 자체를 망치면 안 됨)

사용:
    from run_log import RunLogger

    log = RunLogger()
    with log.track("download", "buy", "choongbuk") as entry:
        ...작업...
        entry.file_bytes = 1234
"""

import os
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone

# psycopg2는 다운로드 전용 실행 환경에는 없을 수 있다.
try:
    import psycopg2
except ImportError:  # pragma: no cover
    psycopg2 = None


def _run_id() -> str:
    """GitHub Actions 실행 id, 없으면 로컬 타임스탬프."""
    gh = os.environ.get("GITHUB_RUN_ID")
    if gh:
        attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "1")
        return f"{gh}-{attempt}"
    return "local-" + datetime.now().strftime("%Y%m%d%H%M%S")


def _run_url() -> str | None:
    server = os.environ.get("GITHUB_SERVER_URL")
    repo   = os.environ.get("GITHUB_REPOSITORY")
    run    = os.environ.get("GITHUB_RUN_ID")
    if server and repo and run:
        return f"{server}/{repo}/actions/runs/{run}"
    return None


@dataclass
class Entry:
    """작업 중 채워 넣는 측정값. track() 컨텍스트가 나머지를 채운다."""
    attempts:    int         = 1
    from_date:   str | None  = None
    to_date:     str | None  = None
    file_bytes:  int | None  = None
    rows_total:  int | None  = None
    rows_new:    int | None  = None
    error:       str | None  = None
    _started:    float       = field(default_factory=time.monotonic)
    _started_at: datetime    = field(default_factory=lambda: datetime.now(timezone.utc))


INSERT_SQL = """
insert into ingestion_runs
  (run_id, stage, deal_type, region_key, status, started_at, finished_at,
   duration_ms, attempts, from_date, to_date, file_bytes, rows_total, rows_new,
   error, run_url)
values (%s, %s, %s, %s, %s, %s, now(), %s, %s, %s, %s, %s, %s, %s, %s, %s)
"""


class RunLogger:
    def __init__(self):
        self.run_id  = _run_id()
        self.run_url = _run_url()
        self.enabled = bool(
            psycopg2
            and os.environ.get("SUPABASE_DB_HOST")
            and os.environ.get("SUPABASE_DB_PASSWORD")
        )
        if not self.enabled:
            print("  (이력 기록 비활성 — DB 접속 정보 없음)", file=sys.stderr)

    def _connect(self):
        return psycopg2.connect(
            host=os.environ["SUPABASE_DB_HOST"],
            port=os.environ.get("SUPABASE_DB_PORT", "5432"),
            dbname=os.environ.get("SUPABASE_DB_NAME", "postgres"),
            user=os.environ.get("SUPABASE_DB_USER", "postgres"),
            password=os.environ["SUPABASE_DB_PASSWORD"],
            sslmode="require",
            connect_timeout=10,
        )

    def write(self, stage: str, deal_type: str, region_key: str,
              status: str, entry: Entry) -> None:
        if not self.enabled:
            return
        try:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(INSERT_SQL, (
                    self.run_id, stage, deal_type, region_key, status,
                    entry._started_at,
                    int((time.monotonic() - entry._started) * 1000),
                    entry.attempts, entry.from_date, entry.to_date,
                    entry.file_bytes, entry.rows_total, entry.rows_new,
                    (entry.error or None), self.run_url,
                ))
        except Exception as exc:
            # 이력 기록 실패가 수집 실패로 번지지 않게 한다.
            print(f"  (이력 기록 실패 — 무시하고 계속: {exc})", file=sys.stderr)

    @contextmanager
    def track(self, stage: str, deal_type: str, region_key: str):
        """with 블록의 성공/실패를 자동으로 기록한다. 예외는 그대로 전파된다."""
        entry = Entry()
        try:
            yield entry
        except Exception as exc:
            entry.error = str(exc).splitlines()[0][:1000]
            self.write(stage, deal_type, region_key, "failed", entry)
            raise
        else:
            self.write(stage, deal_type, region_key, "success", entry)
