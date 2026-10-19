# One command to run Nemesis locally (#88). Every target is a thin wrapper
# over the npm scripts in package.json, which stay the single definition of
# what dev and gate mean.

.DEFAULT_GOAL := help
.PHONY: help node-version setup dev gate

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

node_modules/electron/dist:
	@$(MAKE) --no-print-directory setup
