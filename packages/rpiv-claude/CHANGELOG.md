# Changelog

All notable changes to `@juicesharp/rpiv-claude` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `rpiv-wf` runs rpiv-workflow pipelines headless on Claude Code through the Claude Agent SDK: `list`, `run`, `resume`. Implements the runner's executor port (fresh, re-prompt, reattach, fork) over Agent SDK sessions, routes `/skill:` to the rpiv plugin or Claude Code's own skills, and registers rpiv-pi's built-ins, skill contracts and outcome deriver without Pi.
