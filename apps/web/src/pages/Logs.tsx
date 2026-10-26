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
const AI_HISTORY_URL = `${API_BASE_URL}/ai/history`;
const AI_DOWNLOAD_URL = `${API_BASE_URL}/ai/download`;

const LOG_API_URL = `${API_BASE_URL}/db/getLog`;

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

/** 파일명 앞부분: 로그 생성 시각(2026-07-21_09-45-26), 시각이 없으면 build_log_id */
function logStamp(log: MyLog) {
  const d = new Date(log.created_at);
  return Number.isNaN(d.getTime())
    ? String(log.build_log_id)
    : `${fmtDate(d)}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** 한 줄의 로그 레벨. 뷰어 줄 강조·대시보드 집계와 같은 규칙(대소문자 무시) */
function lineLevel(text: string): LogLevel | undefined {
  const token = text.match(/\b(ERROR|WARN(?:ING)?|INFO|DEBUG)\b/i)?.[1].toUpperCase();
  return token === "WARNING" ? "WARN" : token as LogLevel | undefined;
}

function countLevels(content: string) {
  const counts = { ERROR: 0, WARN: 0 };
  for (const line of content.split(/\r\n|\n|\r/)) {
    const level = lineLevel(line);
    if (level === "ERROR" || level === "WARN") counts[level] += 1;
  }
  return counts;
}

type LevelCounts = ReturnType<typeof countLevels>;

const AUTO_REFRESH_MS = 30_000;

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 클릭 직후 바로 해제하면 일부 브라우저에서 다운로드가 끊기므로 한 박자 늦춘다
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 저장된 분석 파일은 "헤더 + '=' 60개 줄 + 본문" 형태라 본문만 꺼내 서버(/ai/reanalyze)와 같은 규칙으로 줄을 나눈다 */
function toAnalysisLines(fileText: string) {
  const separator = "=".repeat(60);
  const at = fileText.indexOf(separator);
  const body = at >= 0 ? fileText.slice(at + separator.length) : fileText;
  return body
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim())
    .map((line) => line.replace(/^[ \-•\t]+|[ \-•\t]+$/g, ""));
}

/** responseType: "blob" 이면 404 응답 본문({detail})도 Blob으로 오므로 풀어서 메시지를 꺼낸다 */
async function readDownloadError(e: unknown) {
  const fallback = "분석 결과 다운로드 중 오류가 발생했습니다.";
  if (!axios.isAxiosError(e) || !(e.response?.data instanceof Blob)) return fallback;
  try {
    const body = JSON.parse(await e.response.data.text());
    return typeof body?.detail === "string" ? body.detail : fallback;
  } catch {
    return fallback;
  }
}

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
  count: number | null;
  /** 숫자면 이전 빌드 대비 증감, 문자열이면 그대로 보여줄 안내 */
  delta: number | string;
}) {
  // ERROR·WARN은 늘면 나쁜 것이므로 증가는 빨강, 감소는 초록
  const deltaColor = typeof delta !== "number" || delta === 0 ? "#94a3b8" : delta > 0 ? "#ef4444" : "#22c55e";
  const deltaText = typeof delta !== "number"
    ? delta
    : delta === 0
      ? "– 이전 빌드와 같음"
      : `${delta > 0 ? "▲ +" : "▼ "}${delta} vs 이전 빌드`;

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
        {count ?? "–"}
      </div>
      <div className="stat-card-delta" style={{ color: deltaColor }}>{deltaText}</div>
    </div>
  );
}

const Logs = () => {
  const navigate = useNavigate();
  const store = useUserStore.getState();
  const reset = store.reset;

// ── Main Component ─────────────────────────────────────────────────────────
const [activeFilters, setActiveFilters] = useState<LogLevel[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
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
  const [analysisId, setAnalysisId] = useState<number | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  // 이전 빌드의 ERROR/WARN 줄 수. 어느 로그를 기준으로 비교한 값인지 함께 둔다
  const [prevStats, setPrevStats] = useState<
    { forId: number; prevId: number; counts: LevelCounts | null } | null
  >(null);
  // 지금 선택된 로그. 늦게 도착한 응답이 다른 로그의 결과를 덮어쓰지 않도록 비교용으로 쓴다
  const currentLogIdRef = useRef<number | null>(null);

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
  // alert는 확인을 누르거나 닫을 때까지 멈춰 있으므로, 그 다음 줄에서 로그인 페이지로 보낸다
  function requireLogin() {
    alert("로그인이 필요합니다.");
    navigate("/login", { replace: true });
  }

  const muted  = "#546070";
  const fetchLogList = async(e) => {
    if(focusRef.current) return;

    focusRef.current = true;
    const currentUser = useUserStore.getState().userInfo;
    if (!currentUser) {
      e.target.blur();
      requireLogin();
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

  // 자동 새로고침: 켜져 있으면 로그 목록을 주기적으로 다시 받아 새 빌드를 반영한다.
  // 백그라운드 갱신이라 실패해도 팝업을 띄우지 않는다
  useEffect(() => {
    if (!autoRefresh) return;

    const refresh = async () => {
      const currentUser = useUserStore.getState().userInfo;
      if (!currentUser) return;
      try {
        const response = await axios.post(LOG_API_URL, {
          users_id: currentUser.userId,
          team_id: currentUser.team_id,
        });
        if (response.data?.status === "success") {
          setLogFileList(response.data.log_list ?? []);
          focusRef.current = true;
        }
      } catch (e) {
        console.error("error : ", e);
      }
    };

    refresh();
    const id = setInterval(refresh, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh]);

  // 선택한 로그와 같은 종류(run/lib)의 바로 이전 빌드
  const prevLog = useMemo(() => {
    if (!selectedLog) return null;
    const selectedAt = new Date(selectedLog.created_at).getTime();
    return logFileList
      .filter((log) => log.log_type === selectedLog.log_type && new Date(log.created_at).getTime() < selectedAt)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] ?? null;
  }, [selectedLog, logFileList]);

  const selectedId = selectedLog?.build_log_id;
  const prevId = prevLog?.build_log_id;
  useEffect(() => {
    const currentUser = useUserStore.getState().userInfo;
    if (selectedId === undefined || prevId === undefined || !currentUser) return;

    // 비교 중에 다른 로그를 고르면 늦게 온 결과는 버린다
    let cancelled = false;
    axios
      .post(LOG_API_URL, {
        users_id: currentUser.userId,
        team_id: currentUser.team_id,
        build_log_id: prevId,
      })
      .then((response) => {
        const content = response.data?.status === "success" ? response.data.log_data?.log_content : null;
        if (!cancelled) setPrevStats({ forId: selectedId, prevId, counts: content == null ? null : countLevels(content) });
      })
      .catch((e) => {
        console.error("error : ", e);
        if (!cancelled) setPrevStats({ forId: selectedId, prevId, counts: null });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, prevId]);

  async function fetchLogContent(buildLogId: number): Promise<boolean> {
    const currentUser = useUserStore.getState().userInfo;
    if (!currentUser) {
      requireLogin();
      return false;
    }

    try {
      const response = await axios.post(LOG_API_URL, {
        users_id: currentUser.userId,
        team_id: currentUser.team_id,
        build_log_id: buildLogId,
      });
      const data = response.data;
      if (currentLogIdRef.current !== buildLogId) return false;

      if (!data || data.status === "fail") {
        alert(data?.message ?? "로그 내용을 불러오지 못했습니다.");
        currentLogIdRef.current = null;
        setSelectValue("default");
        setSelectedLog(null);
        return false;
      }

      setSelectedLog(data.log_data);
      setSelectValue(String(buildLogId));
      return true;
    } catch (e) {
      console.error("error : ", e);
      if (currentLogIdRef.current !== buildLogId) return false;
      alert("로그 내용 조회 중 오류가 발생했습니다.");
      // 화면에 이전 로그가 남아 있으면 ref와 어긋나므로 선택을 비운다
      currentLogIdRef.current = null;
      setSelectValue("default");
      setSelectedLog(null);
      return false;
    }
  }

  // 이미 분석해 둔 로그면 가장 최근 분석을 패널에 띄우고 다운로드할 수 있게 한다
  async function loadLatestAnalysis(buildLogId: number) {
    const currentUser = useUserStore.getState().userInfo;
    if (!currentUser) return;

    try {
      const listResponse = await axios.post(AI_HISTORY_URL, {
        users_id: currentUser.userId,
        team_id: currentUser.team_id,
        build_log_id: buildLogId,
      });
      // 이력이 없으면 서버가 fail을 주지만, 아직 분석하지 않은 로그일 뿐이라 알리지 않는다
      const latest = listResponse.data?.history?.[0];
      if (!latest || currentLogIdRef.current !== buildLogId) return;

      const bodyResponse = await axios.post(AI_HISTORY_URL, {
        users_id: currentUser.userId,
        team_id: currentUser.team_id,
        analysis_id: latest.analysis_id,
      });
      const analysisData = bodyResponse.data?.analysis_data;
      if (!analysisData || currentLogIdRef.current !== buildLogId) return;

      setAiAnalysis(toAnalysisLines(analysisData.analysis_text ?? ""));
      setAnalysisId(analysisData.analysis_id);
    } catch (e) {
      console.error("error : ", e);
    }
  }

  async function handleAiReanalyze() {
    const currentUser = useUserStore.getState().userInfo;
    if (!currentUser) {
      requireLogin();
      return;
    }
    if (!selectedLog?.build_log_id) {
      alert("분석할 로그를 먼저 선택하세요.");
      return;
    }

    const targetLogId = selectedLog.build_log_id;
    setIsAnalyzing(true);
    setAiAnalysisVisible(true);
    try {
      const response = await axios.post(AI_REANALYZE_URL, {
        users_id: currentUser.userId,
        team_id: currentUser.team_id,
        build_log_id: targetLogId,
      });
      const data = response.data;
      // 분석하는 사이 다른 로그를 골랐다면 이 결과는 버린다
      if (currentLogIdRef.current !== targetLogId) return;
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
      setAnalysisId(data.analysis_id ?? null);
    } catch (e) {
      console.error("error : ", e);
      alert("AI 분석 중 오류가 발생했습니다.");
    } finally {
      setIsAnalyzing(false);
    }
  }
  
  async function selectChange(value: string) {
    setAiAnalysis([]);
    setAnalysisId(null);

    if (!value || value === "default") {
      currentLogIdRef.current = null;
      setSelectValue("default");
      setSelectedLog(null);
      return;
    }

    const buildLogId = Number(value);
    currentLogIdRef.current = buildLogId;
    if (await fetchLogContent(buildLogId)) {
      await loadLatestAnalysis(buildLogId);
    }
  }

  // 선택한 로그는 이미 본문을 받아온 상태라 서버를 다시 거치지 않고 바로 파일로 저장한다
  // .log 확장자는 크롬이 "안전하지 않은 다운로드"로 차단하므로 .txt로 저장한다
  function downloadLog() {
    if (!selectedLog) return;

    const filename = `${logStamp(selectedLog)}_${selectedLog.log_type.toUpperCase()}.txt`;
    saveBlob(new Blob([selectedLog.log_content], { type: "text/plain;charset=utf-8" }), filename);
  }

  // 분석 결과는 서버에 저장된 txt(헤더 포함)를 받는다. 파일명은 로그 내보내기와 맞춰 프론트에서 짓는다
  async function downloadAnalysis() {
    const currentUser = useUserStore.getState().userInfo;
    if (!currentUser) {
      requireLogin();
      return;
    }
    if (!selectedLog || analysisId === null) return;

    const filename = `${logStamp(selectedLog)}_${selectedLog.log_type.toUpperCase()}_AI_${analysisId}.txt`;
    setIsDownloading(true);
    try {
      const response = await axios.get(AI_DOWNLOAD_URL, {
        params: {
          users_id: currentUser.userId,
          team_id: currentUser.team_id,
          analysis_id: analysisId,
        },
        responseType: "blob",
      });
      saveBlob(response.data, filename);
    } catch (e) {
      console.error("error : ", e);
      alert(await readDownloadError(e));
    } finally {
      setIsDownloading(false);
    }
  }

  // 스토어를 비우면 sessionStorage에 저장된 로그인 정보도 함께 지워진다
  function logOut() {
    useUserStore.getState().reset();
    alert("로그아웃 되었습니다.");
    navigate("/login", { replace: true });
  }

  const visibleLogFiles = useMemo(
    () =>
      logFileList.filter((log) => {
        const t = new Date(log.created_at).getTime();
        return Number.isNaN(t) || (t >= rangeFrom.getTime() && t <= rangeTo.getTime());
      }),
    [logFileList, rangeFrom, rangeTo]
  );

  const logLines = useMemo(() => (selectedLog?.log_content ?? "").split(/\r\n|\n|\r/).map((text) => (
    { text, level: lineLevel(text) }
  )), [selectedLog?.log_content]);
  const keyword = search.trim().toLowerCase();
  const visibleLines = useMemo(
    () => keyword ? logLines.filter(({ text }) => text.toLowerCase().includes(keyword)) : logLines,
    [logLines, keyword]
  );
  // 통계 카드: 선택한 로그의 실제 줄 수와 이전 빌드 대비 증감
  const currentCounts = useMemo(
    () => selectedLog ? countLevels(selectedLog.log_content ?? "") : null,
    [selectedLog]
  );
  function statDelta(level: "ERROR" | "WARN"): number | string {
    if (!currentCounts) return "로그를 선택하세요";
    if (!prevLog) return "이전 빌드 없음";
    if (!prevStats || prevStats.forId !== selectedId || prevStats.prevId !== prevLog.build_log_id) return "이전 빌드와 비교 중...";
    if (!prevStats.counts) return "이전 빌드 비교 불가";
    return currentCounts[level] - prevStats.counts[level];
  }

  const highlightedCount = visibleLines.filter(({ level }) => level && activeFilters.includes(level)).length;

  return (
    <div className="app-root">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        {/* Logo — 누르면 브라우저 전체를 새로고침하고 기본 화면(대시보드)으로 간다 */}
        <button
          className="sidebar-logo"
          onClick={() => window.location.assign("/dashboard")}
          title="새로고침"
        >
          <div className="sidebar-logo-icon">LP</div>
          <span className="sidebar-logo-text">LogPlus</span>
        </button>

          <button
            key={"dashboard"}
            className={`nav-item`}
            onClick={() => navigate("/dashboard")}
          >
            대시보드
          </button>
          <button
            key={"log"}
            className={`nav-item active`}
            aria-current="page"
          >
            로그 조회
          </button>
          <button
            key={"setting"}
            className={`nav-item`}
            onClick={() => navigate("/settings")}
          >
            설정
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
              role="switch"
              aria-checked={autoRefresh}
              title={autoRefresh ? `로그 목록을 ${AUTO_REFRESH_MS / 1000}초마다 다시 불러옵니다` : "자동 새로고침 꺼짐"}
            >
              <div className={`toggle-thumb ${autoRefresh ? "on" : "off"}`} />
            </div>
          </div>

          {/* Level filters */}
          {(["ERROR", "WARN"] as LogLevel[]).map((level) => (
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
              <StatCard level="ERROR" count={currentCounts?.ERROR ?? null} delta={statDelta("ERROR")} />
              <StatCard level="WARN" count={currentCounts?.WARN ?? null} delta={statDelta("WARN")} />
            </div>

            {/* Log viewer */}
            <div className="log-viewer">
              {selectedLog ? (
                <div className="log-item">
                  <div className="log-header">
                    <div>
                      <span className="log-time">[{new Date(selectedLog.created_at).toLocaleString()}] </span>
                      <strong className="log-type">[{selectedLog.log_type}]</strong>
                    </div>
                    <div className="log-header-actions">
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        type="search"
                        placeholder="로그 내용 검색..."
                        aria-label="로그 내용 검색"
                        className="topbar-search log-search"
                      />
                      <button className="btn-secondary log-download-btn" onClick={downloadLog}>
                        로그 내보내기
                      </button>
                    </div>
                  </div>
                  <div className="log-highlight-status" role="status">
                    {keyword && `"${search.trim()}" 검색 · ${visibleLines.length} / ${logLines.length}줄 일치${activeFilters.length ? " · " : ""}`}
                    {activeFilters.length ? `${activeFilters.join(", ")} · ${highlightedCount}줄 강조` : !keyword && "상단에서 로그 레벨을 누르면 해당 줄이 강조됩니다."}
                  </div>
                  <div className="log-content">
                    {keyword && visibleLines.length === 0 && (
                      <p>검색어와 일치하는 줄이 없습니다.</p>
                    )}
                    {visibleLines.map(({ text, level }, index) => {
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
                    onClick={downloadAnalysis}
                    disabled={!selectedLog || analysisId === null || isAnalyzing || isDownloading}
                    title={analysisId === null ? "먼저 AI 분석을 실행하세요." : "AI 분석 결과(해결법)를 txt로 저장"}
                  >
                    {isDownloading ? "다운로드 중..." : "다운로드"}
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

        </div>
      </div>
    </div>
  );
}

export default Logs;
