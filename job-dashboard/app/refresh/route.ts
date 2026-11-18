import { execFile } from 'node:child_process';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { htmlToText, runClaude } from '../lib/server';

export const dynamic = 'force-dynamic';

// 공고 새로 고침: 마감이 지난 공고와 상시 공고만 다시 확인하고, 사람인 검색 결과의 신규 공고를 평가해 추가한다.
// 마감일이 남은 기존 공고는 검색 결과에서 빠져도 그대로 두고, 기존 점수도 바꾸지 않는다.
const ROOT = process.env.CAREER_OPS_ROOT ?? path.join(/*turbopackIgnore: true*/ process.cwd(), '..');
const DATA = path.join(/*turbopackIgnore: true*/ ROOT, 'data');
const JOBS_FILE = path.join(/*turbopackIgnore: true*/ DATA, 'saramin-jobs.json');
const MAX_NEW = 20; // 한 번에 평가하는 신규 공고 상한. 나머지는 다음 새로 고침 때 평가한다.

// 처음 수집할 때 쓴 검색 조건과 같다: 신입·경력무관, 서울·경기·인천(인천 검색은 인천만).
const SEARCH_BASE =
  'https://www.saramin.co.kr/zf_user/search/recruit?searchType=search&exp_cd=1&exp_none=y&recruitPageCount=40&recruitSort=relation';
const SEARCHES = [
  { word: 'Java Spring 백엔드', loc: '101000,102000,108000' },
  { word: 'Java 웹개발', loc: '108000' },
  { word: '전자정부프레임워크 SI SM 신입', loc: '101000,102000,108000' },
];

type Listing = { id: string; title: string; company: string; deadline: string; cond: string[]; tags: string[] };
type Job = Record<string, unknown> & { id: string; deadline?: string; closed?: boolean };
type Result = { added: number; closed: number; pending: number; failed: number; finishedAt: string };
type RefreshState = { running: boolean; startedAt?: number; phase?: string; result?: Result; error?: string };

// ponytail: 진행 상태는 서버 메모리에만 둔다. 서버를 재시작하면 진행 중이던 새로 고침은 잊히고 다시 눌러야 한다.
const state = ((globalThis as { __jobRefresh?: RefreshState }).__jobRefresh ??= { running: false });

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

async function refresh() {
  state.phase = '공고 수집 중 (1/4)';
  const found = new Map<string, Listing>();
  for (const { word, loc } of SEARCHES) {
    const html = await get(`${SEARCH_BASE}&searchword=${encodeURIComponent(word)}&loc_mcd=${encodeURIComponent(loc)}`);
    if (html) for (const l of parseSearch(html)) if (!found.has(l.id)) found.set(l.id, l);
    await sleep(300);
  }
  if (!found.size) throw new Error('사람인 검색 결과를 가져오지 못했습니다. 네트워크나 사람인 페이지 구조를 확인하세요.');

  const file = JSON.parse(await readFile(JOBS_FILE, 'utf8')) as { jobs: Job[] } & Record<string, unknown>;
  const known = new Set(file.jobs.map((j) => j.id));
  const today = startOfToday().toLocaleDateString('sv-SE');

  // 마감이 지난 공고와 상시 공고만 다시 확인한다.
  state.phase = '마감·상시 공고 확인 중 (2/4)';
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

  // 신규 공고: 검색 결과에서 처음 보는 공고 중 마감이 지나지 않은 것.
  const fresh = [...found.values()].filter((l) => !known.has(l.id) && (daysLeft(l.deadline) ?? 0) >= 0);
  const batch = fresh.slice(0, MAX_NEW);
  let added = 0;
  let failed = 0;

  if (batch.length) {
    state.phase = `신규 ${batch.length}건 평가 중 (3/4)`;
    const details = new Map<string, string>();
    for (const l of batch) {
      const html = await get(`https://www.saramin.co.kr/zf_user/jobs/relay/view-detail?rec_idx=${l.id}`);
      details.set(l.id, html ? htmlToText(html) : '');
      await sleep(250);
    }

    // 기존에 평가한 공고 중 직무 적합도가 높은 것, 중간, 낮은 것 세 건을 점수 기준 예시로 준다.
    const scored = file.jobs.filter((j) => !j.closed && typeof j.fit === 'number');
    const byFit = [...scored].sort((a, b) => Number(b.fit) - Number(a.fit));
    const examples = [byFit[0], byFit[Math.floor(byFit.length / 2)], byFit[byFit.length - 1]]
      .filter(Boolean)
      .map((j) => {
        const { company, title, req, pref, fit, experience, conditions, growth, reason, extra_missing } = j;
        return { company, title, req, pref, fit, experience, conditions, growth, reason, extra_missing };
      });
    const postings = batch.map((l) => ({
      id: l.id,
      company: l.company,
      title: l.title,
      deadline: l.deadline,
      conditions: l.cond.join(' | '),
      tags: l.tags.join(', '),
      body: (details.get(l.id) ?? '').slice(0, 2500),
    }));

    const template = await readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), 'refresh.prompt.md'), 'utf8');
    const prompt = template
      .replace('{{examples}}', JSON.stringify(examples, null, 2))
      .replace('{{postings}}', JSON.stringify(postings, null, 2));
    const out = await runClaude(prompt, ['Read', 'Glob', 'Grep'], ROOT);
    const parsed: unknown = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
    const evaluations = new Map(
      (Array.isArray(parsed) ? parsed : [])
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
        .map((e) => [String(e.id), e]),
    );

    for (const l of batch) {
      const e = evaluations.get(l.id);
      if (!e || typeof e.reason !== 'string' || !e.reason.trim()) {
        failed++;
        continue;
      }
      const body = details.get(l.id) ?? '';
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
        req: strings(e.req),
        pref: strings(e.pref),
        fit: half(e.fit),
        experience: half(e.experience),
        conditions: half(e.conditions),
        growth: half(e.growth),
        reason: e.reason.trim(),
        extra_missing: strings(e.extra_missing),
        added_at: today,
      });
      added++;
    }
  }

  // 손으로 매긴 기존 점수가 들어 있는 파일이라, 쓰기 전에 백업하고 임시 파일을 거쳐 교체한다.
  state.phase = '순위 계산 중 (4/4)';
  file.refreshed_at = today;
  await copyFile(JOBS_FILE, `${JOBS_FILE}.bak`);
  await writeFile(`${JOBS_FILE}.tmp`, JSON.stringify(file, null, 2) + '\n', 'utf8');
  await rename(`${JOBS_FILE}.tmp`, JOBS_FILE);
  await promisify(execFile)(process.execPath, [path.join(/*turbopackIgnore: true*/ DATA, 'rank-saramin.mjs')], {
    cwd: DATA,
    timeout: 60_000,
  });

  state.result = { added, closed, pending: fresh.length - batch.length, failed, finishedAt: new Date().toISOString() };
}

export async function GET() {
  return Response.json(state);
}

export async function POST(req: Request) {
  // 새로 고침 한 번이 Claude 사용량을 쓰므로 다른 사이트에서 보낸 요청은 받지 않는다.
  if (req.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ error: 'forbidden' }, { status: 403 });
  if (!state.running) {
    Object.assign(state, { running: true, startedAt: Date.now(), phase: '시작 중', result: undefined, error: undefined });
    refresh()
      .catch((e) => (state.error = String(e?.message ?? e)))
      .finally(() => {
        state.running = false;
        state.phase = undefined;
      });
  }
  return Response.json(state, { status: 202 });
}
