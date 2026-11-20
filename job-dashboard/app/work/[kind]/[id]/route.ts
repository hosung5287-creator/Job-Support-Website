import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { htmlToText, runClaude } from '../../../lib/server';

export const dynamic = 'force-dynamic';

// career-ops 루트(이 앱의 상위 폴더). cv.md, modes/, reports/, data/, output/이 여기에 있다.
const ROOT = process.env.CAREER_OPS_ROOT ?? path.join(/*turbopackIgnore: true*/ process.cwd(), '..');

// 작업 종류별 프롬프트 파일, 결과 폴더, 작업자에게 허용하는 도구.
// 도구 범위는 career-ops 웹 UI와 같다: deep은 읽기 + 웹 조회, cover는 읽기만.
const KINDS = {
  deep: {
    prompt: 'deep-research.prompt.md',
    dir: path.join(/*turbopackIgnore: true*/ ROOT, 'data', 'deep-research'),
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    pdf: false,
    review: null,
  },
  cover: {
    prompt: 'cover-letter.prompt.md',
    // 초안을 쓴 뒤 같은 도구 범위의 두 번째 작업자가 근거 확인과 작성 기준 점검을 거쳐 최종본을 낸다.
    review: 'cover-letter.review.prompt.md',
    dir: path.join(/*turbopackIgnore: true*/ ROOT, 'output', 'cover-letters'),
    tools: ['Read', 'Glob', 'Grep'],
    pdf: true,
  },
};
type Kind = keyof typeof KINDS;

// ponytail: 진행 상태는 서버 메모리에만 둔다. 서버를 재시작하면 진행 중이던 작업은 잊히고 다시 눌러야 한다.
// globalThis에 두는 이유는 개발 서버가 이 파일을 다시 컴파일해도 상태가 남게 하려는 것.
type WorkState = { running: Map<string, number>; failed: Map<string, string>; phase: Map<string, string> };
const state = ((globalThis as { __jobWorkState?: WorkState }).__jobWorkState ??= {
  running: new Map(),
  failed: new Map(),
  phase: new Map(),
});

type Ctx = { params: Promise<{ kind: string; id: string }> };
type Job = { company: string; title: string; url: string };

async function loadJd(id: string, url: string) {
  const html = await fetch(`https://www.saramin.co.kr/zf_user/jobs/relay/view-detail?rec_idx=${id}`).then(
    (r) => (r.ok ? r.text() : ''),
    () => '',
  );
  const text = htmlToText(html);
  if (text.length > 300) return text;
  // 본문이 이미지인 공고: 이전 평가 리포트에 보관해 둔 공고 원문이 있으면 그것을 쓴다.
  const reports = path.join(/*turbopackIgnore: true*/ ROOT, 'reports');
  for (const name of await readdir(reports).catch(() => [])) {
    if (!name.endsWith('.md')) continue;
    const report = await readFile(path.join(/*turbopackIgnore: true*/ reports, name), 'utf8');
    const start = report.indexOf('## Job Description');
    if (!report.includes(url) || start < 0) continue;
    const end = report.indexOf('## Machine Summary', start);
    return report.slice(start, end < 0 ? undefined : end);
  }
  return text || '(공고 본문을 불러오지 못했습니다. 본문이 이미지일 수 있습니다.)';
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 상투어 목록은 cover-letter.guide.md의 "쓰지 않는 말"과 같다. 찾은 것은 고치라는 뜻이 아니라 확인 대상이다.
const CLICHES = ['극대화', '체계적', '시너지', '기여', '함양', '고객 중심', '효율성', '최선을 다', '열정', '도약', '이바지'];

// 모델이 세지 못하는 것은 코드로 센다: 항목별 글자 수, 상투어, 근거 자료에 없는 숫자.
function autoCheck(markdown: string, sources: string) {
  const letter = markdown.split(/^## (?:검토 결과|제출 전 확인|자동 점검)/m)[0];
  const sections = letter
    .split(/^## /m)
    .slice(1)
    .map((part) => {
      const [title, ...rest] = part.split('\n');
      return { title: title.trim(), body: rest.join('\n').replace(/^\s*\[.*\]\s*/, '').trim() };
    });
  const lines = sections.map((s) => `- ${s.title}: ${s.body.replace(/\s*\n+\s*/g, ' ').length}자`);

  const found = CLICHES.flatMap((word) => {
    const hit = sections.filter((s) => s.body.includes(word)).map((s) => s.title.split('.')[0]);
    return hit.length ? [`${word}(${hit.join(', ')}번)`] : [];
  });
  const digits = new Set(sections.flatMap((s) => s.body.match(/\d[\d,.]*\d|\d/g) ?? []));
  const unknown = [...digits].filter(
    (n) => !new RegExp(`(?<![\\d.])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d])`).test(sources),
  );

  return [
    '## 자동 점검',
    '',
    '글자 수 (공백 포함, 줄바꿈 제외. 소제목 줄은 뺐습니다. 지원 사이트 칸의 기준과 다를 수 있으니 직접 다시 세어 주세요.)',
    '',
    ...lines,
    '',
    found.length
      ? `- 상투어: ${found.join(', ')}. 문맥상 필요한 말인지 확인하세요.`
      : '- 상투어: 목록의 표현이 없습니다.',
    unknown.length
      ? `- 근거 자료(이력서, 면접 스토리, 공고, 조사 보고서)에서 찾지 못한 숫자: ${unknown.join(', ')}. 사실인지 확인하세요.`
      : '- 본문의 모든 숫자가 근거 자료에 있습니다. 자료 어딘가에 같은 숫자가 있으면(날짜 속 숫자 포함) 통과시키는 간단한 점검이니, 숫자의 의미는 직접 확인하세요.',
  ].join('\n');
}

// 자소서 초안은 제목, 인용 한 줄, 문단, 목록만 쓰므로 그 범위만 HTML로 바꾼다.
function coverHtml(markdown: string) {
  const body = markdown
    .replace(/^(#{1,3} .*)$/gm, '\n$1\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      if (block.startsWith('# ')) return `<h1>${escapeHtml(block.slice(2))}</h1>`;
      // 검토 결과는 자기소개서 본문과 쪽을 나눠, 제출용 쪽만 따로 쓸 수 있게 한다.
      if (block.startsWith('## 검토 결과')) return `<h2 class="break">${escapeHtml(block.slice(3))}</h2>`;
      if (block.startsWith('## ')) return `<h2>${escapeHtml(block.slice(3))}</h2>`;
      if (block.startsWith('### ')) return `<h3>${escapeHtml(block.slice(4))}</h3>`;
      if (block.startsWith('>')) return `<p class="meta">${escapeHtml(block.replace(/^> ?/gm, ''))}</p>`;
      if (block.startsWith('- '))
        return `<ul>${block.split('\n').map((line) => `<li>${escapeHtml(line.replace(/^- /, ''))}</li>`).join('')}</ul>`;
      if (/^\[.*\]$/.test(block)) return `<p class="subtitle">${escapeHtml(block.slice(1, -1))}</p>`;
      return `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><title>자기소개서</title><style>
@page { size: A4; margin: 22mm 20mm; }
body { font: 11pt/1.75 "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; color: #1d1d1f; }
h1 { margin: 0 0 4pt; font-size: 20pt; }
h2 { margin: 22pt 0 8pt; padding-bottom: 4pt; border-bottom: 1px solid #e0e0e0; font-size: 13pt; break-after: avoid; }
h2.break { break-before: page; margin-top: 0; }
h3 { margin: 14pt 0 4pt; font-size: 11pt; break-after: avoid; }
p { margin: 0 0 8pt; word-break: keep-all; }
.meta { margin-bottom: 14pt; color: #7a7a7a; font-size: 9.5pt; }
.subtitle { font-weight: 600; break-after: avoid; }
ul { margin: 0; padding-left: 16pt; color: #333333; font-size: 10pt; }
</style>${body}</html>`;
}

const BROWSERS = [
  process.env.PDF_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

// 설치된 Edge/Chrome의 헤드리스 인쇄로 PDF를 만든다.
async function writePdf(markdown: string, pdfPath: string) {
  const browser = BROWSERS.find((p) => p && existsSync(/*turbopackIgnore: true*/ p));
  if (!browser) throw new Error('PDF를 만들 Edge나 Chrome을 찾지 못했습니다. PDF_BROWSER 환경 변수에 실행 파일 경로를 지정하세요.');
  const tmp = await mkdtemp(path.join(/*turbopackIgnore: true*/ os.tmpdir(), 'cover-pdf-'));
  try {
    const htmlPath = path.join(/*turbopackIgnore: true*/ tmp, 'cover.html');
    await writeFile(htmlPath, coverHtml(markdown), 'utf8');
    await promisify(execFile)(
      browser,
      [
        '--headless',
        '--disable-gpu',
        '--no-pdf-header-footer',
        `--user-data-dir=${path.join(/*turbopackIgnore: true*/ tmp, 'profile')}`,
        `--print-to-pdf=${pdfPath}`,
        pathToFileURL(htmlPath).href,
      ],
      { timeout: 60_000 },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

const readOrEmpty = (file: string) => readFile(file, 'utf8').catch(() => '');

async function work(kind: Kind, id: string, key: string) {
  const { prompt, review, dir, tools, pdf } = KINDS[kind];
  const jobs: Job[] = JSON.parse(
    await readFile(path.join(/*turbopackIgnore: true*/ ROOT, 'data', 'ranked-jobs.json'), 'utf8'),
  );
  const job = jobs.find((j) => new RegExp(`rec_idx=${id}(?!\\d)`).test(j.url));
  if (!job) throw new Error('data/ranked-jobs.json에 없는 공고입니다.');

  const here = (name: string) => path.join(/*turbopackIgnore: true*/ process.cwd(), name);
  const values: Record<string, string> = {
    id,
    company: job.company,
    title: job.title,
    url: job.url,
    today: new Date().toLocaleDateString('sv-SE'),
    job_json: JSON.stringify(job, null, 2),
    jd: await loadJd(id, job.url),
    guide: kind === 'cover' ? await readOrEmpty(here('cover-letter.guide.md')) : '',
  };
  const fill = (template: string) => template.replace(/\{\{(\w+)\}\}/g, (match, name) => values[name] ?? match);

  state.phase.set(key, review ? '초안을 쓰는 중 (1/3)' : '조사하는 중');
  let text = await runClaude(fill(await readFile(here(prompt), 'utf8')), tools, ROOT);

  await mkdir(dir, { recursive: true });
  if (review) {
    // 검토 단계가 실패해도 초안은 남는다.
    await writeFile(path.join(/*turbopackIgnore: true*/ dir, `${id}.draft.md`), text + '\n', 'utf8');
    state.phase.set(key, '근거 확인과 검토 중 (2/3)');
    values.draft = text;
    text = await runClaude(fill(await readFile(here(review), 'utf8')), tools, ROOT);

    // 글자 수, 상투어, 근거 없는 숫자는 모델이 아니라 코드로 점검해 검토 결과에 붙인다.
    const sources = [
      await readOrEmpty(path.join(/*turbopackIgnore: true*/ ROOT, 'cv.md')),
      await readOrEmpty(path.join(/*turbopackIgnore: true*/ ROOT, 'interview-prep', 'story-bank.md')),
      await readOrEmpty(path.join(/*turbopackIgnore: true*/ ROOT, 'modes', 'voice.md')),
      await readOrEmpty(path.join(/*turbopackIgnore: true*/ KINDS.deep.dir, `${id}.md`)),
      values.jd,
      values.job_json,
    ].join('\n');
    const check = autoCheck(text, sources);
    const at = text.search(/^## 제출 전 확인/m);
    text = at < 0 ? `${text}\n\n${check}` : `${text.slice(0, at)}${check}\n\n${text.slice(at)}`;
  }

  await writeFile(path.join(/*turbopackIgnore: true*/ dir, `${id}.md`), text + '\n', 'utf8');
  if (pdf) {
    state.phase.set(key, 'PDF를 만드는 중 (3/3)');
    await writePdf(text, path.join(/*turbopackIgnore: true*/ dir, `${id}.pdf`));
  }
}

async function parse(params: Ctx['params']) {
  const { kind, id } = await params;
  return kind in KINDS && /^\d+$/.test(id) ? { kind: kind as Kind, id, key: `${kind}:${id}` } : null;
}

const fileOf = (kind: Kind, id: string, ext: 'md' | 'pdf') =>
  path.join(/*turbopackIgnore: true*/ KINDS[kind].dir, `${id}.${ext}`);

export async function GET(req: Request, { params }: Ctx) {
  const target = await parse(params);
  if (!target) return Response.json({ error: 'not found' }, { status: 404 });
  const { kind, id, key } = target;

  if (new URL(req.url).searchParams.has('pdf')) {
    const pdf = await readFile(fileOf(kind, id, 'pdf')).catch(() => null);
    if (!pdf) return Response.json({ error: 'PDF가 아직 없습니다' }, { status: 404 });
    return new Response(new Uint8Array(pdf), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(`자기소개서_${id}.pdf`)}`,
      },
    });
  }

  const report = await readFile(fileOf(kind, id, 'md'), 'utf8').catch(() => null);
  const pdf = existsSync(/*turbopackIgnore: true*/ fileOf(kind, id, 'pdf'));
  if (state.running.has(key))
    return Response.json({ state: 'running', startedAt: state.running.get(key), phase: state.phase.get(key), report, pdf });
  if (state.failed.has(key)) return Response.json({ state: 'failed', error: state.failed.get(key), report, pdf });
  return Response.json({ state: report === null ? 'none' : 'done', report, pdf });
}

// 작업을 시작하고 결과 화면으로 보낸다. 이미 결과가 있으면 ?force일 때만 다시 실행한다.
export async function POST(req: Request, { params }: Ctx) {
  const target = await parse(params);
  if (!target) return Response.json({ error: 'not found' }, { status: 404 });
  // 작업 한 번이 Claude 사용량을 쓰므로 다른 사이트에서 보낸 요청은 받지 않는다.
  if (req.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ error: 'forbidden' }, { status: 403 });
  const { kind, id, key } = target;

  const force = new URL(req.url).searchParams.has('force');
  if (!state.running.has(key) && (force || !existsSync(/*turbopackIgnore: true*/ fileOf(kind, id, 'md')))) {
    state.running.set(key, Date.now());
    state.failed.delete(key);
    work(kind, id, key)
      .catch((e) => state.failed.set(key, String(e?.message ?? e)))
      .finally(() => {
        state.running.delete(key);
        state.phase.delete(key);
      });
  }
  return Response.redirect(new URL(`/doc/${kind}/${id}`, req.url), 303);
}
