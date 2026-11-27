// Preloaded before every test file (bunfig.toml). A suite run from a shell that
// a non-default Claude Code install launched inherits its CLAUDE_CONFIG_DIR;
// left in place, every test that does not set its own would resolve Claude
// paths against that real install. Tests that need it set it themselves.
delete process.env.CLAUDE_CONFIG_DIR;
