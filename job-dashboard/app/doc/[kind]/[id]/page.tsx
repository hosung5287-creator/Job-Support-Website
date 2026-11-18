'use client';

import { useEffect, useState } from 'react';
import { notFound, useParams } from 'next/navigation';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Doc = {
  state: 'none' | 'running' | 'done' | 'failed';
  startedAt?: number;
  phase?: string;
  error?: string;
  report?: string | null;
  pdf?: boolean;
};

const LABELS = {
  deep: {
    title: '심층 조사',
    running: '공고와 회사를 조사하는 중입니다. 보통 3~8분 걸립니다.',
    none: '아직 조사한 적이 없는 공고입니다.',
    start: '심층 조사 시작',
    redo: '다시 조사',
  },
  cover: {
    title: '자소서 초안',
    running:
      '초안을 쓰고, 근거를 확인해 검토한 뒤 PDF로 출력합니다. 보통 10~15분 걸립니다. 작성 기준 자료와 심층 조사 보고서를 반영합니다.',
    none: '아직 초안을 만든 적이 없는 공고입니다.',
    start: '자소서 초안 작성',
    redo: '다시 작성',
  },
};

export default function DocPage() {
  const { kind, id } = useParams<{ kind: string; id: string }>();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [now, setNow] = useState(0);

  // 작업이 끝날 때까지 3초마다 상태를 다시 읽는다.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const poll = async () => {
      const next: Doc = await fetch(`/work/${kind}/${id}`, { cache: 'no-store' }).then((r) => r.json());
      if (stopped) return;
      setDoc(next);
      setNow(Date.now());
      if (next.state === 'running') timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [kind, id]);

  if (!(kind in LABELS)) notFound();
  const label = LABELS[kind as keyof typeof LABELS];
  const other = kind === 'deep' ? 'cover' : 'deep';
  const elapsed = doc?.startedAt ? Math.max(0, Math.round((now - doc.startedAt) / 1000)) : 0;

  return (
    <>
      <header className="global-nav">
        <a href="/">← 취업 상황판</a>
        <span>{label.title}</span>
      </header>
      <main className="report">
        {!doc ? (
          <p className="note">불러오는 중…</p>
        ) : (
          <>
            {doc.state === 'running' && (
              <p className="note" role="status">
                {doc.phase ? `${doc.phase}. ` : ''}
                {label.running} (경과 {Math.floor(elapsed / 60)}분 {elapsed % 60}초)
              </p>
            )}
            {kind === 'cover' && doc.state === 'done' && (
              <p className="note">PDF는 자기소개서 본문 뒤 새 쪽부터 검토 결과가 이어집니다. 지원 사이트에는 본문 쪽만 쓰세요.</p>
            )}
            {doc.state === 'failed' && (
              <p className="note" role="alert">
                작업에 실패했습니다: {doc.error}
              </p>
            )}
            {doc.state === 'none' && <p className="note">{label.none}</p>}
            {doc.state !== 'running' && (
              <div className="report-actions">
                {doc.pdf && (
                  <a className="button-primary" href={`/work/${kind}/${id}?pdf`} target="_blank" rel="noreferrer">
                    PDF 열기
                  </a>
                )}
                <form method="post" action={`/work/${kind}/${id}${doc.report ? '?force' : ''}`}>
                  <button className={doc.pdf ? 'button-secondary' : 'button-primary'}>
                    {doc.report ? label.redo : label.start}
                  </button>
                </form>
                <form method="post" action={`/work/${other}/${id}`}>
                  <button className="button-secondary">{LABELS[other].title}</button>
                </form>
                {doc.report && !doc.pdf && (
                  <button type="button" className="chip" onClick={() => window.print()}>
                    인쇄
                  </button>
                )}
              </div>
            )}
            {doc.report && (
              <article className="markdown">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}
                >
                  {doc.report}
                </Markdown>
              </article>
            )}
          </>
        )}
      </main>
    </>
  );
}
