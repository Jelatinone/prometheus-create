/**
 * Global setup for the platform-live vitest project: sign the two test users in
 * ONCE per run and provide their sessions to every live test file. Only runs
 * when that project has test files in the run, so focused runs of other suites
 * make no Supabase sign-ins. The magic-link flow itself is unchanged
 * (admin generateLink -> verifyOtp); sessions stay in memory.
 */
import type { TestProject } from "vitest/node";
import { platformEnv, signInTestUsers } from "./harness";

export default async function setup(project: TestProject) {
  project.provide("platformSessions", platformEnv().ready ? await signInTestUsers() : null);
}
