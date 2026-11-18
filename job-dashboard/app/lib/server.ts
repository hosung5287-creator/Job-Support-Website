import { spawn } from 'node:child_process';

// 서버 라우트(심층 조사, 자소서, 공고 새로 고침)가 함께 쓰는 도우미.

const TIMEOUT_MS = 15 * 60 * 1000;

// 작업자에게 허용하지 않은 쓰기·명령 실행·웹 도구는 명시적으로 막는다.
const RESTRICTED = ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Task', 'WebFetch', 'WebSearch'];

export const htmlToText = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|dt|dd)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();

export function runClaude(prompt: string, tools: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => {
    // 허용 목록에 없는 쓰기·명령 실행·웹 도구는 명시적으로 막고, MCP 서버는 하나도 불러오지 않는다.
    // Windows에서 claude는 .cmd라 shell이 필요하다. 인수는 모두 고정값이고 프롬프트는 stdin으로 넘긴다.
    const denied = RESTRICTED.filter((tool) => !tools.includes(tool));
    const child = spawn(
      'claude',
      ['-p', '--output-format', 'text', '--strict-mcp-config', '--allowedTools', ...tools, '--disallowedTools', ...denied],
      { cwd, shell: true, windowsHide: true },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    const timer = setTimeout(() => {
      // shell을 거쳐 띄웠으므로 Windows에서는 프로세스 트리째 종료한다.
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else child.kill();
    }, TIMEOUT_MS);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      // 모델이 답을 코드 펜스로 감싼 경우 벗겨 낸다.
      const text = out.trim().replace(/^```(?:markdown)?\s*\n/, '').replace(/\n```$/, '');
      if (code === 0 && text) resolve(text);
      else reject(new Error(err.trim().slice(-500) || `claude 종료 코드 ${code}`));
    });
    child.stdin.end(prompt);
  });
}
