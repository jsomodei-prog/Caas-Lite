import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",

  // Locate tests both colocated with source and in tests/ directory.
  // We currently keep them in tests/ but the matcher is permissive.
  testMatch: [
    "<rootDir>/tests/**/*.test.ts",
    "<rootDir>/src/**/*.test.ts",
  ],

  // Coverage off by default; opt in with --coverage on the CLI.
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/**/*.d.ts",
  ],
  coverageThreshold: {
    global: {
      branches:   80,
      functions:  80,
      lines:      80,
      statements: 80,
    },
  },

  // SDK doesn't open network; tests use a local stub server. 5s per test
  // is generous — most should complete in <100ms.
  testTimeout: 5_000,
};

export default config;
