PYTHON ?= python3
PYTHONPATH := .
DTF := PYTHONPATH=$(PYTHONPATH) $(PYTHON) -m dtf.cli

NAME ?=
NAME_ARGS := $(if $(strip $(NAME)),--name "$(NAME)",)
PORT ?= 4747
SERVE_PATHS ?= ./shared
TARGETS ?= 255.255.255.255
PEER ?= 127.0.0.1:4747
KIND ?= all
QUERY ?=
FILE_ID ?= 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
OUTPUT ?= ./downloaded-file
ARGS ?=

.PHONY: serve peers find download tui test

serve:
	$(DTF) $(NAME_ARGS) --port $(PORT) serve $(SERVE_PATHS) $(ARGS)

peers:
	$(DTF) $(NAME_ARGS) --port $(PORT) peers $(TARGETS) $(ARGS)

find:
	$(DTF) find $(PEER) --kind $(KIND) --query "$(QUERY)" $(ARGS)

download:
	$(DTF) download $(PEER) $(FILE_ID) $(OUTPUT) $(ARGS)

tui:
	$(DTF) $(NAME_ARGS) --port $(PORT) tui $(SERVE_PATHS) $(ARGS)

test:
	PYTHONPATH=$(PYTHONPATH) $(PYTHON) -m unittest discover -s tests
