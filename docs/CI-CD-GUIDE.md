# CI/CD Pipeline Guide

This document describes the complete end-to-end automated build, packaging, and distribution system for the `mcp-docker-exec` package.

## Overview

The CI/CD pipeline automatically:
- ✅ Runs tests and quality checks on every push and PR
- ✅ Builds and publishes Docker images to GitHub Container Registry
- ✅ Publishes packages to npm registry
- ✅ Creates GitHub releases with changelog
- ✅ Manages semantic versioning automatically
- ✅ Updates dependencies via Dependabot

## Pipeline Components

### 1. Main CI/CD Workflow (`.github/workflows/ci-cd.yml`)

Triggers on:
- Push to `main` or `develop` branches
- Pull requests to `main`
- Release creation

#### Jobs:

##### Lint
- Runs ESLint for code quality
- Checks Prettier formatting
- **Required for merge**

##### Test
- Runs unit tests across Node.js versions (18.x, 20.x, 21.x)
- Uploads coverage reports to Codecov
- **Required for merge**

##### Integration Test
- Runs integration tests with Docker
- Tests actual Docker container interactions
- **Required for merge**

##### Build
- Compiles TypeScript to JavaScript
- Uploads build artifacts
- **Required for merge**

##### Security
- Runs npm audit for vulnerabilities
- Runs Snyk security scanning (optional)
- CodeQL analysis for code security
- **Required for merge**

##### Docker
- Builds multi-architecture Docker images
- Pushes to GitHub Container Registry (ghcr.io)
- Tags images with:
  - Branch name
  - PR number
  - Semantic version
  - Git SHA

##### Publish NPM
- **Only runs on release events**
- Publishes package to npm registry
- Uses npm automation token

##### Release Assets
- **Only runs on release events**
- Creates release tarballs
- Uploads compiled artifacts

### 2. Release Management (`.github/workflows/release.yml`)

Automated semantic versioning and release creation.

#### Triggers:
- Manual workflow dispatch (choose version type)
- Push to `main` branch (auto-detects version from commit)

#### Version Detection:
- `feat:` commits → minor version bump
- `fix:` commits → patch version bump
- Breaking changes → major version bump
- Default → patch version bump

#### Process:
1. Analyzes commits
2. Bumps version in package.json
3. Generates changelog using git-cliff
4. Creates git tag
5. Pushes changes
6. Creates GitHub release

### 3. Dependency Management

#### Dependabot Configuration (`.github/dependabot.yml`)
- Weekly updates for:
  - npm packages
  - Docker base images
  - GitHub Actions
- Auto-merge for patch updates
- Grouped by ecosystem

### 4. Branch Protection

Configured in `.github/branch-protection.json`:

#### Main Branch:
- Requires all status checks to pass
- Requires 1 approval
- Requires code owner review
- Dismisses stale reviews
- No force pushes
- Conversation resolution required

#### Develop Branch:
- Requires core status checks
- Requires 1 approval
- More relaxed than main

## Setup Instructions

### Prerequisites

1. **GitHub Repository Settings**

   Navigate to Settings → Secrets and variables → Actions, add:
   - `NPM_TOKEN`: Your npm automation token
   - `SNYK_TOKEN`: (Optional) Snyk authentication token

2. **npm Account Setup**

   ```bash
   # Login to npm
   npm login
   
   # Generate automation token
   npm token create --read-only=false --cidr=0.0.0.0/0
   ```

3. **Enable GitHub Packages**

   - Go to Settings → Pages
   - Enable GitHub Container Registry

### Initial Setup

1. **Update package.json**

   Replace placeholder values:
   ```json
   {
     "author": "Your Name <your.email@example.com>",
     "repository": {
       "url": "https://github.com/YOUR_USERNAME/mcp-docker-exec.git"
     }
   }
   ```

2. **Update CODEOWNERS**

   Replace `@YOUR_USERNAME` with your GitHub username in `.github/CODEOWNERS`

3. **Update Dependabot**

   Replace `YOUR_USERNAME` with your GitHub username in `.github/dependabot.yml`

4. **Apply Branch Protection**

   Run this script to apply branch protection rules:
   ```bash
   gh api repos/:owner/:repo/branches/main/protection \
     --method PUT \
     --input .github/branch-protection.json
   ```

## Usage

### Automatic Releases

1. **Conventional Commits**
   
   Use conventional commit messages:
   ```bash
   git commit -m "feat: add new Docker command"     # Minor version
   git commit -m "fix: resolve streaming issue"     # Patch version
   git commit -m "feat!: breaking API change"       # Major version
   ```

2. **Manual Release**

   ```bash
   # Trigger release workflow
   gh workflow run release.yml -f release_type=minor
   ```

### Publishing

Releases automatically trigger:
1. npm package publication
2. Docker image build and push
3. GitHub release with assets

### Docker Images

Images are available at:
```
ghcr.io/YOUR_USERNAME/mcp-docker-exec:latest
ghcr.io/YOUR_USERNAME/mcp-docker-exec:1.0.0
ghcr.io/YOUR_USERNAME/mcp-docker-exec:main
```

### npm Package

After release, the package is available:
```bash
npm install mcp-docker-exec
```

## Monitoring

### Build Status

- Check Actions tab for workflow runs
- Badges can be added to README:

```markdown
[![CI/CD](https://github.com/YOUR_USERNAME/mcp-docker-exec/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/YOUR_USERNAME/mcp-docker-exec/actions/workflows/ci-cd.yml)
[![npm version](https://badge.fury.io/js/mcp-docker-exec.svg)](https://www.npmjs.com/package/mcp-docker-exec)
```

### Coverage Reports

- Coverage uploaded to Codecov
- Add Codecov badge to README

### Security

- Dependabot alerts in Security tab
- npm audit results in workflow logs
- Snyk reports (if configured)

## Troubleshooting

### Common Issues

1. **npm publish fails**
   - Verify NPM_TOKEN is set correctly
   - Check npm account has publish permissions
   - Ensure package name is available

2. **Docker push fails**
   - GitHub Packages must be enabled
   - Check workflow has `packages: write` permission

3. **Release workflow fails**
   - Ensure main branch is not protected against pushes from Actions
   - Check git-cliff configuration is valid

### Manual Interventions

If automatic release fails:

1. **Manual npm publish**
   ```bash
   npm run build
   npm publish
   ```

2. **Manual Docker build**
   ```bash
   docker build -t ghcr.io/YOUR_USERNAME/mcp-docker-exec:latest .
   docker push ghcr.io/YOUR_USERNAME/mcp-docker-exec:latest
   ```

## Best Practices

1. **Commit Messages**
   - Follow conventional commits
   - Include breaking changes in footer
   - Reference issues: `fix: error handling (#123)`

2. **Versioning**
   - Follow semantic versioning
   - Use prereleases for testing
   - Tag releases properly

3. **Security**
   - Review Dependabot PRs promptly
   - Address security alerts quickly
   - Keep dependencies updated

4. **Testing**
   - Ensure tests pass locally before pushing
   - Add tests for new features
   - Maintain good coverage

## Advanced Configuration

### Custom Release Types

Add to release workflow:
```yaml
- beta
- alpha
- rc
```

### Multi-Registry Publishing

Add to publish job:
```yaml
- name: Publish to GitHub Packages
  run: |
    npm config set @YOUR_USERNAME:registry https://npm.pkg.github.com
    npm publish
```

### Slack Notifications

Add notification job:
```yaml
notify:
  runs-on: ubuntu-latest
  needs: [publish-npm]
  steps:
    - uses: 8398a7/action-slack@v3
      with:
        status: ${{ job.status }}
        text: 'New release published!'
      env:
        SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}
```

## Maintenance

### Regular Tasks

- Review and merge Dependabot PRs weekly
- Check for failed workflows
- Update Node.js versions in test matrix
- Review security alerts

### Upgrading

To upgrade the CI/CD pipeline:
1. Update action versions in workflows
2. Test in a feature branch
3. Merge to main after verification