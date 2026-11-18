import { execFile } from 'node:child_process';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { htmlToText, runClaude } from './server';

// 공고 목록 갱신(새로 고침, 이력서 반영)이 함께 쓰는 수집·마감 확인·평가·순위 계산.
export const ROOT = process.env.CAREER_OPS_ROOT ?? path.join(/*turbopackIgnore: true*/ process.cwd(), '..');
export const DATA = path.join(/*turbopackIgnore: true*/ ROOT, 'data');
export const JOBS_FILE = path.join(/*turbopackIgnore: true*/ DATA, 'saramin-jobs.json');
export const SEARCH_FILE = path.join(/*turbopackIgnore: true*/ DATA, 'search.json');
const MAX_NEW = 20; // 한 번에 평가하는 신규 공고 상한. 나머지는 다음 새로 고침 때 평가한다.
const MAX_EVAL = 80; // 이력서 반영 때 한 번에 평가하는 공고 상한(기존 + 신규)
const BATCH = 20; // Claude 한 번에 보내는 공고 수

// 사람인 지역 코드. 2026-11 실제 검색 결과로 확인했다(103000·112000은 둘 다 "전남광주"로 나온다).
export const REGION_CODES: Record<string, string> = {
  서울: '101000', 경기: '102000', 광주: '103000', 대구: '104000', 대전: '105000', 부산: '106000',
  울산: '107000', 인천: '108000', 강원: '109000', 경남: '110000', 경북: '111000', 전남: '112000',
  전북: '113000', 충북: '114000', 충남: '115000', 제주: '116000', 세종: '118000',
};

export type Search = { word: string; loc: string; career?: '신입' | '경력' };
// data/search.json이 없을 때 쓰는 처음 수집 조건.
const DEFAULT_SEARCHES: Search[] = [
  { word: 'Java Spring 백엔드', loc: '101000,102000,108000', career: '신입' },
  { word: 'Java 웹개발', loc: '108000', career: '신입' },
  { word: '전자정부프레임워크 SI SM 신입', loc: '101000,102000,108000', career: '신입' },
];

type Listing = { id: string; title: string; company: string; deadline: string; cond: string[]; tags: string[] };
type Job = Record<string, unknown> & { id: string; deadline?: string; closed?: boolean };
export type Result = {
  added: number;
  closed: number;
  reevaluated: number;
  pending: number;
  failed: number;
  finishedAt: string;
};
export type Task = {
  running: boolean;
  kind?: 'refresh' | 'resume';
  startedAt?: number;
  phase?: string;
  result?: Result;
  error?: string;
};

// ponytail: 진행 상태는 서버 메모리에만 둔다. 서버를 재시작하면 진행 중이던 작업은 잊히고 다시 눌러야 한다.
// 새로 고침과 이력서 반영은 같은 파일을 고치므로 한 번에 하나만 돌린다.
export const task = ((globalThis as { __jobTask?: Task }).__jobTask ??= { running: false });

export function startTask(kind: NonNullable<Task['kind']>, run: () => Promise<Result>) {
  if (task.running) return false;
  Object.assign(task, { running: true, kind, startedAt: Date.now(), phase: '시작 중', result: undefined, error: undefined });
  run()
    .then((result) => (task.result = result))
    .catch((e) => (task.error = String(e?.message ?? e)))
    .finally(() => {
      task.running = false;
      task.phase = undefined;
    });
  return true;
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
const plain = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function parseSearch(html: string): Listing[] {
  return html
    .split('<div class="item_recruit"')
    .slice(1)
    .map((block) => {
      const condHtml = /class="job_condition">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '';
      const sectorHtml = /class="job_sector">([\s\S]*?)(?:<span class="job_day"|<\/div>)/.exec(block)?.[1] ?? '';
      return {
        id: /value="(\d+)"/.exec(block)?.[1] ?? '',
        title: decode(/class="job_tit"[\s\S]*?title="([^"]*)"/.exec(block)?.[1] ?? '').trim(),
        company: plain(/class="corp_name">([\s\S]*?)<\/strong>/.exec(block)?.[1] ?? ''),
        deadline: plain(/<span class="date">([\s\S]*?)<\/span>/.exec(block)?.[1] ?? ''),
        cond: [...condHtml.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) => plain(m[1])).filter(Boolean),
        tags: [...sectorHtml.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)].map((m) => plain(m[1])).filter(Boolean),
      };
    })
    .filter((l) => l.id && l.title);
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

// 화면의 마감 뱃지와 같은 규칙: "~ 11/21(토)" 같은 월/일을 남은 일수로. 날짜가 없으면(상시·채용시) null.
function daysLeft(deadline?: string) {
  const m = /(\d{1,2})\/(\d{1,2})/.exec(deadline ?? '');
  if (!m) return null;
  const today = startOfToday();
  let due = new Date(today.getFullYear(), Number(m[1]) - 1, Number(m[2]));
  if ((due.getTime() - today.getTime()) / 864e5 < -180) due = new Date(due.getFullYear() + 1, due.getMonth(), due.getDate());
  return Math.round((due.getTime() - today.getTime()) / 864e5);
}

const get = (url: string) =>
  fetch(url).then(
    (r) => (r.ok ? r.text() : null),
    () => null,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 상시 공고가 검색 결과에서 빠졌을 때만 쓴다. 공고 페이지 설명 메타의 "마감일:2026-11-15"(연도 포함)를 읽는다.
// 페이지를 못 받으면 판단하지 않고 그대로 둔다. 페이지는 받았는데 공고 정보가 없으면 내려간 공고로 본다.
async function postingClosed(id: string): Promise<boolean | null> {
  const html = await get(`https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=${id}`);
  if (html === null) return null;
  const due = /마감일:(\d{4})-(\d{2})-(\d{2})/.exec(html);
  if (due) return new Date(Number(due[1]), Number(due[2]) - 1, Number(due[3])) < startOfToday();
  return !/마감일:/.test(html);
}

const half = (x: unknown) => Math.min(5, Math.max(0, Math.round(Number(x) * 2) / 2));
const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []);

export async function loadSearches(): Promise<Search[]> {
  const saved = await readFile(SEARCH_FILE, 'utf8').then(
    (t) => JSON.parse(t) as Search[],
    () => null,
  );
  return Array.isArray(saved) && saved.length ? saved : DEFAULT_SEARCHES;
}

function searchUrl({ word, loc, career }: Search) {
  const exp = career === '경력' ? '' : '&exp_cd=1&exp_none=y'; // 신입이면 신입·경력무관만, 경력이면 경력 조건 없이
  const area = loc ? `&loc_mcd=${encodeURIComponent(loc)}` : '';
  return `https://www.saramin.co.kr/zf_user/search/recruit?searchType=search&recruitPageCount=40&recruitSort=relation${exp}&searchword=${encodeURIComponent(word)}${area}`;
}

type Target = { listing: Listing; job?: Job };

// 공고를 Claude에 BATCH건씩 보내 평가한다. 결과가 없는 공고는 빠진 채로 돌려준다.
async function evaluate(targets: Target[], examples: unknown[], onProgress: (done: number) => void) {
  const template = await readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), 'refresh.prompt.md'), 'utf8');
  const results = new Map<string, Record<string, unknown>>();
  const bodies = new Map<string, string>();
  for (let i = 0; i < targets.length; i += BATCH) {
    onProgress(i);
    const chunk = targets.slice(i, i + BATCH);
    for (const { listing } of chunk) {
      const html = await get(`https://www.saramin.co.kr/zf_user/jobs/relay/view-detail?rec_idx=${listing.id}`);
      bodies.set(listing.id, html ? htmlToText(html) : '');
      await sleep(250);
    }
    const postings = chunk.map(({ listing: l, job }) => {
      const body = bodies.get(l.id) ?? '';
      return {
        id: l.id,
        company: l.company,
        title: l.title,
        deadline: l.deadline,
        conditions: l.cond.join(' | '),
        tags: l.tags.join(', '),
        body: body.slice(0, 2500),
        // 본문이 이미지인 공고는 텍스트를 받을 수 없으므로, 전에 공고를 읽고 정리한 요건(점수가 아닌 공고 사실)을 함께 넘긴다.
        ...(body.length < 300 && job && (strings(job.req).length || strings(job.pref).length)
          ? { known_requirements: { required: strings(job.req), preferred: strings(job.pref) } }
          : {}),
      };
    });
    const prompt = template
      .replace(
        '{{examples}}',
        examples.length
          ? JSON.stringify(examples, null, 2)
          : '(예시 없음. 새 이력서 기준의 첫 평가라 예전 점수를 기준으로 삼지 않는다.)',
      )
      .replace('{{postings}}', JSON.stringify(postings, null, 2));
    const out = await runClaude(prompt, ['Read', 'Glob', 'Grep'], ROOT);
    const parsed: unknown = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
    for (const e of Array.isArray(parsed) ? parsed : []) {
      if (e && typeof e === 'object' && typeof e.reason === 'string' && e.reason.trim()) results.set(String(e.id), e);
    }
  }
  return { results, bodies };
}

const scoreFields = (e: Record<string, unknown>) => ({
  req: strings(e.req),
  pref: strings(e.pref),
  fit: half(e.fit),
  experience: half(e.experience),
  conditions: half(e.conditions),
  growth: half(e.growth),
  reason: String(e.reason).trim(),
  extra_missing: strings(e.extra_missing),
});

// 마감이 지난 공고와 상시 공고만 다시 확인하고, 검색 결과의 신규 공고를 평가해 추가한다.
// reevaluateAll이면(이력서를 바꿨을 때) 진행 중인 기존 공고도 모두 다시 평가한다. 아니면 기존 점수는 바꾸지 않는다.
export async function updateJobs({ reevaluateAll, step, total }: { reevaluateAll: boolean; step: number; total: number }) {
  const phase = (i: number, label: string) => (task.phase = `${label} (${step + i}/${total})`);

  phase(0, '공고 수집 중');
  const found = new Map<string, Listing>();
  for (const search of await loadSearches()) {
    const html = await get(searchUrl(search));
    if (html) for (const l of parseSearch(html)) if (!found.has(l.id)) found.set(l.id, l);
    await sleep(300);
  }
  if (!found.size) throw new Error('사람인 검색 결과를 가져오지 못했습니다. 네트워크나 사람인 페이지 구조를 확인하세요.');

  const file = JSON.parse(await readFile(JOBS_FILE, 'utf8')) as { jobs: Job[] } & Record<string, unknown>;
  const known = new Set(file.jobs.map((j) => j.id));
  const today = startOfToday().toLocaleDateString('sv-SE');

  phase(1, '마감·상시 공고 확인 중');
  let closed = 0;
  for (const job of file.jobs) {
    if (job.closed) continue;
    const days = daysLeft(job.deadline);
    let isClosed = days !== null && days < 0;
    if (days === null && !found.has(job.id)) {
      isClosed = (await postingClosed(job.id)) === true;
      await sleep(250);
    }
    if (isClosed) {
      Object.assign(job, { closed: true, closed_at: today });
      closed++;
    }
  }

  // 평가 대상: (이력서 반영 때) 진행 중인 기존 공고 + 검색 결과에서 처음 보는 마감 전 공고.
  const fresh = [...found.values()].filter((l) => !known.has(l.id) && (daysLeft(l.deadline) ?? 0) >= 0);
  const existing: Target[] = reevaluateAll
    ? file.jobs
        .filter((j) => !j.closed)
        .map((j) => ({
          job: j,
          listing: {
            id: j.id,
            title: String(j.title ?? ''),
            company: String(j.company ?? ''),
            deadline: String(j.deadline ?? ''),
            cond: [j.location, j.career, j.education, j.employment].map((v) => String(v ?? '')).filter(Boolean),
            tags: [],
          },
        }))
    : [];
  const newTargets: Target[] = fresh
    .slice(0, reevaluateAll ? Math.max(0, MAX_EVAL - existing.length) : MAX_NEW)
    .map((l) => ({ listing: l }));
  const targets: Target[] = [...existing, ...newTargets];

  let added = 0;
  let reevaluated = 0;
  let failed = 0;
  if (targets.length) {
    const label = reevaluateAll ? `공고 ${targets.length}건 평가 중` : `신규 ${targets.length}건 평가 중`;
    phase(2, label);
    // 새로 고침 때는 기존 평가 중 직무 적합도가 높은 것·중간·낮은 것 세 건을 점수 기준 예시로 준다.
    const scored = file.jobs.filter((j) => !j.closed && typeof j.fit === 'number').sort((a, b) => Number(b.fit) - Number(a.fit));
    const examples = reevaluateAll
      ? []
      : [scored[0], scored[Math.floor(scored.length / 2)], scored[scored.length - 1]].filter(Boolean).map((j) => {
          const { company, title, req, pref, fit, experience, conditions, growth, reason, extra_missing } = j;
          return { company, title, req, pref, fit, experience, conditions, growth, reason, extra_missing };
        });
    const { results, bodies } = await evaluate(targets, examples, (done) =>
      phase(2, `${label}, ${Math.min(done + BATCH, targets.length)}/${targets.length}건째`),
    );

    for (const { listing: l, job } of targets) {
      const e = results.get(l.id);
      if (!e) {
        failed++; // 기존 공고는 예전 점수를 그대로 두고, 신규 공고는 다음 새로 고침 때 다시 시도한다.
        continue;
      }
      const body = bodies.get(l.id) ?? '';
      if (job) {
        // 이미지 공고는 작업자가 본문을 못 보므로, 전에 정리한 요건 키워드를 빈 값으로 덮어쓰지 않는다.
        const keepRequirements =
          body.length < 300 && (strings(job.req).length > 0 || strings(job.pref).length > 0) ? { req: job.req, pref: job.pref } : {};
        Object.assign(job, scoreFields(e), keepRequirements, { evaluated_at: today });
        reevaluated++;
      } else {
        file.jobs.push({
          id: l.id,
          company: l.company,
          title: l.title,
          deadline: l.deadline || '채용시',
          location: l.cond[0] ?? '',
          career: l.cond[1] ?? '',
          education: l.cond[2] ?? '',
          employment: l.cond[3] ?? '',
          salary: /급여\s*[:：]\s*([^\n]+)/.exec(body)?.[1]?.trim() ?? l.cond[4] ?? '공고 참고',
          jd_source: body.length > 300 ? 'text' : 'image-unread',
          ...scoreFields(e),
          added_at: today,
        });
        added++;
      }
    }
  }

  // 손으로 매긴 점수가 들어 있는 파일이라, 쓰기 전에 백업하고 임시 파일을 거쳐 교체한다.
  phase(3, '순위 계산 중');
  file.refreshed_at = today;
  await copyFile(JOBS_FILE, `${JOBS_FILE}.bak`);
  await writeFile(`${JOBS_FILE}.tmp`, JSON.stringify(file, null, 2) + '\n', 'utf8');
  await rename(`${JOBS_FILE}.tmp`, JOBS_FILE);
  await promisify(execFile)(process.execPath, [path.join(/*turbopackIgnore: true*/ DATA, 'rank-saramin.mjs')], {
    cwd: DATA,
    timeout: 60_000,
  });

  return {
    added,
    closed,
    reevaluated,
    pending: fresh.length - newTargets.length,
    failed,
    finishedAt: new Date().toISOString(),
  } satisfies Result;
}
