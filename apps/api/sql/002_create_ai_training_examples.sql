-- LogPlus: 사람이 검증한 AI 학습/RAG 사례 저장소
-- 기존 ai_analyses는 변경하지 않는다.
-- build_log_id/analysis_id는 과거 누락 데이터와 스키마 차이를 고려해
-- nullable 참조값으로만 저장하며, 초기 마이그레이션에서는 외래키를 추가하지 않는다.

CREATE TABLE IF NOT EXISTS ai_training_examples (
  example_id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  build_log_id       INT NULL,
  analysis_id        INT NULL,
  users_id           VARCHAR(100) NULL,
  team_id            VARCHAR(100) NULL,
  source_log_path    TEXT NULL,
  log_sha256         CHAR(64) NULL,
  verified_cause     MEDIUMTEXT NULL,
  verified_solution  MEDIUMTEXT NULL,
  severity           VARCHAR(20) NULL,
  status             ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  verified_by        VARCHAR(100) NULL,
  verified_at        TIMESTAMP NULL DEFAULT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (example_id),
  KEY idx_ai_training_build_log (build_log_id),
  KEY idx_ai_training_analysis (analysis_id),
  KEY idx_ai_training_owner (team_id, users_id),
  KEY idx_ai_training_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
