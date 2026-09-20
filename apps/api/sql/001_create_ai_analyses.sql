-- LogPlus: AI 분석 이력 테이블 (생성 또는 기존 테이블 확장)
--
-- main.py에 Base.metadata.create_all 호출이 없으므로 수동으로 적용한다.
--   mysql -u logplus_app -p LogPlus < api/sql/001_create_ai_analyses.sql
--
-- ※ ai_analyses 테이블이 이미 있는 환경이 있다.
--    (analysis_id / build_log_id / analysis / solution / created_at)
--    그래서 CREATE 하나로 끝내지 않고, 모자란 컬럼을 ADD COLUMN IF NOT EXISTS로 채운다.
--    기존 행과 analysis / solution 컬럼은 건드리지 않는다.
--    몇 번을 실행해도 결과가 같다(멱등).
--
-- build_logs(1) : ai_analyses(N)
--   재분석할 때마다 행이 1건 쌓이고, 그 자체가 히스토리가 된다.
--   본문은 analysis_path가 가리키는 txt 파일에 있다 (DB는 메타데이터, 파일이 본문).

-- ── 1) 없는 환경: 신규 생성 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_analyses (
  analysis_id   INT AUTO_INCREMENT PRIMARY KEY,
  build_log_id  INT NOT NULL COMMENT '분석 대상 로그',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2) 있는 환경 / 없는 환경 공통: 필요한 컬럼 채우기 ──────────────
ALTER TABLE ai_analyses
  ADD COLUMN IF NOT EXISTS users_id      VARCHAR(100) NULL AFTER build_log_id,
  ADD COLUMN IF NOT EXISTS team_id       VARCHAR(100) NULL AFTER users_id,
  ADD COLUMN IF NOT EXISTS model         VARCHAR(100) NULL COMMENT '분석에 사용한 Ollama 모델',
  ADD COLUMN IF NOT EXISTS analysis_path TEXT         NULL COMMENT '/app/logplus-platform/logs/{team}/{user}/analyses/..._AI_{id}.txt',
  -- 기존 테이블에는 이미 있는 컬럼. 없는 환경(신규 생성)에서도 같은 모양이 되도록 함께 선언한다.
  -- analysis = 분석 본문(조회/검색용), solution = 현재 미사용이며 NULL로 둔다.
  ADD COLUMN IF NOT EXISTS analysis      MEDIUMTEXT   NULL,
  ADD COLUMN IF NOT EXISTS solution      MEDIUMTEXT   NULL;

-- ── 3) 색인 ────────────────────────────────────────────────────────
-- 이력 조회는 항상 "특정 로그의 최신순"이라 이 순서로 색인한다
ALTER TABLE ai_analyses
  ADD INDEX IF NOT EXISTS idx_ai_log   (build_log_id, created_at),
  ADD INDEX IF NOT EXISTS idx_ai_owner (users_id, team_id);

-- ── 4) 외래키 (선택) ───────────────────────────────────────────────
-- 로그가 지워지면 그에 딸린 분석 이력도 함께 지워져 고아 행이 남지 않는다.
-- 기존 행 중 build_log_id가 NULL이거나 build_logs에 없는 값이 있으면 실패하므로,
-- 아래 확인 쿼리가 0을 반환할 때만 주석을 풀 것.
--
--   SELECT COUNT(*) FROM ai_analyses a
--   LEFT JOIN build_logs b ON b.build_log_id = a.build_log_id
--   WHERE a.build_log_id IS NULL OR b.build_log_id IS NULL;
--
-- ALTER TABLE ai_analyses
--   ADD CONSTRAINT fk_ai_build_log FOREIGN KEY (build_log_id)
--       REFERENCES build_logs (build_log_id) ON DELETE CASCADE;
