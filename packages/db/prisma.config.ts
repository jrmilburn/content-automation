import "dotenv/config";

import { defineConfig } from "prisma/config";

const localFallbackUrl =
  "postgresql://studio_parallel:studio_parallel@127.0.0.1:5432/studio_parallel";

if (
  (process.env.APP_ENV === "staging" || process.env.APP_ENV === "production") &&
  !process.env.DATABASE_URL
) {
  throw new Error("DATABASE_URL is required for staging and production Prisma commands");
}

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL ?? localFallbackUrl,
  },
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  schema: "prisma/schema.prisma",
});
