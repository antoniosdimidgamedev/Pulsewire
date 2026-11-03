.PHONY: help run start dev preview test check lint fmt fmt-check verify build build-linux build-windows clean

# Default target shows the available commands.
.DEFAULT_GOAL := help

help: ## Show this help
	@echo "Pulsewire"
	@echo ""
	@echo "Usage: make <target>"
	@echo ""
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

run start: ## Start the TUI with your resolved configuration
	deno task start

dev: ## Start the TUI with the local demo provider
	deno task dev

ai: ## Start the demo with local AI replies (Ollama or compatible server)
	deno task start --demo --ai

preview: ## Print a static preview of the interface
	deno task preview

test: ## Run the test suite
	deno task test

check: ## Type-check source, scripts, and tests
	deno task check

lint: ## Lint source, scripts, and tests
	deno task lint

fmt: ## Format the project
	deno task fmt

fmt-check: ## Verify formatting without changing files
	deno task fmt:check

verify: ## Run every check used by CI
	deno task fmt:check
	deno task lint
	deno task check
	deno task test

build: build-linux build-windows ## Build Linux and Windows binaries

build-linux: ## Build the Linux binary at dist/pulsewire-linux
	deno task compile:linux

build-windows: ## Build the Windows binary at dist/pulsewire.exe
	deno task compile:windows

clean: ## Remove build output
	deno eval 'await Deno.remove("dist", { recursive: true }).catch(() => undefined)'
