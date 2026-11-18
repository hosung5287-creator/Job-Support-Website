// 스모크 체크. 개발 서버(npm run dev)가 떠 있는 상태에서 `npm run check`로 실행한다. 데이터 파일은 바꾸지 않는다.
import assert from 'node:assert/strict';

const base = process.env.BASE_URL ?? 'http://localhost:3210';
const put = (name, body) =>
  fetch(`${base}/data/${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const jobs = await (await fetch(`${base}/data/ranked-jobs.json`)).json();
assert.ok(Array.isArray(jobs) && jobs.length > 0, '공고 배열이 비어 있음');
for (const key of ['company', 'title', 'url', 'score', 'grade', 'reason', 'missing_keywords']) {
  assert.ok(key in jobs[0], `필드 없음: ${key}`);
}
assert.equal((await put('status.json', { updatedAt: 'x', statuses: { a: '합격' } })).status, 400, '잘못된 상태값은 거부');
assert.equal((await put('ranked-jobs.json', {})).status, 405, '공고 파일은 읽기 전용');
assert.equal((await fetch(`${base}/data/secret.json`)).status, 404, '허용 목록 밖 파일은 404');
// 작업 라우트(심층 조사·자소서 초안): 알 수 없는 종류나 숫자가 아닌 공고 번호는 404, 한 적 없는 공고는 'none'으로 답한다.
assert.equal((await fetch(`${base}/work/abc/1`)).status, 404, '알 수 없는 작업 종류는 거부');
assert.equal((await fetch(`${base}/work/cover/abc`)).status, 404, '잘못된 공고 번호는 거부');
for (const kind of ['deep', 'cover']) {
  assert.equal((await (await fetch(`${base}/work/${kind}/1`)).json()).state, 'none', `${kind}: 작업 전 상태는 none`);
}
assert.equal((await fetch(`${base}/work/cover/1?pdf`)).status, 404, 'PDF가 없으면 404');
// 공고 새로 고침·이력서 라우트: 상태 조회는 항상 running 값을 돌려주고, PDF가 아닌 파일은 거부한다.
assert.equal(typeof (await (await fetch(`${base}/refresh`)).json()).running, 'boolean', '새로 고침 상태 조회');
const resumeState = await (await fetch(`${base}/resume`)).json();
assert.equal(typeof resumeState.task.running, 'boolean', '이력서 상태 조회');
if (!resumeState.task.running) {
  const form = new FormData();
  form.append('file', new Blob(['not a pdf'], { type: 'application/pdf' }), 'fake.pdf');
  assert.equal((await fetch(`${base}/resume`, { method: 'POST', body: form })).status, 415, 'PDF가 아닌 파일은 거부');
}
console.log(`ok: 공고 ${jobs.length}건, 라우트 검증 통과`);
