PYTHON ?= python3
PYTHONPATH := .
DTF := PYTHONPATH=$(PYTHONPATH) $(PYTHON) -m dtf.cli

NAME ?=
NAME_ARGS := $(if $(strip $(NAME)),--name "$(NAME)",)
PORT ?= 4747
SERVE_PATHS ?= ./shared
TARGETS ?=
PEER ?= 127.0.0.1:4747
KIND ?= all
QUERY ?=
FILE_ID ?= 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
OUTPUT ?= ./downloaded-file
ARGS ?=

FIRST_GOAL := $(firstword $(MAKECMDGOALS))
UI_FOLDER_ARGS := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
UI_SERVE_PATH := $(or $(firstword $(UI_FOLDER_ARGS)),$(SERVE_PATHS))

ifeq ($(filter tui web,$(FIRST_GOAL)),$(FIRST_GOAL))
$(UI_FOLDER_ARGS):
	@:
endif

.PHONY: serve peers find download tui web test

serve:
	$(DTF) $(NAME_ARGS) --port $(PORT) serve $(SERVE_PATHS) $(ARGS)

peers:
	$(DTF) $(NAME_ARGS) --port $(PORT) peers $(TARGETS) $(ARGS)

find:
	$(DTF) find $(PEER) --kind $(KIND) --query "$(QUERY)" $(ARGS)

download:
	$(DTF) download $(PEER) $(FILE_ID) $(OUTPUT) $(ARGS)

tui:
	@if [ "$(words $(UI_FOLDER_ARGS))" -gt 1 ]; then echo "Usage: make tui [folder]"; exit 2; fi
	$(DTF) $(NAME_ARGS) --port $(PORT) tui $(UI_SERVE_PATH) $(ARGS)

web:
	@if [ "$(words $(UI_FOLDER_ARGS))" -gt 1 ]; then echo "Usage: make web [folder]"; exit 2; fi
	$(DTF) $(NAME_ARGS) --port $(PORT) web $(UI_SERVE_PATH) --host 127.0.0.1 --web-port 8080 $(ARGS)

test:
	PYTHONPATH=$(PYTHONPATH) $(PYTHON) -m unittest discover -s tests
