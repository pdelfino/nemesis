# One command to run Nemesis locally (#88). Every target is a thin wrapper
# over the npm scripts in package.json, which stay the single definition of
# what dev and gate mean.

.DEFAULT_GOAL := help
.PHONY: help node-version setup dev gate app app-hardened app-signed verify-app ci

# Make runs /bin/sh, where nvm is a shell function and not a command, so a
# fresh terminal has no `nvm use` in effect. Source nvm.sh here and put the
# Node named by .nvmrc first on PATH; without nvm, the PATH node is checked.
NODE_WANT := $(shell sed 's/^v//; s/\..*//' .nvmrc)
NVM_SH := $(or $(NVM_DIR),$(HOME)/.nvm)/nvm.sh
NVM_NODE := $(shell [ -s "$(NVM_SH)" ] && . "$(NVM_SH)" >/dev/null 2>&1 && nvm which "$(NODE_WANT)" 2>/dev/null | grep '^/')
# GNU Make 3.81 (the macOS one) looks up a recipe's command with its own
# PATH and ignores the exported one, so npm is also named by its full path;
# the export still reaches npm's `#!/usr/bin/env node` and the scripts.
NPM := npm
ifneq ($(NVM_NODE),)
export PATH := $(patsubst %/,%,$(dir $(NVM_NODE))):$(PATH)
NPM := $(dir $(NVM_NODE))npm
endif

help: ## List the targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-8s\033[0m %s\n", $$1, $$2}'

# $(error) rather than a shell exit, so the last line printed is the fix and
# not Make's own "Error 1" line. It also fires under make -n.
NODE_HAVE = $(shell PATH="$(PATH)" node --version 2>/dev/null | sed 's/^v//; s/\..*//')
NODE_FIX = Node $(NODE_WANT) is required by .nvmrc but found $(or $(NODE_HAVE),none). Run: source ~/.nvm/nvm.sh && nvm install && nvm use

node-version:
	$(if $(filter $(NODE_WANT),$(NODE_HAVE)),,$(error $(NODE_FIX)))

setup: node-version ## Install dependencies and the Electron binary (safe to rerun)
	$(NPM) ci --ignore-scripts
	$(NPM) run electron:install

dev: node-version node_modules/electron/dist ## Run the app in development mode, installing first if needed
	$(NPM) run dev

gate: node-version ## Run the gate, the same as npm run gate
	$(NPM) run gate

# The workflow itself, run on this Mac before anything is pushed (Pedro,
# 2026-OCTOBER-19: local first, Actions only after a green local run). act runs
# the gate job of .github/workflows/ci.yml on the host: a clean npm ci, the
# Electron binary, the gate and npm audit, as the macOS runner would. act is
# optional (brew install act); the secret scan job needs Docker and runs on
# GitHub only.
ci: ## Run the CI workflow's gate job locally with act, before a push
	@command -v act >/dev/null || { echo "make ci needs act: brew install act"; exit 1; }
	GITHUB_TOKEN="$$(gh auth token)" act pull_request -W .github/workflows/ci.yml -j gate -P macos-latest=-self-hosted -s GITHUB_TOKEN

app: node-version node_modules/electron/dist ## Build the unsigned release/mac-arm64/Nemesis.app (#35)
	$(NPM) run package

app-hardened: node-version node_modules/electron/dist ## Build Nemesis.app ad hoc under the hardened runtime and check it (#36; no Apple account needed)
	$(NPM) run package:hardened
	node scripts/release-check.mjs --hardened

app-signed: node-version node_modules/electron/dist ## Build, sign with the Developer ID, notarize and staple Nemesis.app, then check it (#36)
	@test -n "$$APPLE_API_KEY" && test -n "$$APPLE_API_KEY_ID" && test -n "$$APPLE_API_ISSUER" || { echo "make app-signed needs APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER in the environment (#36); it never builds unsigned instead"; exit 1; }
	@test -f "$$APPLE_API_KEY" || { echo "APPLE_API_KEY must be the path of the .p8 key file, kept outside every repository (#36)"; exit 1; }
	@security find-identity -v -p codesigning | grep -q '"Developer ID Application:' || { echo "make app-signed needs a Developer ID Application certificate in the login keychain (#36)"; exit 1; }
	$(NPM) run package:signed
	@$(MAKE) --no-print-directory verify-app

verify-app: ## Check a signed Nemesis.app as a release: Developer ID, hardened runtime, entitlements, notarized, stapled (#36)
	node scripts/release-check.mjs --distribution

node_modules/electron/dist:
	@$(MAKE) --no-print-directory setup
