-- LogPlus: AI 분석 이력 테이블
-- main.py에 Base.metadata.create_all 호출이 없으므로 수동으로 적용한다.
--   mysql -u logplus_app -p LogPlus < api/sql/001_create_ai_analyses.sql
--
-- build_logs(1) : ai_analyses(N)
--   재분석할 때마다 행이 1건 쌓이고, 그 자체가 히스토리가 된다.
--   본문은 analysis_path가 가리키는 txt 파일에 있다 (DB는 메타데이터, 파일이 본문).

CREATE TABLE IF NOT EXISTS ai_analyses (
  analysis_id   INT AUTO_INCREMENT PRIMARY KEY,
  build_log_id  INT          NOT NULL COMMENT '분석 대상 로그',
  users_id      VARCHAR(100) NOT NULL,
  team_id       VARCHAR(100) NOT NULL,
  model         VARCHAR(100)          COMMENT '분석에 사용한 Ollama 모델',
  analysis_path TEXT                  COMMENT '/app/logs/{team}/{user}/analyses/..._AI_{id}.txt',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- 로그가 지워지면 그에 딸린 분석 이력도 함께 지워져 고아 행이 남지 않는다
  CONSTRAINT fk_ai_build_log FOREIGN KEY (build_log_id)
      REFERENCES build_logs (build_log_id) ON DELETE CASCADE,

  -- 이력 조회는 항상 "특정 로그의 최신순"이라 이 순서로 색인한다
  INDEX idx_ai_log (build_log_id, created_at DESC),
  INDEX idx_ai_owner (users_id, team_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
