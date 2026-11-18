'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { STATUSES, type Status } from './statuses';

type Grade = 'A' | 'B' | 'C' | 'D';
type Job = {
  rank: number;
  company: string;
  title: string;
  url: string;
  score: number;
  grade: Grade;
  reason: string;
  missing_keywords: string[];
  breakdown?: Record<string, number>;
  location?: string;
  deadline?: string;
  career?: string;
  education?: string;
  employment?: string;
  salary?: string;
  closed?: boolean;
};
type StatusFile = { updatedAt: string | null; statuses: Record<string, Status> };
type TaskState = {
  running: boolean;
  kind?: 'refresh' | 'resume';
  startedAt?: number;
  phase?: string;
  error?: string;
  result?: { added: number; closed: number; reevaluated: number; pending: number; failed: number };
};
type ResumeInfo = { name: string; size: number; uploadedAt: string; appliedAt?: string };
const MAX_PDF = 10 * 1024 * 1024;
const formatSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
const formatDate = (iso: string) =>
  new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// 작업 결과 한 줄 요약. 새로 고침과 이력서 반영이 같은 작업 상태를 쓴다.
function taskMessage(t: TaskState) {
  const name = t.kind === 'resume' ? '이력서 반영' : '공고 새로 고침';
  if (t.running) return null;
  if (t.error) return `${name} 실패: ${t.error}`;
  if (!t.result) return null;
  const r = t.result;
  return (
    `${name} 완료: ` +
    (t.kind === 'resume' ? `공고 ${r.reevaluated}건 다시 평가, ` : '') +
    `신규 ${r.added}건 추가, 마감 ${r.closed}건 정리` +
    (r.pending ? `, 평가 대기 ${r.pending}건(다음 새로 고침 때 평가)` : '') +
    (r.failed ? `, 평가 실패 ${r.failed}건` : '') +
    '.'
  );
}

const GRADES: Grade[] = ['A', 'B', 'C', 'D'];
const SORTS = { score: '점수순', company: '회사순', latest: '최신순' } as const;
type Sort = keyof typeof SORTS;
const FACTS = [
  ['location', '근무지'],
  ['deadline', '마감'],
  ['career', '경력'],
  ['education', '학력'],
  ['employment', '고용 형태'],
  ['salary', '급여'],
] as const;
const BREAKDOWN = [
  ['job_fit', '직무 적합도 ×3'],
  ['tech_stack', '기술 스택 ×2'],
  ['experience', '경력 ×1'],
  ['conditions', '근무 조건 ×1'],
  ['growth', '성장성 ×1'],
] as const;
const LS_KEY = 'job-dashboard:status';

// 사람인 공고 번호(rec_idx). 등록 순서대로 커지므로 최신순의 기준으로 쓰고, 심층 조사 주소에도 쓴다.
const postingId = (job: Job) => Number(/rec_idx=(\d+)/.exec(job.url)?.[1] ?? 0);
const companyKey = (name: string) => name.replace(/\(주\)|㈜|주식회사/g, '').trim();

function useStatuses() {
  const [file, setFile] = useState<StatusFile>({ updatedAt: null, statuses: {} });
  const [savedTo, setSavedTo] = useState<'file' | 'browser' | null>(null);
  const latest = useRef(file);

  const push = async (next: StatusFile) => {
    const ok = await fetch('/data/status.json', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    }).then((r) => r.ok, () => false);
    setSavedTo(ok ? 'file' : 'browser');
  };

  useEffect(() => {
    (async () => {
      let local: StatusFile | null = null;
      try {
        local = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null');
      } catch {}
      const server: StatusFile | null = await fetch('/data/status.json', { cache: 'no-store' }).then(
        (r) => (r.ok ? r.json() : null),
        () => null,
      );
      // 파일이 기준이다. 브라우저 백업이 더 최신이면(이전 저장이 파일에 닿지 못한 경우) 백업을 쓰고 파일에 다시 저장한다.
      const useLocal = local !== null && (!server || (local.updatedAt ?? '') > (server.updatedAt ?? ''));
      const current = useLocal ? local : server;
      if (!current) return;
      latest.current = current;
      setFile(current);
      if (useLocal) void push(current);
    })();
  }, []);

  const setStatus = (url: string, status: Status) => {
    const statuses = { ...latest.current.statuses, [url]: status };
    if (status === STATUSES[0]) delete statuses[url];
    const next = { updatedAt: new Date().toISOString(), statuses };
    latest.current = next;
    setFile(next);
    localStorage.setItem(LS_KEY, JSON.stringify(next));
    void push(next);
  };

  return { statuses: file.statuses, setStatus, savedTo };
}

// 마감일 문자열("~ 11/21(토)", "오늘마감(11/15)", "상시채용", "채용시")을 남은 일수로 바꾼다.
// 연도는 적혀 있지 않으므로 올해로 보고, 반년 넘게 지난 날짜면 내년으로 본다.
function daysLeft(deadline?: string) {
  const m = /(\d{1,2})\/(\d{1,2})/.exec(deadline ?? '');
  if (!m) return /오늘/.test(deadline ?? '') ? 0 : null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(today.getFullYear(), Number(m[1]) - 1, Number(m[2]));
  let days = Math.round((due.getTime() - today.getTime()) / 864e5);
  if (days < -180) days = Math.round((new Date(due.getFullYear() + 1, due.getMonth(), due.getDate()).getTime() - today.getTime()) / 864e5);
  return days;
}

// 10일 이상 초록, 5일 이하 노랑, 2일 이하 빨강. 6~9일은 색 없이 남은 일수만 보여 준다. 색만으로 구분하지 않도록 글자도 함께 쓴다.
function Deadline({ job }: { job: Job }) {
  const days = daysLeft(job.deadline);
  if (days === null) return job.deadline ? <span className="due due-none" title={job.deadline}>상시</span> : null;
  const tone = days < 0 ? 'past' : days <= 2 ? 'red' : days <= 5 ? 'yellow' : days >= 10 ? 'green' : 'none';
  const label = days < 0 ? '마감' : days === 0 ? '오늘 마감' : `D-${days}`;
  return (
    <span className={`due due-${tone}`} title={`마감 ${job.deadline}`}>
      {label}
    </span>
  );
}

function Reason({ job }: { job: Job }) {
  return (
    <details className="reason">
      <summary>
        <span className="reason-text">{job.reason}</span>
        <span className="link when-closed">상세보기</span>
        <span className="link when-open">접기</span>
      </summary>
      <dl className="facts">
        {FACTS.map(([key, label]) =>
          job[key] ? (
            <Fragment key={key}>
              <dt>{label}</dt>
              <dd>{job[key]}</dd>
            </Fragment>
          ) : null,
        )}
        {BREAKDOWN.map(([key, label]) =>
          job.breakdown?.[key] !== undefined ? (
            <Fragment key={key}>
              <dt>{label}</dt>
              <dd>{job.breakdown[key]} / 5</dd>
            </Fragment>
          ) : null,
        )}
      </dl>
    </details>
  );
}

function Keywords({ job }: { job: Job }) {
  if (!job.missing_keywords.length) return <p className="muted">없음</p>;
  return (
    <ul className="keywords">
      {job.missing_keywords.map((k) => (
        <li key={k}>{k}</li>
      ))}
    </ul>
  );
}

export default function Page() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<'card' | 'table'>('card');
  const [sort, setSort] = useState<Sort>('score');
  const [grades, setGrades] = useState<Grade[]>([]);
  const [query, setQuery] = useState('');
  const { statuses, setStatus, savedTo } = useStatuses();

  const [task, setTask] = useState<TaskState>({ running: false });
  const [resume, setResume] = useState<ResumeInfo | null>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);

  const loadJobs = () =>
    fetch('/data/ranked-jobs.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setJobs, (e) => setError(String(e?.message ?? e)));

  const loadResume = () =>
    fetch('/resume', { cache: 'no-store' })
      .then((r) => r.json())
      .then(
        (d: { resume: ResumeInfo | null }) => setResume(d.resume),
        () => {},
      );

  // 작업(새로 고침, 이력서 반영)이 끝날 때까지 3초마다 상태를 확인하고, 끝나면 공고 목록과 이력서 정보를 다시 읽는다.
  const pollTask = async () => {
    const next: TaskState = await fetch('/refresh', { cache: 'no-store' }).then(
      (r) => r.json(),
      () => ({ running: false, error: '서버에 연결하지 못했습니다' }),
    );
    setTask(next);
    if (next.running) setTimeout(pollTask, 3000);
    else if (next.result) {
      void loadJobs();
      void loadResume();
    }
  };

  const startRefresh = async () => {
    const next: TaskState = await fetch('/refresh', { method: 'POST' }).then(
      (r) => r.json(),
      () => ({ running: false, error: '서버에 연결하지 못했습니다' }),
    );
    setTask(next);
    if (next.running) setTimeout(pollTask, 3000);
  };

  // 끌어다 놓기와 "PC에서 찾기"가 함께 쓰는 파일 확인.
  const pickFile = (file?: File | null) => {
    setUploadError('');
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return setUploadError('PDF 파일만 넣을 수 있습니다.');
    if (file.size > MAX_PDF) return setUploadError('PDF는 10MB 이하만 넣을 수 있습니다.');
    setPicked(file);
  };

  const saveResume = async () => {
    if (!picked) return;
    const form = new FormData();
    form.append('file', picked);
    const res = await fetch('/resume', { method: 'POST', body: form }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) return setUploadError(body.error ?? '저장하지 못했습니다. 서버가 켜져 있는지 확인하세요.');
    setResume(body.resume);
    setTask(body.task);
    setPicked(null);
    setTimeout(pollTask, 3000);
  };

  useEffect(() => {
    void loadJobs();
    void loadResume();
    // 페이지를 다시 열었을 때 진행 중인 작업이 있으면 이어서 보여 준다.
    fetch('/refresh', { cache: 'no-store' })
      .then((r) => r.json())
      .then(
        (t: TaskState) => {
          if (!t.running) return;
          setTask(t);
          setTimeout(pollTask, 3000);
        },
        () => {},
      );
  }, []);

  // 마감된 공고는 지원 상태가 "미지원"이면 숨기고, 지원 기록이 있으면 계속 보여 준다.
  const active = useMemo(
    () => (jobs ?? []).filter((j) => !j.closed || (statuses[j.url] ?? STATUSES[0]) !== STATUSES[0]),
    [jobs, statuses],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return active
      .filter((j) => !grades.length || grades.includes(j.grade))
      .filter(
        (j) =>
          !q ||
          [j.company, j.title, j.reason, j.location, ...j.missing_keywords].join(' ').toLowerCase().includes(q),
      )
      .sort((a, b) =>
        sort === 'company'
          ? companyKey(a.company).localeCompare(companyKey(b.company), 'ko')
          : sort === 'latest'
            ? postingId(b) - postingId(a)
            : b.score - a.score,
      );
  }, [active, grades, query, sort]);

  const total = active.length;
  const average = total ? (active.reduce((sum, j) => sum + j.score, 0) / total).toFixed(1) : '–';
  const elapsed = task.startedAt ? Math.max(0, Math.round((Date.now() - task.startedAt) / 1000)) : 0;
  const progress = task.running
    ? `${task.kind === 'resume' ? '이력서 반영' : '공고 새로 고침'}: ${task.phase ?? ''} (경과 ${Math.floor(elapsed / 60)}분 ${elapsed % 60}초)`
    : taskMessage(task);

  const gradeBadge = (job: Job) => <span className={`grade grade-${job.grade}`}>{job.grade}</span>;
  const statusSelect = (job: Job) => (
    <select
      className="chip"
      aria-label={`${job.company} 지원 상태`}
      data-status={statuses[job.url] ?? STATUSES[0]}
      value={statuses[job.url] ?? STATUSES[0]}
      onChange={(e) => setStatus(job.url, e.target.value as Status)}
    >
      {STATUSES.map((s) => (
        <option key={s}>{s}</option>
      ))}
    </select>
  );
  const sourceLink = (job: Job) => (
    <a className="link" href={job.url} target="_blank" rel="noreferrer">
      원본 공고 ↗
    </a>
  );
  // 누르면 서버가 작업을 시작하고 결과 화면으로 보낸다. 이미 결과가 있으면 바로 보여 준다.
  const workButtons = (job: Job) => (
    <>
      <form method="post" action={`/work/deep/${postingId(job)}`}>
        <button className="button-primary">심층 조사</button>
      </form>
      <form method="post" action={`/work/cover/${postingId(job)}`}>
        <button className="button-secondary">자소서 초안</button>
      </form>
    </>
  );

  return (
    <>
      <header className="global-nav">
        <div className="nav-actions">
          <span>취업 상황판</span>
          <button className="nav-button" onClick={() => dialogRef.current?.showModal()}>
            이력서 넣기
          </button>
        </div>
        <div className="nav-actions">
          <button className="nav-button" onClick={startRefresh} disabled={task.running}>
            {task.running && task.kind === 'refresh' ? '새로 고치는 중…' : '공고 새로 고침'}
          </button>
          <a href="#jobs">공고</a>
        </div>
      </header>

      <section className="tile-dark">
        <h1>취업 상황판</h1>
        <p className="lead">사람인 공고를 이력서 기준으로 평가한 결과</p>
        <p className="resume-line">
          기준 이력서:{' '}
          {resume
            ? `${resume.name} (${formatDate(resume.appliedAt ?? resume.uploadedAt)}${resume.appliedAt ? '' : ', 반영 전'})`
            : '처음 만든 cv.md'}
        </p>
        <dl className="stats">
          <div>
            <dt>총 공고</dt>
            <dd>{total}</dd>
          </div>
          {GRADES.map((g) => (
            <div key={g}>
              <dt>{g}등급</dt>
              <dd>{active.filter((j) => j.grade === g).length}</dd>
            </div>
          ))}
          <div>
            <dt>평균 점수</dt>
            <dd>{average}</dd>
          </div>
        </dl>
      </section>

      <main id="jobs">
        <div className="toolbar">
          <h2>
            공고{' '}
            <span className="muted">
              {shown.length} / {total}
            </span>
          </h2>
          <input
            type="search"
            aria-label="키워드 검색"
            placeholder="회사, 직무, 키워드 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="chips" role="group" aria-label="등급 필터">
            {GRADES.map((g) => (
              <button
                key={g}
                className="chip"
                aria-pressed={grades.includes(g)}
                onClick={() => setGrades(grades.includes(g) ? grades.filter((x) => x !== g) : [...grades, g])}
              >
                {g}
              </button>
            ))}
          </div>
          <select className="chip" aria-label="정렬" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {Object.entries(SORTS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <div className="chips" role="group" aria-label="보기 방식">
            <button className="chip" aria-pressed={view === 'card'} onClick={() => setView('card')}>
              카드
            </button>
            <button className="chip" aria-pressed={view === 'table'} onClick={() => setView('table')}>
              테이블
            </button>
          </div>
        </div>

        <p className="note" role="status">
          {savedTo === 'file' && '지원 상태를 data/status.json에 저장했습니다.'}
          {savedTo === 'browser' && '파일에 저장하지 못해 브라우저에만 백업했습니다.'}
        </p>
        <p className="note" role="status">
          {progress}
        </p>

        {error ? (
          <p className="note">data/ranked-jobs.json을 불러오지 못했습니다 ({error}).</p>
        ) : !jobs ? (
          <p className="note">불러오는 중…</p>
        ) : !shown.length ? (
          <p className="note">조건에 맞는 공고가 없습니다.</p>
        ) : view === 'card' ? (
          <ul className="cards">
            {shown.map((job) => (
              <li key={job.url} className="card">
                <div className="card-head">
                  {gradeBadge(job)}
                  <strong className="score">{job.score.toFixed(1)}</strong>
                  <span className="muted">점</span>
                  <Deadline job={job} />
                  <span className="muted rank">#{job.rank}</span>
                </div>
                <p className="company">{job.company}</p>
                <h3>{job.title}</h3>
                <Reason job={job} />
                <p className="label">부족 키워드</p>
                <Keywords job={job} />
                <div className="card-foot">
                  {statusSelect(job)}
                  {workButtons(job)}
                  {sourceLink(job)}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>회사 · 직무</th>
                  <th>등급</th>
                  <th>점수</th>
                  <th>매칭 이유</th>
                  <th>부족 키워드</th>
                  <th>지원 상태</th>
                  <th>조사 · 자소서 · 원본</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((job) => (
                  <tr key={job.url}>
                    <td>
                      <p className="company">{job.company}</p>
                      <strong>{job.title}</strong>
                    </td>
                    <td>{gradeBadge(job)}</td>
                    <td className="score-cell">
                      {job.score.toFixed(1)} <Deadline job={job} />
                    </td>
                    <td className="reason-cell">
                      <Reason job={job} />
                    </td>
                    <td className="keywords-cell">
                      <Keywords job={job} />
                    </td>
                    <td>{statusSelect(job)}</td>
                    <td className="actions-cell">
                      {workButtons(job)}
                      {sourceLink(job)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      <dialog ref={dialogRef} className="resume-dialog" onClose={() => setUploadError('')}>
        <h2>이력서 넣기</h2>
        <p className="note">
          현재 기준 이력서:{' '}
          {resume ? `${resume.name} · ${formatSize(resume.size)} · ${formatDate(resume.uploadedAt)}` : '처음 만든 cv.md'}
        </p>
        <div
          className={`drop${dragging ? ' drop-active' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pickFile(e.dataTransfer.files[0]);
          }}
        >
          <p>PDF를 여기에 끌어다 놓으세요</p>
          <label className="button-secondary">
            PC에서 찾기
            <input type="file" accept="application/pdf,.pdf" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
          </label>
          {picked && (
            <p className="picked">
              {picked.name} · {formatSize(picked.size)}
            </p>
          )}
        </div>
        <p className="note">
          저장하면 이력서를 읽어 이력서·프로필·검색 조건을 새로 만들고, 그에 맞는 공고를 다시 모아 모두 다시 평가합니다. 15~20분
          걸리고 Claude 사용량을 씁니다. 기존 이력서와 공고 점수는 백업됩니다. 기존 심층 조사·자소서는 이전 이력서 기준이니 필요하면
          다시 만드세요.
        </p>
        {uploadError && (
          <p className="note" role="alert">
            {uploadError}
          </p>
        )}
        {task.running && <p className="note">{progress}</p>}
        <div className="report-actions">
          <button className="button-primary" disabled={!picked || task.running} onClick={saveResume}>
            저장하고 공고 적용
          </button>
          <button className="button-secondary" onClick={() => dialogRef.current?.close()}>
            닫기
          </button>
        </div>
      </dialog>

      <footer>공고 data/ranked-jobs.json · 지원 상태 data/status.json</footer>
    </>
  );
}
