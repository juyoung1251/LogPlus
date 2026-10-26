import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./css/index.css";
import useUserStore from "../store/store";
import axios from "axios";
import { API_BASE_URL } from "../config";

// ── Types ──────────────────────────────────────────────────────────────────
type AlertLevel = "ERROR" | "WARN" | "INFO";

interface DailyStat {
  date: string;
  error: number;
  warn: number;
}

interface ExceptionCount {
  name: string;
  count: number;
}

interface LanguageShare {
  language: string;
  count: number;
  percent: number;
}

interface Alert {
  build_log_id: number;
  level: AlertLevel;
  message: string;
  date: string;
  time: string;
}

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: T };

const DASHBOARD_API_URL = `${API_BASE_URL}/dashboard`;

// 어두운 카드 배경(#18243a)에서 색약 구분·대비 검증을 통과한 쌍
const levelColor: Record<AlertLevel, string> = {
  ERROR: "#d9485a",
  WARN: "#bb8a2c",
  INFO: "#4a7ab8",
};

const DAILY_SERIES = [
  { key: "error", label: "ERROR", color: levelColor.ERROR },
  { key: "warn", label: "WARN", color: levelColor.WARN },
] as const;

const CHART_HEIGHT = 180;

/** 축 눈금: 최댓값을 넘는 깔끔한 정수 4칸 */
function niceTicks(max: number) {
  const step = Math.max(1, Math.ceil(max / 4));
  return [0, 1, 2, 3, 4].map((i) => i * step);
}

const shortDate = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
};

/** GET /dashboard/{path} 를 현재 로그인 사용자 기준으로 부른다. reloadKey가 바뀌면 다시 불러온다 */
function useDashboardApi<T>(path: string, params: Record<string, string | number>, reloadKey: number) {
  const userInfo = useUserStore((s) => s.userInfo);
  const requestKey = JSON.stringify([path, params, reloadKey, userInfo]);
  // 응답을 어떤 요청에 대한 것인지와 함께 둔다. 키가 다르면 아직 새 요청이 진행 중인 것이다
  const [result, setResult] = useState<{ key: string; state: LoadState<T> } | null>(null);

  useEffect(() => {
    if (!userInfo) return;

    // 응답이 오기 전에 사용자나 조건이 바뀌면 늦게 온 결과는 버린다
    let cancelled = false;
    const [, requestParams] = JSON.parse(requestKey);
    axios
      .get<T>(`${DASHBOARD_API_URL}/${path}`, {
        params: { users_id: userInfo.userId, team_id: userInfo.team_id, ...requestParams },
      })
      .then((response) => {
        if (!cancelled) setResult({ key: requestKey, state: { status: "success", data: response.data } });
      })
      .catch((e) => {
        console.error("error : ", e);
        if (!cancelled) setResult({ key: requestKey, state: { status: "error", message: "데이터를 불러오지 못했습니다." } });
      });
    return () => {
      cancelled = true;
    };
  }, [path, requestKey, userInfo]);

  if (!userInfo) return { status: "error", message: "로그인이 필요합니다." } as LoadState<T>;
  return result?.key === requestKey ? result.state : ({ status: "loading" } as LoadState<T>);
}

// ── Main Component ─────────────────────────────────────────────────────────
const Dashboard = () => {
  const navigate = useNavigate();
  const userInfo = useUserStore((s) => s.userInfo);
  // 새로고침 버튼을 누르면 네 섹션이 함께 다시 불러온다
  const [reloadKey, setReloadKey] = useState(0);
  const [days, setDays] = useState(7);
  const [hoverDay, setHoverDay] = useState<number | null>(null);

  const daily = useDashboardApi<{ days: DailyStat[] }>("daily-stats", { days }, reloadKey);
  const exceptions = useDashboardApi<{ exceptions: ExceptionCount[] }>("top-exceptions", { limit: 3 }, reloadKey);
  const languages = useDashboardApi<{ total: number; languages: LanguageShare[] }>("language-distribution", {}, reloadKey);
  const alerts = useDashboardApi<{ alerts: Alert[] }>("recent-alerts", { limit: 20 }, reloadKey);

  // 섹션 1: 일별 ERROR/WARN
  const dailyRows = daily.status === "success" ? daily.data.days : [];
  const dailyMax = Math.max(0, ...dailyRows.flatMap((r) => [r.error, r.warn]));
  const ticks = niceTicks(dailyMax);
  const tickTop = ticks[ticks.length - 1];
  const dailyTotal = dailyRows.reduce(
    (sum, r) => ({ error: sum.error + r.error, warn: sum.warn + r.warn }),
    { error: 0, warn: 0 }
  );

  // 섹션 2·3·4
  const exceptionItems = exceptions.status === "success" ? exceptions.data.exceptions : [];
  const exceptionMax = Math.max(1, ...exceptionItems.map((e) => e.count));
  const languageItems = languages.status === "success" ? languages.data.languages : [];
  const alertItems = alerts.status === "success" ? alerts.data.alerts : [];

  // 스토어를 비우면 sessionStorage에 저장된 로그인 정보도 함께 지워진다
  // alert는 확인을 누르거나 닫을 때까지 멈춰 있으므로, 그 다음 줄에서 로그인 페이지로 보낸다
  function requireLogin() {
    alert("로그인이 필요합니다.");
    navigate("/login", { replace: true });
  }

  function logOut() {
    useUserStore.getState().reset();
    alert("로그아웃 되었습니다.");
    navigate("/login", { replace: true });
  }

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
            className={`nav-item active`}
            aria-current="page"
          >
            대시보드
          </button>
          <button
            key={"log"}
            className={`nav-item`}
            onClick={() => navigate("/logs")}
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
        <div className="dashboard">
          <div className="dashboard-head">
            <h1 className="dashboard-title">대시보드</h1>
            <button className="btn-secondary" onClick={() => userInfo ? setReloadKey((k) => k + 1) : requireLogin()}>
              새로고침
            </button>
          </div>

          {/* ── 상단: 최근 분석 기록 (일별 ERROR / WARN) ── */}
          <section className="dash-card">
            <div className="section-header">
              <span className="section-title">최근 분석 기록 (일별 ERROR / WARN)</span>
              <div className="dash-range">
                {[7, 14, 30].map((n) => (
                  <button
                    key={n}
                    className={`dash-range-btn ${days === n ? "active" : ""}`}
                    onClick={() => userInfo ? setDays(n) : requireLogin()}
                    aria-pressed={days === n}
                  >
                    {n}일
                  </button>
                ))}
              </div>
            </div>

            <div className="dash-legend">
              {DAILY_SERIES.map((s) => (
                <span key={s.key} className="dash-legend-item">
                  <span className="dash-legend-swatch" style={{ background: s.color }} />
                  {s.label} <strong>{dailyTotal[s.key]}</strong>
                </span>
              ))}
              <span className="dash-muted">RUN 로그 기준 · 빌드 날짜별 줄 수</span>
            </div>

            {daily.status === "loading" && <p className="dash-empty">불러오는 중...</p>}
            {daily.status === "error" && <p className="dash-empty">{daily.message}</p>}
            {daily.status === "success" && (
              <div className="daily-chart">
                <div className="daily-y-axis" style={{ height: CHART_HEIGHT }}>
                  {[...ticks].reverse().map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
                <div className="daily-plot" style={{ height: CHART_HEIGHT }} onMouseLeave={() => setHoverDay(null)}>
                  {ticks.map((t) => (
                    <div key={t} className="daily-grid" style={{ bottom: `${(t / tickTop) * 100}%` }} />
                  ))}
                  {dailyRows.map((r, i) => (
                    <div
                      key={r.date}
                      className={`daily-col ${hoverDay === i ? "hover" : ""}`}
                      onMouseEnter={() => setHoverDay(i)}
                    >
                      <div className="daily-bars">
                        {DAILY_SERIES.map((s) => (
                          <div
                            key={s.key}
                            className="daily-bar"
                            style={{ height: `${(r[s.key] / tickTop) * 100}%`, background: s.color }}
                          />
                        ))}
                      </div>
                      {hoverDay === i && (
                        <div className={`daily-tooltip ${i > dailyRows.length / 2 ? "left" : ""}`} role="tooltip">
                          <div className="daily-tooltip-date">{r.date}</div>
                          {DAILY_SERIES.map((s) => (
                            <div key={s.key} className="daily-tooltip-row">
                              <span className="dash-legend-swatch" style={{ background: s.color }} />
                              {s.label}
                              <strong>{r[s.key]}</strong>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="daily-x-axis">
                  {dailyRows.map((r, i) => (
                    // 30일이면 라벨이 겹치므로 일부만 표시한다
                    <span key={r.date}>
                      {dailyRows.length <= 14 || i % 5 === 0 || i === dailyRows.length - 1 ? shortDate(r.date) : ""}
                    </span>
                  ))}
                </div>
                {dailyMax === 0 && (
                  <p className="dash-muted daily-empty-note">
                    최근 {days}일 동안 RUN 로그에서 ERROR/WARN이 발생하지 않았습니다.
                  </p>
                )}
              </div>
            )}
          </section>

          {/* ── 중단: 예외 TOP 3 | 언어별 빌드 분포 ── */}
          <div className="dashboard-row">
            <section className="dash-card">
              <div className="section-header">
                <span className="section-title">자주 발생하는 예외 TOP 3</span>
                <span className="dash-muted">RUN 로그 전체</span>
              </div>

              {exceptions.status === "loading" && <p className="dash-empty">불러오는 중...</p>}
              {exceptions.status === "error" && <p className="dash-empty">{exceptions.message}</p>}
              {exceptions.status === "success" && exceptionItems.length === 0 && (
                <p className="dash-empty">RUN 로그에서 발견된 예외가 없습니다.</p>
              )}
              {exceptionItems.length > 0 && (
                <ol className="rank-list">
                  {exceptionItems.map((ex, i) => (
                    <li key={ex.name} className="rank-item">
                      <span className="rank-no">{i + 1}</span>
                      <div className="rank-body">
                        <div className="rank-row">
                          <span className="exception-name" title={ex.name}>{ex.name}</span>
                          <span className="rank-count">{ex.count}회</span>
                        </div>
                        <div className="rank-track">
                          <div className="rank-fill error" style={{ width: `${(ex.count / exceptionMax) * 100}%` }} />
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="dash-card">
              <div className="section-header">
                <span className="section-title">언어별 빌드 분포</span>
                {languages.status === "success" && (
                  <span className="dash-muted">팀 전체 빌드 {languages.data.total}건</span>
                )}
              </div>

              {languages.status === "loading" && <p className="dash-empty">불러오는 중...</p>}
              {languages.status === "error" && <p className="dash-empty">{languages.message}</p>}
              {languages.status === "success" && languageItems.length === 0 && (
                <p className="dash-empty">아직 실행된 빌드가 없습니다.</p>
              )}
              {languageItems.length > 0 && (
                <ol className="rank-list">
                  {languageItems.map((lang) => (
                    <li key={lang.language} className="rank-item">
                      <div className="rank-body">
                        <div className="rank-row">
                          <span className="lang-name">{lang.language}</span>
                          <span className="rank-count">
                            {lang.percent}% <span className="dash-muted">({lang.count}건)</span>
                          </span>
                        </div>
                        <div className="rank-track">
                          <div className="rank-fill accent" style={{ width: `${lang.percent}%` }} />
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          {/* ── 하단: 최근 알림 ── */}
          <section className="dash-card">
            <div className="section-header">
              <span className="section-title">최근 알림</span>
              <span className="dash-muted">RUN 로그 최신 {alertItems.length}건</span>
            </div>

            {alerts.status === "loading" && <p className="dash-empty">불러오는 중...</p>}
            {alerts.status === "error" && <p className="dash-empty">{alerts.message}</p>}
            {alerts.status === "success" && alertItems.length === 0 && (
              <p className="dash-empty">RUN 로그에 ERROR / WARN / INFO 이벤트가 없습니다.</p>
            )}
            {alertItems.length > 0 && (
              <div className="alert-list">
                {alertItems.map((a, i) => (
                  <div key={`${a.build_log_id}-${i}`} className="alert-item">
                    <span className="alert-dot" style={{ background: levelColor[a.level] }} />
                    <span className="alert-level" style={{ color: levelColor[a.level] }}>[{a.level}]</span>
                    <span className="alert-message" title={a.message}>{a.message}</span>
                    <span className="alert-time" title={`${a.date} ${a.time}`}>
                      {a.date.slice(5)} {a.time}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
