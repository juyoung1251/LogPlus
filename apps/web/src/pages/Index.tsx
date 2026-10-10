import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from 'react-router-dom';
import "./css/index.css";
import useUserStore from "../store/store";
import axios from "axios";
import { API_BASE_URL } from "../config";

// ── Types ──────────────────────────────────────────────────────────────────
type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG";
type LogType = "run" | "lib";

interface LogFileItem {
  build_log_id: number;
  log_type: LogType;
  created_at: string;
}

interface MyLog {
  build_log_id: number;
  log_type: LogType;
  log_content: string;
  created_at: string;
}
const AI_REANALYZE_URL = `${API_BASE_URL}/ai/reanalyze`;

const LOG_API_URL = `${API_BASE_URL}/db/getLog`;

interface Alert {
  level: LogLevel;
  message: string;
  time: string;
}
// ── 날짜 범위 프리셋 ────────────────────────────────────────────────────────
type RangePresetKey =
  | "all" | "1h" | "6h" | "today" | "yesterday" | "1d" | "3d" | "1w" | "1m" | "custom";

const RANGE_PRESETS: { key: RangePresetKey; label: string }[] = [
  { key: "all",       label: "전체 기간" },
  { key: "1h",        label: "최근 1시간" },
  { key: "6h",        label: "최근 6시간" },
  { key: "today",     label: "오늘" },
  { key: "yesterday", label: "어제" },
  { key: "1d",        label: "하루 전" },
  { key: "3d",        label: "3일 전" },
  { key: "1w",        label: "일주일 전" },
  { key: "1m",        label: "한 달 전" },
  { key: "custom",    label: "사용자 정의" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const fmtDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtInput = (d: Date) => `${fmtDate(d)}T${fmtTime(d)}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const parseInput = (value: string, fallback: Date) => {
  const d = new Date(value);
  return value && !Number.isNaN(d.getTime()) ? d : fallback;
};

/** 종료 시각은 항상 "지금". 시작 시각만 프리셋에 따라 뒤로 이동한다. */
function resolveRange(
  preset: RangePresetKey,
  now: Date,
  customFrom: string,
  customTo: string
): { from: Date; to: Date } {
  const to = new Date(now);
  const from = new Date(now);

  switch (preset) {
    case "all":
      // 시작 시각 제한 없음 — 종료는 다른 프리셋과 똑같이 "지금"
      return { from: new Date(0), to };
    case "1h": from.setHours(from.getHours() - 1); break;
    case "6h": from.setHours(from.getHours() - 6); break;
    case "1d": from.setDate(from.getDate() - 1); break;
    case "3d": from.setDate(from.getDate() - 3); break;
    case "1w": from.setDate(from.getDate() - 7); break;
    case "1m": from.setMonth(from.getMonth() - 1); break;
    case "today":
      return { from: startOfDay(now), to };
    case "yesterday": {
      const start = startOfDay(now);
      start.setDate(start.getDate() - 1);
      const end = new Date(start);
      end.setHours(23, 59, 59, 999);
      return { from: start, to: end };
    }
    case "custom":
      return {
        from: parseInput(customFrom, startOfDay(now)),
        to: parseInput(customTo, to),
      };
  }
  return { from, to };
}

function formatRange(from: Date, to: Date) {
  return fmtDate(from) === fmtDate(to)
    ? `${fmtDate(from)} ${fmtTime(from)} ~ ${fmtTime(to)}`
    : `${fmtDate(from)} ${fmtTime(from)} ~ ${fmtDate(to)} ${fmtTime(to)}`;
}

const Index = () => {
  const navigate = useNavigate();
  const store = useUserStore.getState();
  const userInfo = store.userInfo;
  const reset = store.reset;

const RECENT_ALERTS: Alert[] = [
  { level: "ERROR", message: "[ERROR] DB 연결 실패", time: "02:54:56" },
  { level: "WARN", message: "[WARN] 응답 지연 감지", time: "02:54:55" },
  { level: "INFO", message: "[INFO] 배치 작업 완료", time: "02:55:00" },
];

const TOP_EXCEPTIONS = [
  { name: "NullPointerException", count: 8, color: "#ef4444" },
  { name: "ConnectionTimeoutException", count: 5, color: "#f97316" },
  { name: "IllegalArgumentException", count: 3, color: "#eab308" },
];

const CHART_DATA = [
  { hour: "00:00", error: 1, warn: 3, info: 8 },
  { hour: "03:00", error: 2, warn: 5, info: 12 },
  { hour: "06:00", error: 0, warn: 2, info: 15 },
  { hour: "09:00", error: 3, warn: 8, info: 30 },
  { hour: "12:00", error: 5, warn: 12, info: 45 },
  { hour: "15:00", error: 2, warn: 6, info: 28 },
  { hour: "18:00", error: 4, warn: 9, info: 20 },
  { hour: "21:00", error: 6, warn: 15, info: 18 },
  { hour: "24:00", error: 8, warn: 7, info: 14 },
];

// ── Sub-components ─────────────────────────────────────────────────────────
const levelColor: Record<LogLevel, string> = {
  ERROR: "#b85858",
  WARN:  "#9e7c34",
  INFO:  "#4a7ab8",
  DEBUG: "#56606e",
};

const levelBg: Record<LogLevel, string> = {
  ERROR: "rgba(184, 88, 88, 0.10)",
  WARN:  "rgba(158, 124, 52, 0.10)",
  INFO:  "rgba(74, 122, 184, 0.10)",
  DEBUG: "rgba(86, 96, 110, 0.10)",
};


function StatCard({
  level,
  count,
  delta,
}: {
  level: LogLevel;
  count: number;
  delta: string;
}) {
  const isUp = delta.startsWith("▲") || delta.startsWith("+");
  const isDown = delta.startsWith("▼") || delta.startsWith("-");
  const deltaColor = level === "ERROR" ? (isUp ? "#ef4444" : "#22c55e") : isDown ? "#ef4444" : "#94a3b8";

  return (
    <div
      className="stat-card"
      style={{
        border: `0.1px solid gray`,
        borderTop: `3px solid ${levelColor[level]}`,
      }}
    >
      <div className="stat-card-label" style={{ color: levelColor[level] }}>
        {level}
      </div>
      <div className="stat-card-count" style={{ color: levelColor[level] }}>
        {count}
      </div>
      <div className="stat-card-delta" style={{ color: deltaColor }}>{delta}</div>
    </div>
  );
}

function MiniBarChart() {
  const maxVal = Math.max(...CHART_DATA.map((d) => d.error + d.warn + d.info));
  return (
    <div className="mini-bar-chart">
      {CHART_DATA.map((d, i) => (
        <div key={i} className="bar-col">
          <div className="bar-stack">
            <div
              className="bar-error"
              style={{
                height: Math.round((d.error / maxVal) * 68),
                minHeight: d.error ? 2 : 0,
              }}
            />
            <div
              className="bar-warn"
              style={{
                height: Math.round((d.warn / maxVal) * 68),
                minHeight: d.warn ? 2 : 0,
              }}
            />
            <div
              className="bar-info"
              style={{
                height: Math.round((d.info / maxVal) * 68),
                minHeight: d.info ? 2 : 0,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────
const [activeFilters, setActiveFilters] = useState<LogLevel[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [darkMode, setDarkMode] = useState(true);
  const [activeNav, setActiveNav] = useState("대시보드");
  const [rangePreset, setRangePreset] = useState<RangePresetKey>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [now, setNow] = useState<Date>(() => new Date());
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const focusRef = useRef<Boolean>(false);
  const [search, setSearch] = useState("");
  const [aiAnalysisVisible, setAiAnalysisVisible] = useState(true);
  const [logFileList, setLogFileList] = useState<LogFileItem[]>([]);
  const [selectedLog, setSelectedLog] = useState<MyLog | null>(null);
  const [selectValue, setSelectValue] = useState("default");
  const [aiAnalysis, setAiAnalysis] = useState<string[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // 현재 시각을 매초 갱신 — 날짜 범위의 끝은 항상 "지금"
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // 필터 드롭다운: 바깥 클릭 / ESC 로 닫기
  useEffect(() => {
    if (!filterOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [filterOpen]);

  const { from: rangeFrom, to: rangeTo } = useMemo(
    () => resolveRange(rangePreset, now, customFrom, customTo),
    [rangePreset, now, customFrom, customTo]
  );
  const rangeLabel = RANGE_PRESETS.find((p) => p.key === rangePreset)?.label ?? "전체 기간";
  const rangeText =
    rangePreset === "all"
      ? `전체 기간 ~ ${fmtDate(rangeTo)} ${fmtTime(rangeTo)}`
      : formatRange(rangeFrom, rangeTo);

  const applyPreset = (key: RangePresetKey) => {
    if (key === "custom") {
      // 사용자 정의로 전환할 때 현재 범위를 입력값 초기치로 채워준다
      if (!customFrom) setCustomFrom(fmtInput(rangeFrom));
      if (!customTo) setCustomTo(fmtInput(rangeTo));
      setRangePreset("custom");
      return;
    }
    setRangePreset(key);
    setFilterOpen(false);
  };

  const toggleFilter = (level: LogLevel) => {
    setActiveFilters((prev) =>
      prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level]
    );
  };

  const border = "#1e2d42";
  const muted  = "#546070";
  const fetchLogList = async(e) => {
    if(focusRef.current) return;

    focusRef.current = true;
    const currentUser = useUserStore.getState().userInfo;
    if (!currentUser) {
      e.target.blur();
      alert("로그인이 필요합니다.");
      return;
    }
    
    try {
      const response = await axios.post(LOG_API_URL, {
        users_id: currentUser.userId,
        team_id: currentUser.team_id,
      });
      const data = response.data;

      if (!data || data.status === "fail") {
        e.target.blur();
        alert(data?.message ?? "로그 목록을 불러오지 못했습니다.");
        setLogFileList([]);
        return;
      }

      setLogFileList(data.log_list ?? []);
    } catch (e) {
      console.error("error : ", e);
      alert("로그 목록 조회 중 오류가 발생했습니다.");
      focusRef.current = false;
    }
  }

  async function fetchLogContent(buildLogId: number) {
    const currentUser = useUserStore.getState().userInfo;
    if (!currentUser) {
      alert("로그인이 필요합니다.");
      return;
    }

    try {
      const response = await axios.post(LOG_API_URL, {
        users_id: currentUser.userId,
        team_id: currentUser.team_id,
        build_log_id: buildLogId,
      });
      const data = response.data;

      if (!data || data.status === "fail") {
        alert(data?.message ?? "로그 내용을 불러오지 못했습니다.");
        setSelectValue("default");
        setSelectedLog(null);
        return;
      }

      setSelectedLog(data.log_data);
      setSelectValue(String(buildLogId));
    } catch (e) {
      console.error("error : ", e);
      alert("로그 내용 조회 중 오류가 발생했습니다.");
    }
  }

  async function handleAiReanalyze() {
    const currentUser = useUserStore.getState().userInfo;
    if (!currentUser) {
      alert("로그인이 필요합니다.");
      return;
    }
    if (!selectedLog?.build_log_id) {
      alert("분석할 로그를 먼저 선택하세요.");
      return;
    }

    setIsAnalyzing(true);
    setAiAnalysisVisible(true);
    try {
      const response = await axios.post(AI_REANALYZE_URL, {
        users_id: currentUser.userId,
        team_id: currentUser.team_id,
        build_log_id: selectedLog.build_log_id,
      });
      const data = response.data;
      if (!data || data.status === "fail") {
        alert(data?.message ?? "AI 분석에 실패했습니다.");
        return;
      }

      const lines = data.analysis?.length
        ? data.analysis
        : data.analysis_text
          ? [data.analysis_text]
          : [];
      setAiAnalysis(lines);
    } catch (e) {
      console.error("error : ", e);
      alert("AI 분석 중 오류가 발생했습니다.");
    } finally {
      setIsAnalyzing(false);
    }
  }
  
  async function selectChange(value: string) {
    if (!value || value === "default") {
      setSelectValue("default");
      setSelectedLog(null);
      setAiAnalysis([]);
      return;
    }

    setAiAnalysis([]);
    await fetchLogContent(Number(value));
  }

  function logOut() {
    useUserStore.getState().reset();

    const userInfo = useUserStore.getState().userInfo;
    if(!userInfo || userInfo === null)
    alert("로그아웃 되었습니다.");
  }

  const visibleLogFiles = useMemo(
    () =>
      logFileList.filter((log) => {
        const t = new Date(log.created_at).getTime();
        return Number.isNaN(t) || (t >= rangeFrom.getTime() && t <= rangeTo.getTime());
      }),
    [logFileList, rangeFrom, rangeTo]
  );

  const logLines = useMemo(() => (selectedLog?.log_content ?? "").split(/\r\n|\n|\r/).map((text) => {
    const token = text.match(/\b(ERROR|WARN(?:ING)?|INFO|DEBUG)\b/i)?.[1].toUpperCase();
    const level = token === "WARNING" ? "WARN" : token as LogLevel | undefined;
    return { text, level };
  }), [selectedLog?.log_content]);
  const highlightedCount = logLines.filter(({ level }) => level && activeFilters.includes(level)).length;

  return (
    <div className="app-root">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        {/* Logo */}
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">LP</div>
          <span className="sidebar-logo-text">LogPulse</span>
        </div>

          <button
            key={"dashboard"}
            className={`nav-item`}
          >
            대시보드
          </button>
          <button
            key={"log"}
            className={`nav-item`}
          >
            로그 조회
          </button>
          <button
            key={"user"}
            className={`nav-item`}
            onClick={() => userInfo ? navigate("/user") : navigate("/login")}
          >
            계정 관리
          </button>
          <button
            key={"setting"}
            className={`nav-item`}
          >
            설정
          </button>
          <button
            key={"logsOut"}
            className={`nav-item`}
          >
            로그 내보내기
          </button>
          <button
            key={"darkBoard"}
            className={`nav-item`}
          >
            다크모드
          </button>
          <button
            key={"logOut"}
            className={`nav-item`}
            onClick={() => logOut()}
          >
            로그아웃
          </button>

        <div className="sidebar-version">v1.0.0</div>
      </aside>

      {/* ── Main ── */}
      <div className="main">
        {/* ── Topbar ── */}
        <header className="topbar">
          {/* File selector */}
          <select
            className="topbar-select"
            value={selectValue}
            onFocus={fetchLogList}
            onChange={(e) => selectChange(e.target.value)}
          >
            <option value="default">선택</option>
            {logFileList.length > 0 && visibleLogFiles.length === 0 && (
              <option value="__out_of_range" disabled>
                {rangeLabel} 범위에 로그 없음 · 전체 {logFileList.length}건 (필터에서 기간을 넓히세요)
              </option>
            )}
            {visibleLogFiles.map((log) => (
              <option key={log.build_log_id} value={String(log.build_log_id)}>
                [{log.log_type}] {new Date(log.created_at).toLocaleString()}
              </option>
            ))}
          </select>

          {/* Auto refresh toggle */}
          <div className="auto-refresh-wrap">
            <span className="auto-refresh-label">자동 새로고침</span>
            <div
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`toggle-track ${autoRefresh ? "on" : "off"}`}
            >
              <div className={`toggle-thumb ${autoRefresh ? "on" : "off"}`} />
            </div>
          </div>

          {/* Level filters */}
          {(["ERROR", "WARN", "INFO", "DEBUG"] as LogLevel[]).map((level) => (
            <button
              key={level}
              onClick={() => toggleFilter(level)}
              className="level-filter-btn"
              aria-pressed={activeFilters.includes(level)}
              title={`${level} 줄 강조 ${activeFilters.includes(level) ? "해제" : "켜기"}`}
              style={{
                background: activeFilters.includes(level) ? levelBg[level] : "transparent",
                border: `1px solid ${activeFilters.includes(level) ? levelColor[level] : border}`,
                color: activeFilters.includes(level) ? levelColor[level] : muted,
              }}
            >
              <span
                className="level-filter-dot"
                style={{ background: levelColor[level] }}
              />
              {level}
            </button>
          ))}

          {/* Search */}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="검색..."
            className="topbar-search"
          />

          {/* Date range — 항상 현재 시각 기준 */}
          <div className="topbar-daterange" title="선택한 기간 (종료 시각은 항상 현재 시각)">
            {rangeText}
          </div>

          {/* Filter btn */}
          <div className="topbar-filter-wrap" ref={filterRef}>
            <button
              className="topbar-filter-btn"
              onClick={() => setFilterOpen((v) => !v)}
              aria-haspopup="true"
              aria-expanded={filterOpen}
            >
              필터 · {rangeLabel}
            </button>

            {filterOpen && (
              <div className="date-filter-menu" role="menu">
                <div className="date-filter-menu-title">기간 선택</div>
                {RANGE_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    role="menuitemradio"
                    aria-checked={rangePreset === p.key}
                    className={`date-filter-option ${rangePreset === p.key ? "active" : ""}`}
                    onClick={() => applyPreset(p.key)}
                  >
                    {p.label}
                  </button>
                ))}

                {rangePreset === "custom" && (
                  <div className="date-filter-custom">
                    <label className="date-filter-field">
                      시작
                      <input
                        type="datetime-local"
                        value={customFrom}
                        max={customTo || undefined}
                        onChange={(e) => setCustomFrom(e.target.value)}
                      />
                    </label>
                    <label className="date-filter-field">
                      종료
                      <input
                        type="datetime-local"
                        value={customTo}
                        min={customFrom || undefined}
                        onChange={(e) => setCustomTo(e.target.value)}
                      />
                    </label>
                    <button className="date-filter-apply" onClick={() => setFilterOpen(false)}>
                      적용
                    </button>
                  </div>
                )}

                <div className="date-filter-menu-foot">
                  현재 시각 {fmtDate(now)} {fmtTime(now)}:{pad(now.getSeconds())}
                </div>
              </div>
            )}
          </div>
        </header>

        {/* ── Body ── */}
        <div className="body">
          {/* ── Left: Stats + Log viewer + AI analysis ── */}
          <div className="left-panel">
            {/* Stat cards */}
            <div className="stat-cards">
              <StatCard level="ERROR" count={12} delta="▲ +3 vs 어제" />
              <StatCard level="WARN" count={35} delta="▼ -8 vs 어제" />
              <StatCard level="INFO" count={152} delta="— +12 vs 어제" />
              <StatCard level="DEBUG" count={243} delta="— -5 vs 어제" />
            </div>

            {/* Log viewer */}
            <div className="log-viewer">
              {selectedLog ? (
                <div className="log-item">
                  <span className="log-time">[{new Date(selectedLog.created_at).toLocaleString()}] </span>
                  <strong className="log-type">[{selectedLog.log_type}]</strong>
                  <div className="log-highlight-status" role="status">
                    {activeFilters.length ? `${activeFilters.join(", ")} · ${highlightedCount}줄 강조` : "상단에서 로그 레벨을 누르면 해당 줄이 강조됩니다."}
                  </div>
                  <div className="log-content">
                    {logLines.map(({ text, level }, index) => {
                      const highlighted = level && activeFilters.includes(level);
                      return (
                        <div
                          key={index}
                          className="log-text-line"
                          style={highlighted ? {
                            background: levelBg[level],
                            borderLeftColor: levelColor[level],
                            fontWeight: 700,
                          } : undefined}
                        >{text || "\u00a0"}</div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <p>표시할 로그가 없습니다. 상단에서 로그 파일을 선택하세요.</p>
              )}
            </div>

            {/* AI Analysis panel */}
            {aiAnalysisVisible && (
              <div className="ai-panel">
                <div className="ai-panel-header">
                  <span className="ai-panel-title">*분석, 해결법*(실시간)</span>
                  <span className="ai-panel-badge">AI Powered</span>
                </div>
                <div className="ai-panel-body">
                  <ul className="ai-panel-list">
                    {isAnalyzing ? (
                      <li>AI 분석 중...</li>
                    ) : aiAnalysis.length > 0 ? (
                      aiAnalysis.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))
                    ) : (
                      <li>AI 분석 버튼을 눌러 로그를 분석하세요.</li>
                    )}
                  </ul>
                </div>
                <div className="ai-panel-actions">
                  <button
                    className="btn-primary"
                    onClick={handleAiReanalyze}
                    disabled={isAnalyzing || !selectedLog}
                  >
                    {isAnalyzing ? "분석 중..." : "AI 분석"}
                  </button>
                  <button
                    className="btn-secondary"
                    style={{ border: `1px solid ${border}` }}
                  >
                    다운로드
                  </button>
                  <button
                    className="btn-secondary"
                    style={{ border: `1px solid ${border}` }}
                  >
                    히스토리
                  </button>
                </div>
              </div>
            )}

            {/* Quick filters */}
            <div className="quick-filters">
              <span className="quick-filter-label">빠른 필터:</span>
              {RANGE_PRESETS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => {
                    applyPreset(p.key);
                    if (p.key === "custom") setFilterOpen(true);
                  }}
                  className={`quick-filter-btn ${rangePreset === p.key ? "active" : "inactive"}`}
                  style={rangePreset !== p.key ? { border: `1px solid ${border}` } : undefined}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Right sidebar ── */}
          <aside className="right-sidebar">
            {/* Recent alerts */}
            <section>
              <div className="section-header">
                <span className="section-title">최근 알림</span>
                <span className="section-action">설정</span>
              </div>
              <div className="alert-list">
                {RECENT_ALERTS.map((a, i) => (
                  <div key={i} className="alert-item">
                    <span
                      className="alert-dot"
                      style={{ background: levelColor[a.level] }}
                    />
                    <span className="alert-message">{a.message}</span>
                    <span className="alert-time">{a.time}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* Log chart */}
            <section>
              <div className="section-title" style={{ marginBottom: 10 }}>
                로그 통계 (오늘)
              </div>
              <MiniBarChart />
              <div className="chart-x-labels">
                {["00:00", "06:00", "12:00", "18:00", "24:00"].map((t) => (
                  <span key={t} className="chart-x-label">{t}</span>
                ))}
              </div>
            </section>

            {/* Top exceptions */}
            <section>
              <div className="section-title" style={{ marginBottom: 12 }}>
                자주 발생하는 예외 TOP 3
              </div>
              <div className="exception-list">
                {TOP_EXCEPTIONS.map((ex, i) => (
                  <div key={i} className="exception-item">
                    <span className="exception-name">{ex.name}</span>
                    <span
                      className="exception-count"
                      style={{
                        background: ex.color + "22",
                        color: ex.color,
                        border: `1px solid ${ex.color}44`,
                      }}
                    >
                      {ex.count}회
                    </span>
                  </div>
                ))}
              </div>
            </section>


            {/* AI summary footer */}
            <section>
              <div className="section-title" style={{ marginBottom: 10 }}>
                AI 분석 요약 (오늘)
              </div>
              <button
                className="btn-download"
                style={{ border: `1px solid ${border}` }}
              >
                이전 로그 다운로드
              </button>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

export default Index;
