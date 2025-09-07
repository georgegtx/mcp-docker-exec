# GitHub Actions Workflows

This project uses GitHub Actions for continuous integration and deployment. Here's an overview of the workflows:

## Workflow Status

[![CI](https://github.com/georgegtx/mcp-docker-exec/actions/workflows/ci.yml/badge.svg)](https://github.com/georgegtx/mcp-docker-exec/actions/workflows/ci.yml)
[![Security Checks](https://github.com/georgegtx/mcp-docker-exec/actions/workflows/security.yml/badge.svg)](https://github.com/georgegtx/mcp-docker-exec/actions/workflows/security.yml)
[![CodeQL](https://github.com/georgegtx/mcp-docker-exec/actions/workflows/codeql.yml/badge.svg)](https://github.com/georgegtx/mcp-docker-exec/actions/workflows/codeql.yml)

## Workflows

### 1. CI (`ci.yml`)
Runs on every pull request and push to main branch:
- **Test matrix**: Node.js 18.x and 20.x
- **Steps**: Lint → Build → Unit Tests → Integration Tests
- **Coverage**: Uploads to Codecov
- **Docker**: Tests Docker image build

### 2. PR Validation (`pr-validation.yml`)
Runs on pull requests:
- Validates code formatting
- Runs ESLint checks
- Builds TypeScript
- Runs tests with coverage
- Comments results on PR
- Checks bundle size

### 3. Security (`security.yml`)
Runs on pull requests and daily:
- **Dependency Review**: Checks for vulnerable dependencies
- **CodeQL**: Static security analysis
- **Docker Security**: Hadolint and Trivy scans
- **Secret Scanning**: TruffleHog OSS

### 4. Release (`release.yml`)
Runs on version tags (v*):
- Runs full test suite
- Creates GitHub release with changelog
- Publishes to npm (if configured)
- Builds and pushes multi-arch Docker images

## Local Testing

To test workflows locally, you can use [act](https://github.com/nektos/act):

```bash
# Test CI workflow
act -j test

# Test with specific Node version
act -j test -P ubuntu-latest=node:20

# Test pull request workflow
act pull_request
```

## Required Secrets

For full functionality, configure these secrets in your repository:

- `NPM_TOKEN`: For publishing to npm
- `CODECOV_TOKEN`: For coverage reports (optional)

## Branch Protection

Recommended branch protection rules for `main`:
- Require pull request reviews
- Require status checks to pass:
  - `test (18.x)`
  - `test (20.x)`
  - `integration-test`
  - `docker-build`
- Require branches to be up to date
- Include administrators