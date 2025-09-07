#!/bin/bash

# CI/CD Setup Script for mcp-docker-exec
# This script helps configure the repository for automated builds and releases

set -e

echo "🚀 Setting up CI/CD for mcp-docker-exec"
echo "======================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo -e "${RED}❌ GitHub CLI (gh) is not installed.${NC}"
    echo "Please install it from: https://cli.github.com/"
    exit 1
fi

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo -e "${RED}❌ Not in a git repository.${NC}"
    exit 1
fi

# Get repository information
REPO_URL=$(git config --get remote.origin.url)
if [[ $REPO_URL =~ github.com[:/]([^/]+)/([^/.]+)(\.git)?$ ]]; then
    OWNER="${BASH_REMATCH[1]}"
    REPO="${BASH_REMATCH[2]}"
else
    echo -e "${RED}❌ Could not parse GitHub repository URL.${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} Repository: ${OWNER}/${REPO}"

# Function to update placeholder values
update_placeholders() {
    echo -e "\n${YELLOW}📝 Updating configuration files...${NC}"
    
    # Update package.json
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s/YOUR_USERNAME/${OWNER}/g" package.json
        sed -i '' "s/your.email@example.com/${USER}@users.noreply.github.com/g" package.json
        sed -i '' "s/Your Name/${USER}/g" package.json
        
        # Update other files
        sed -i '' "s/YOUR_USERNAME/${OWNER}/g" .github/CODEOWNERS
        sed -i '' "s/YOUR_USERNAME/${OWNER}/g" .github/dependabot.yml
        sed -i '' "s/YOUR_USERNAME/${OWNER}/g" docs/CI-CD-GUIDE.md
    else
        # Linux
        sed -i "s/YOUR_USERNAME/${OWNER}/g" package.json
        sed -i "s/your.email@example.com/${USER}@users.noreply.github.com/g" package.json
        sed -i "s/Your Name/${USER}/g" package.json
        
        # Update other files
        sed -i "s/YOUR_USERNAME/${OWNER}/g" .github/CODEOWNERS
        sed -i "s/YOUR_USERNAME/${OWNER}/g" .github/dependabot.yml
        sed -i "s/YOUR_USERNAME/${OWNER}/g" docs/CI-CD-GUIDE.md
    fi
    
    echo -e "${GREEN}✓${NC} Configuration files updated"
}

# Function to set up secrets
setup_secrets() {
    echo -e "\n${YELLOW}🔐 Setting up repository secrets...${NC}"
    
    # Check for NPM_TOKEN
    echo -n "Do you have an npm automation token? (y/n): "
    read -r has_npm_token
    
    if [[ "$has_npm_token" == "y" ]]; then
        echo -n "Enter your npm automation token: "
        read -rs npm_token
        echo
        gh secret set NPM_TOKEN --body "$npm_token" --repo "${OWNER}/${REPO}"
        echo -e "${GREEN}✓${NC} NPM_TOKEN secret added"
    else
        echo -e "${YELLOW}⚠️  Skipping npm token. You'll need to add it later for npm publishing.${NC}"
        echo "   Generate one at: https://www.npmjs.com/settings/~/tokens"
    fi
    
    # Optional: Snyk token
    echo -n "Do you have a Snyk token? (y/n): "
    read -r has_snyk_token
    
    if [[ "$has_snyk_token" == "y" ]]; then
        echo -n "Enter your Snyk token: "
        read -rs snyk_token
        echo
        gh secret set SNYK_TOKEN --body "$snyk_token" --repo "${OWNER}/${REPO}"
        echo -e "${GREEN}✓${NC} SNYK_TOKEN secret added"
    fi
}

# Function to set up branch protection
setup_branch_protection() {
    echo -e "\n${YELLOW}🛡️  Setting up branch protection...${NC}"
    
    # Check if main branch exists
    if git show-ref --verify --quiet refs/heads/main; then
        echo "Setting up protection for 'main' branch..."
        
        # Create the protection rule
        gh api \
            --method PUT \
            -H "Accept: application/vnd.github+json" \
            "/repos/${OWNER}/${REPO}/branches/main/protection" \
            --input .github/branch-protection.json \
            2>/dev/null && echo -e "${GREEN}✓${NC} Main branch protection enabled" || echo -e "${YELLOW}⚠️  Could not set branch protection. You may need to do this manually.${NC}"
    else
        echo -e "${YELLOW}⚠️  Main branch not found. Create it first, then run this script again.${NC}"
    fi
}

# Function to create initial labels
create_labels() {
    echo -e "\n${YELLOW}🏷️  Creating GitHub labels...${NC}"
    
    # Create labels for the workflows
    gh label create "dependencies" --description "Dependency updates" --color "0366d6" --repo "${OWNER}/${REPO}" 2>/dev/null || true
    gh label create "javascript" --description "JavaScript/TypeScript related" --color "f1e05a" --repo "${OWNER}/${REPO}" 2>/dev/null || true
    gh label create "docker" --description "Docker related" --color "0db7ed" --repo "${OWNER}/${REPO}" 2>/dev/null || true
    gh label create "github-actions" --description "GitHub Actions related" --color "000000" --repo "${OWNER}/${REPO}" 2>/dev/null || true
    
    echo -e "${GREEN}✓${NC} Labels created"
}

# Main setup flow
echo -e "\n${YELLOW}Starting setup process...${NC}"

# Update placeholders
update_placeholders

# Set up secrets
setup_secrets

# Create labels
create_labels

# Set up branch protection
setup_branch_protection

# Final instructions
echo -e "\n${GREEN}🎉 CI/CD setup complete!${NC}"
echo -e "\n${YELLOW}Next steps:${NC}"
echo "1. Review and commit the changes:"
echo "   git add -A"
echo "   git commit -m 'chore: configure CI/CD pipeline'"
echo "   git push"
echo ""
echo "2. If you skipped the npm token, add it in GitHub:"
echo "   Settings → Secrets and variables → Actions → New repository secret"
echo "   Name: NPM_TOKEN"
echo ""
echo "3. Create a 'develop' branch for development work:"
echo "   git checkout -b develop"
echo "   git push -u origin develop"
echo ""
echo "4. Your first release:"
echo "   - Make changes and commit with conventional commits"
echo "   - Push to main branch or trigger release workflow manually"
echo ""
echo "5. Add status badges to your README.md:"
echo "   [![CI/CD](https://github.com/${OWNER}/${REPO}/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/${OWNER}/${REPO}/actions/workflows/ci-cd.yml)"
echo "   [![npm version](https://badge.fury.io/js/${REPO}.svg)](https://www.npmjs.com/package/${REPO})"
echo ""
echo "📚 Full documentation: docs/CI-CD-GUIDE.md"