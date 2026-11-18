#!/usr/bin/env node
// 사람인 공고 랭킹: data/saramin-jobs.json(수집 + 수기 평가) + cv.md → data/ranked-jobs.json
//
// 평가 기준 (각 0~5점, 가중치):
//   직무 적합도 ×3 · 기술 스택 일치 ×2 · 경력연차 부합 ×1 · 근무 조건 ×1 · 성장성 ×1  (만점 40 → 100점 환산)
// 기술 스택 점수만 이 스크립트가 계산한다: 공고 키워드(req 가중 2, pref 가중 1)가 cv.md에 있는지 대조.
// 등급: A ≥ 80 · B ≥ 65 · C ≥ 50 · D < 50
//
// 실행: node data/rank-saramin.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cv = readFileSync(join(here, '..', 'cv.md'), 'utf8');
const { jobs } = JSON.parse(readFileSync(join(here, 'saramin-jobs.json'), 'utf8'));

const WEIGHTS = { fit: 3, stack: 2, experience: 1, conditions: 1, growth: 1 };
const MAX = 5 * Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

// 공고 키워드 → cv.md에서 찾을 패턴. 없는 키워드는 글자 그대로(영문은 단어 경계) 찾는다.
const ALIASES = {
  'Java': /(?<![A-Za-z])Java(?![A-Za-z])/,
  'JavaScript': /JavaScript|React|Vite/i, // 명시는 없지만 React·Vite 사용으로 뒷받침
  'Spring': /Spring/i,
  'Spring Boot': /Spring\s?Boot/i,
  'REST API': /REST\s?API/i,
  'RDBMS': /RDBMS|PostgreSQL|MySQL|Oracle/i,
  'SQL': /(?<![A-Za-z])SQL(?![A-Za-z])/,
  'OOP': /객체지향|OOP/,
  'GIS': /GIS|Leaflet/,
  'AI 도구 활용': /Claude|AI 도구/,
  'LLM API': /Claude API|LLM/,
  '기술 문서화': /문서화|운영 가이드|설계 문서/,
  '장애 대응': /장애|오류/,
  'C/C++': /C\+\+/,
};
// cv.md에 '취득 예정'으로만 적힌 항목은 보유로 치지 않는다.
const NOT_HELD = new Set(['정보처리산업기사']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const inCv = (kw) => {
  if (NOT_HELD.has(kw)) return false;
  const re = ALIASES[kw]
    ?? (/^[\x20-\x7e]+$/.test(kw)
      ? new RegExp(`(?<![A-Za-z])${escapeRe(kw)}(?![A-Za-z])`, 'i')
      : new RegExp(escapeRe(kw)));
  return re.test(cv);
};
const half = (x) => Math.round(x * 2) / 2;

function stackScore(job) {
  if (typeof job.stack_override === 'number') return job.stack_override;
  const n = job.req.length + job.pref.length;
  if (n === 0) return 2.5;
  const hit = 2 * job.req.filter(inCv).length + job.pref.filter(inCv).length;
  const raw = (5 * hit) / (2 * job.req.length + job.pref.length);
  // 키워드가 5개 미만이면 근거가 얇으므로 중립값(2.5) 쪽으로 당긴다.
  return half(2.5 + (raw - 2.5) * Math.min(1, n / 5));
}

const grade = (s) => (s >= 80 ? 'A' : s >= 65 ? 'B' : s >= 50 ? 'C' : 'D');

const ranked = jobs
  .map((job) => {
    const stack = stackScore(job);
    const weighted =
      job.fit * WEIGHTS.fit + stack * WEIGHTS.stack + job.experience * WEIGHTS.experience +
      job.conditions * WEIGHTS.conditions + job.growth * WEIGHTS.growth;
    const score = Math.round((weighted / MAX) * 1000) / 10;
    const missing = [...job.req, ...job.pref].filter((k) => !inCv(k)).concat(job.extra_missing ?? []);
    return {
      company: job.company,
      title: job.title,
      url: `https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=${job.id}`,
      score,
      grade: grade(score),
      reason: job.reason,
      missing_keywords: [...new Set(missing)],
      breakdown: { job_fit: job.fit, tech_stack: stack, experience: job.experience, conditions: job.conditions, growth: job.growth },
      deadline: job.deadline,
      location: job.location,
      career: job.career,
      education: job.education,
      employment: job.employment,
      salary: job.salary,
      jd_source: job.jd_source,
    };
  })
  .sort((a, b) => b.score - a.score || b.breakdown.job_fit - a.breakdown.job_fit || a.company.localeCompare(b.company, 'ko'))
  .map((job, i) => ({ rank: i + 1, ...job }));

writeFileSync(join(here, 'ranked-jobs.json'), JSON.stringify(ranked, null, 2) + '\n', 'utf8');

const counts = ranked.reduce((acc, j) => ((acc[j.grade] = (acc[j.grade] ?? 0) + 1), acc), {});
console.log(`ranked ${ranked.length} jobs → data/ranked-jobs.json`, counts);
for (const j of ranked.slice(0, 15)) {
  const b = j.breakdown;
  console.log(`${String(j.rank).padStart(2)} ${j.score.toFixed(1)} ${j.grade} | ${j.company} | ${j.title} | fit ${b.job_fit} stack ${b.tech_stack} exp ${b.experience} cond ${b.conditions} growth ${b.growth} | 부족: ${j.missing_keywords.join(', ') || '-'}`);
}
