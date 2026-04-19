import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Scope file-tracing to this package — the monorepo root has its own
  // lockfile that Next would otherwise infer, triggering a workspace-root
  // warning at build time.
  outputFileTracingRoot: __dirname,
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
