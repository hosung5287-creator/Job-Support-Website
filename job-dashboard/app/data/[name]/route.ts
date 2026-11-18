import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STATUSES } from '../../statuses';

export const dynamic = 'force-dynamic';

// 데이터 소스는 상위 폴더의 data/ (career-ops/data). 다른 위치는 JOBS_DATA_DIR 환경 변수로 지정.
const DATA_DIR = process.env.JOBS_DATA_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), '..', 'data');
const FILES = ['ranked-jobs.json', 'status.json'];

type Ctx = { params: Promise<{ name: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { name } = await params;
  if (!FILES.includes(name)) return Response.json({ error: 'not found' }, { status: 404 });
  try {
    const text = await readFile(path.join(/*turbopackIgnore: true*/ DATA_DIR, name), 'utf8');
    return new Response(text, {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch {
    // status.json은 첫 저장 전까지 없을 수 있다.
    if (name === 'status.json') return Response.json({ updatedAt: null, statuses: {} });
    return Response.json({ error: `${name} 파일을 찾을 수 없습니다` }, { status: 404 });
  }
}

export async function PUT(req: Request, { params }: Ctx) {
  const { name } = await params;
  if (name !== 'status.json') return Response.json({ error: 'read-only' }, { status: 405 });

  const body = await req.json().catch(() => null);
  const statuses = body?.statuses;
  const valid =
    typeof body?.updatedAt === 'string' &&
    statuses !== null &&
    typeof statuses === 'object' &&
    !Array.isArray(statuses) &&
    Object.keys(statuses).length <= 5000 &&
    Object.values(statuses).every((s) => (STATUSES as readonly unknown[]).includes(s));
  if (!valid) return Response.json({ error: 'invalid status payload' }, { status: 400 });

  // ponytail: 마지막 저장이 이긴다. 여러 탭에서 동시에 고치게 되면 쓰기 큐를 추가.
  const file = { updatedAt: body.updatedAt, statuses };
  await writeFile(path.join(/*turbopackIgnore: true*/ DATA_DIR, 'status.json'), JSON.stringify(file, null, 2) + '\n', 'utf8');
  return Response.json({ ok: true });
}
