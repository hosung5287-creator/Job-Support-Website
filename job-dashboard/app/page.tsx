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
};
type StatusFile = { updatedAt: string | null; statuses: Record<string, Status> };

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

  useEffect(() => {
    fetch('/data/ranked-jobs.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setJobs, (e) => setError(String(e?.message ?? e)));
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (jobs ?? [])
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
  }, [jobs, grades, query, sort]);

  const total = jobs?.length ?? 0;
  const average = jobs?.length ? (jobs.reduce((sum, j) => sum + j.score, 0) / total).toFixed(1) : '–';

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
        <span>취업 상황판</span>
        <a href="#jobs">공고</a>
      </header>

      <section className="tile-dark">
        <h1>취업 상황판</h1>
        <p className="lead">사람인 공고를 이력서 기준으로 평가한 결과</p>
        <dl className="stats">
          <div>
            <dt>총 공고</dt>
            <dd>{total}</dd>
          </div>
          {GRADES.map((g) => (
            <div key={g}>
              <dt>{g}등급</dt>
              <dd>{jobs?.filter((j) => j.grade === g).length ?? 0}</dd>
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

      <footer>공고 data/ranked-jobs.json · 지원 상태 data/status.json</footer>
    </>
  );
}
