import type { NextConfig } from 'next';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH !== undefined
  ? process.env.NEXT_PUBLIC_BASE_PATH
  : '/uk/uk-student-loan-calculator';


const nextConfig: NextConfig = {
  ...(basePath ? { basePath } : {}),
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
