import type { NextConfig } from "next";

import { loadRuntimeConfig } from "@studio-parallel/config";

loadRuntimeConfig(process.env);

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
};

export default nextConfig;
