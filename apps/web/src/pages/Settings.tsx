import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import "./css/index.css";
import useUserStore from "../store/store";
import { API_BASE_URL } from "../config";

interface SettingsData {
  users_id: string;
  team_id: string;
  created_at: string | null;
  build_count: number;
  ai_count: number;
  teammates: string[];
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: SettingsData };

const formatDate = (iso: string | null) => {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("ko-KR");
};

// 서버가 http로 떠 있으면 navigator.clipboard가 없으므로 textarea 복사로 대신한다
async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!ok) throw new Error("copy failed");
}

// 설정 페이지 — 계정 → 저장소 → 내 활동 → 팀원 → 위험 영역 순서로 세로 배치
const Settings = () => {
  const navigate = useNavigate();
  const userInfo = useUserStore((s) => s.userInfo);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwMessage, setPwMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pwSaving, setPwSaving] = useState(false);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawPw, setWithdrawPw] = useState("");
  const [withdrawError, setWithdrawError] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);

  // alert는 확인을 누르거나 닫을 때까지 멈춰 있으므로, 그 다음 줄에서 로그인 페이지로 보낸다
  useEffect(() => {
    if (!userInfo) {
      alert("로그인이 필요합니다.");
      navigate("/login", { replace: true });
      return;
    }

    // 응답이 오기 전에 사용자가 바뀌면 늦게 온 결과는 버린다
    let cancelled = false;
    axios
      .get<SettingsData>(`${API_BASE_URL}/user/settings`, { params: { users_id: userInfo.userId } })
      .then((response) => {
        if (!cancelled) setLoad({ status: "success", data: response.data });
      })
      .catch((e) => {
        console.error("error : ", e);
        if (!cancelled) setLoad({ status: "error", message: "데이터를 불러오지 못했습니다." });
      });
    return () => {
      cancelled = true;
    };
  }, [userInfo, navigate]);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // 스토어를 비우면 sessionStorage에 저장된 로그인 정보도 함께 지워진다
  function logOut() {
    useUserStore.getState().reset();
    alert("로그아웃 되었습니다.");
    navigate("/login", { replace: true });
  }

  function showToast(text: string) {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2000);
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!userInfo) return;
    if (!currentPw || !newPw || !confirmPw) {
      setPwMessage({ ok: false, text: "모든 항목을 입력해주세요." });
      return;
    }
    if (newPw !== confirmPw) {
      setPwMessage({ ok: false, text: "새 비밀번호가 일치하지 않습니다." });
      return;
    }

    setPwSaving(true);
    try {
      const response = await axios.post(`${API_BASE_URL}/user/changePassword`, {
        users_id: userInfo.userId,
        current_password: currentPw,
        new_password: newPw,
      });
      const ok = response.data.status === "success";
      setPwMessage({ ok, text: response.data.message });
      if (ok) {
        setCurrentPw("");
        setNewPw("");
        setConfirmPw("");
      }
    } catch (e) {
      console.error("error : ", e);
      setPwMessage({ ok: false, text: "비밀번호 변경 중 오류가 발생했습니다." });
    } finally {
      setPwSaving(false);
    }
  }

  function closeWithdraw() {
    if (withdrawing) return;
    setWithdrawOpen(false);
    setWithdrawPw("");
    setWithdrawError("");
  }

  async function withdraw(e: React.FormEvent) {
    e.preventDefault();
    if (!userInfo) return;
    if (!withdrawPw) {
      setWithdrawError("비밀번호를 입력해주세요.");
      return;
    }

    setWithdrawing(true);
    try {
      const response = await axios.post(`${API_BASE_URL}/user/delUser`, {
        users_id: userInfo.userId,
        password: withdrawPw,
      });
      if (response.data.status !== "success") {
        setWithdrawError(response.data.message);
        setWithdrawing(false);
        return;
      }
      useUserStore.getState().reset();
      alert(response.data.message);
      navigate("/login", { replace: true });
    } catch (e) {
      console.error("error : ", e);
      setWithdrawError("탈퇴 처리 중 오류가 발생했습니다.");
      setWithdrawing(false);
    }
  }

  const repoUrl = userInfo
    ? `http://${window.location.hostname}:8080/git/${userInfo.team_id}/${userInfo.userId}.git`
    : "";
  const repoPath = userInfo ? `/repos/${userInfo.team_id}/${userInfo.userId}.git` : "";
  const data = load.status === "success" ? load.data : null;

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
            className={`nav-item`}
            onClick={() => navigate("/logs")}
          >
            로그 조회
          </button>
          <button
            key={"setting"}
            className={`nav-item active`}
            aria-current="page"
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
        <div className="page">
          <div className="page-head">
            <h1 className="page-title">설정</h1>
          </div>

          {load.status === "error" && <p className="settings-error">{load.message}</p>}

          {/* ── 섹션 1: 계정 ── */}
          <section className="dash-card">
            <div className="section-header">
              <span className="section-title">계정</span>
            </div>
            <dl className="settings-info">
              <dt>아이디</dt>
              <dd>{userInfo?.userId ?? "-"}</dd>
              <dt>팀</dt>
              <dd>{data?.team_id ?? userInfo?.team_id ?? "-"}</dd>
              <dt>가입일</dt>
              <dd>{data ? formatDate(data.created_at) : "-"}</dd>
            </dl>

            <form className="settings-form" onSubmit={changePassword}>
              <div className="settings-subtitle">비밀번호 변경</div>
              <input
                type="password"
                className="settings-input"
                placeholder="현재 비밀번호"
                autoComplete="current-password"
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
              />
              <input
                type="password"
                className="settings-input"
                placeholder="새 비밀번호"
                autoComplete="new-password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
              />
              <input
                type="password"
                className="settings-input"
                placeholder="새 비밀번호 확인"
                autoComplete="new-password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
              />
              <p className="dash-muted">변경하면 서버 git push · clone 비밀번호도 함께 바뀝니다.</p>
              {pwMessage && (
                <p className={pwMessage.ok ? "settings-ok" : "settings-error"}>{pwMessage.text}</p>
              )}
              <div>
                <button type="submit" className="btn-primary" disabled={pwSaving}>
                  {pwSaving ? "변경 중..." : "비밀번호 변경"}
                </button>
              </div>
            </form>
          </section>

          {/* ── 섹션 2: 저장소 ── */}
          <section className="dash-card">
            <div className="section-header">
              <span className="section-title">저장소</span>
            </div>
            <div className="settings-label">Clone URL</div>
            <div className="settings-copy-row">
              <code className="settings-code">{repoUrl}</code>
              <button
                className="btn-secondary"
                onClick={() =>
                  copyText(repoUrl)
                    .then(() => showToast("URL이 복사되었습니다."))
                    .catch(() => showToast("복사하지 못했습니다."))
                }
              >
                URL 복사
              </button>
            </div>
            <div className="settings-label">저장소 경로</div>
            <code className="settings-code">{repoPath}</code>
          </section>

          {/* ── 섹션 3: 내 활동 ── */}
          <section className="dash-card">
            <div className="section-header">
              <span className="section-title">내 활동</span>
            </div>
            <div className="settings-stats">
              <div>
                <div className="settings-stat-value">{data ? data.build_count : "-"}</div>
                <div className="dash-muted">총 빌드 횟수</div>
              </div>
              <div>
                <div className="settings-stat-value">{data ? data.ai_count : "-"}</div>
                <div className="dash-muted">AI 분석 요청 횟수</div>
              </div>
            </div>
          </section>

          {/* ── 섹션 4: 팀원 ── */}
          <section className="dash-card">
            <div className="section-header">
              <span className="section-title">팀원</span>
              {data && <span className="dash-muted">{data.teammates.length}명</span>}
            </div>
            {data ? (
              <ul className="settings-members">
                {data.teammates.map((id) => (
                  <li key={id}>
                    {id}
                    {id === userInfo?.userId && <span className="dash-muted"> (나)</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="dash-empty">{load.status === "loading" ? "불러오는 중..." : "-"}</p>
            )}
          </section>

          <hr className="settings-divider" />

          {/* ── 위험 영역 ── */}
          <section className="danger-zone">
            <div className="section-header">
              <span className="section-title danger-title">위험 영역</span>
            </div>
            <div className="danger-row">
              <div>
                <div className="settings-subtitle">회원 탈퇴</div>
                <p className="dash-muted">계정, 저장소, 로그 파일이 모두 삭제되며 되돌릴 수 없습니다.</p>
              </div>
              <button className="btn-danger" onClick={() => setWithdrawOpen(true)}>
                회원 탈퇴
              </button>
            </div>
          </section>
        </div>
      </div>

      {withdrawOpen && (
        <div className="modal-backdrop" onClick={closeWithdraw}>
          <form className="modal danger-modal" onSubmit={withdraw} onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">정말 탈퇴하시겠습니까?</div>
            <p className="modal-text">모든 데이터가 삭제됩니다.</p>
            <input
              type="password"
              className="settings-input"
              placeholder="비밀번호"
              autoComplete="current-password"
              autoFocus
              value={withdrawPw}
              onChange={(e) => setWithdrawPw(e.target.value)}
            />
            {withdrawError && <p className="settings-error">{withdrawError}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={closeWithdraw} disabled={withdrawing}>
                취소
              </button>
              <button type="submit" className="btn-danger" disabled={withdrawing}>
                {withdrawing ? "탈퇴 중..." : "탈퇴"}
              </button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
};

export default Settings;
