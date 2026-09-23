// Test preload (bunfig.toml). The default concurrency cap is min(16, CPUs-2) (P36), so on small CI
// runners (2-4 CPUs) it drops to 1-2 and every test that expects agents to overlap would fail for a
// reason unrelated to what it checks. Pin a roomy cap for the suite; tests of the cap itself pass the
// CPU count explicitly or override this variable with withEnv(). A value set by the caller wins.
process.env.OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS ??= "16"
