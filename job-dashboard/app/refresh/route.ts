import { startTask, task, updateJobs } from '../lib/jobs';

export const dynamic = 'force-dynamic';

// 공고 새로 고침: 마감이 지난 공고와 상시 공고만 다시 확인하고, 사람인 검색 결과의 신규 공고를 평가해 추가한다.
// GET은 새로 고침과 이력서 반영이 함께 쓰는 작업 상태를 돌려준다.
export async function GET() {
  return Response.json(task);
}

export async function POST(req: Request) {
  // 새로 고침 한 번이 Claude 사용량을 쓰므로 다른 사이트에서 보낸 요청은 받지 않는다.
  if (req.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ error: 'forbidden' }, { status: 403 });
  startTask('refresh', () => updateJobs({ reevaluateAll: false, step: 1, total: 4 }));
  return Response.json(task, { status: 202 });
}
