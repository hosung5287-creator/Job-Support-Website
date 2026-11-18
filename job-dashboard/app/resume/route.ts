import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA, JOBS_FILE, REGION_CODES, ROOT, SEARCH_FILE, startTask, task, updateJobs, type Search } from '../lib/jobs';
import { runClaude } from '../lib/server';

export const dynamic = 'force-dynamic';

// 이력서 넣기: PDF를 저장하고, 이력서를 읽어 cv.md·프로필·검색 조건을 새로 만든 뒤 공고를 모두 다시 평가한다.
const RESUME_DIR = path.join(/*turbopackIgnore: true*/ DATA, 'resume');
const CURRENT = path.join(/*turbopackIgnore: true*/ RESUME_DIR, 'current.json');
const MAX_BYTES = 10 * 1024 * 1024;

type Current = { file: string; name: string; size: number; uploadedAt: string; appliedAt?: string };

const readCurrent = () =>
  readFile(CURRENT, 'utf8').then(
    (t) => JSON.parse(t) as Current,
    () => null,
  );

// 작업자 답변에서 ===CV=== / ===PROFILE=== / ===SEARCH=== 구획을 꺼낸다.
function sections(out: string) {
  const part = (name: string) => {
    const m = new RegExp(`===${name}===\\s*\\n([\\s\\S]*?)(?=\\n===[A-Z]+===|$)`).exec(out);
    return m ? m[1].trim() : '';
  };
  return { cv: part('CV'), profile: part('PROFILE'), search: part('SEARCH') };
}

function toSearches(json: string): Search[] {
  const parsed: unknown = JSON.parse(json.slice(json.indexOf('['), json.lastIndexOf(']') + 1));
  return (Array.isArray(parsed) ? parsed : [])
    .filter((s) => s && typeof s.word === 'string' && s.word.trim())
    .slice(0, 3)
    .map((s) => ({
      word: s.word.trim(),
      // 코드표에 없는 지역 이름은 버린다. 남는 지역이 없으면 지역 조건 없이(전국) 검색한다.
      loc: (Array.isArray(s.regions) ? s.regions : [])
        .map((r: unknown) => REGION_CODES[String(r).trim()])
        .filter(Boolean)
        .join(','),
      career: s.career === '경력' ? '경력' : '신입',
    }));
}

async function applyResume(current: Current) {
  task.phase = '이력서 읽는 중 (1/5)';
  const template = await readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), 'resume.prompt.md'), 'utf8');
  const prompt = template
    .replace('{{pdf}}', `data/resume/${current.file}`)
    .replace('{{regions}}', Object.keys(REGION_CODES).join(', '));
  const { cv, profile, search } = sections(await runClaude(prompt, ['Read'], ROOT));
  const searches = toSearches(search);
  if (cv.length < 200 || !profile.includes('## Your Target Roles') || !searches.length)
    throw new Error('이력서를 읽지 못했습니다(결과 형식이 맞지 않음). 기존 이력서와 공고는 바꾸지 않았습니다.');

  // 바꾸기 전에 기존 이력서·프로필·검색 조건·공고 점수를 날짜별 폴더에 백업한다.
  const backup = path.join(/*turbopackIgnore: true*/ RESUME_DIR, 'backup', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(backup, { recursive: true });
  for (const [from, name] of [
    [path.join(/*turbopackIgnore: true*/ ROOT, 'cv.md'), 'cv.md'],
    [path.join(/*turbopackIgnore: true*/ ROOT, 'modes', '_profile.md'), '_profile.md'],
    [SEARCH_FILE, 'search.json'],
    [JOBS_FILE, 'saramin-jobs.json'],
  ])
    await copyFile(from, path.join(/*turbopackIgnore: true*/ backup, name)).catch(() => {});

  await writeFile(path.join(/*turbopackIgnore: true*/ ROOT, 'cv.md'), cv + '\n', 'utf8');
  await mkdir(path.join(/*turbopackIgnore: true*/ ROOT, 'modes'), { recursive: true });
  await writeFile(path.join(/*turbopackIgnore: true*/ ROOT, 'modes', '_profile.md'), profile + '\n', 'utf8');
  await writeFile(SEARCH_FILE, JSON.stringify(searches, null, 2) + '\n', 'utf8');

  const result = await updateJobs({ reevaluateAll: true, step: 2, total: 5 });
  await writeFile(CURRENT, JSON.stringify({ ...current, appliedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  return result;
}

export async function GET() {
  return Response.json({ task, resume: await readCurrent() });
}

export async function POST(req: Request) {
  if (req.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ error: 'forbidden' }, { status: 403 });
  if (task.running) return Response.json({ error: '다른 작업이 진행 중입니다. 끝난 뒤 다시 저장하세요.' }, { status: 409 });

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return Response.json({ error: 'PDF 파일을 골라 주세요.' }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: 'PDF는 10MB 이하만 올릴 수 있습니다.' }, { status: 413 });
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return Response.json({ error: 'PDF 파일이 아닙니다.' }, { status: 415 });

  // 올린 원본은 data/resume/에 날짜를 붙여 저장한다. 이 폴더는 .gitignore 대상이다.
  await mkdir(RESUME_DIR, { recursive: true });
  const stored = `resume-${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`;
  await writeFile(path.join(/*turbopackIgnore: true*/ RESUME_DIR, stored), bytes);
  const current: Current = { file: stored, name: file.name, size: file.size, uploadedAt: new Date().toISOString() };
  await writeFile(CURRENT, JSON.stringify(current, null, 2) + '\n', 'utf8');

  startTask('resume', () => applyResume(current));
  return Response.json({ task, resume: current }, { status: 202 });
}
