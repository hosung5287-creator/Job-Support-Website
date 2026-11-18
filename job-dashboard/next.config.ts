import type { NextConfig } from 'next';

// 상위 폴더(career-ops)에도 package-lock.json이 있어 Next가 작업 루트를 그쪽으로 추론한다. 이 폴더로 고정.
const config: NextConfig = { turbopack: { root: __dirname } };

export default config;
