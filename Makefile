.PHONY: help dev

# This Makefile is primarily for Windows-style virtualenv layouts.
# The repository currently has a local venv at `venv/` (not `ENV/`).
VENV ?= venv
PY := $(VENV)/Scripts/python
WATCHMEDO := $(VENV)/Scripts/watchmedo

help:
	@echo "Targets:"
	@echo "  dev   - run with auto-reload (requires watchdog/watchmedo in the venv)"
	@echo ""
	@echo "Notes:"
	@echo "  - If you do not have 'make' installed, run the dev command directly:"
	@echo "      $(WATCHMEDO) auto-restart --patterns=\"*.py,*.css,*.js\" --recursive -- $(PY) app.py"
	@echo "  - If your venv folder is not named 'venv', call: make dev VENV=.venv"

dev:
	$(WATCHMEDO) auto-restart --patterns="*.py,*.css,*.js" --recursive -- $(PY) app.py
