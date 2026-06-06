PYTHON ?= python3
PYTHONPATH := .
DTF := PYTHONPATH=$(PYTHONPATH) $(PYTHON) -m dtf.cli

NAME ?= alice
PORT ?= 4747
SERVE_PATHS ?= ./shared
PEER ?= 127.0.0.1:4747
KIND ?= all
QUERY ?=
FILE_ID ?= 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
OUTPUT ?= ./downloaded-file
ARGS ?=

.PHONY: serve find download test

serve:
	$(DTF) --name $(NAME) --port $(PORT) serve $(SERVE_PATHS) $(ARGS)

find:
	$(DTF) find $(PEER) --kind $(KIND) --query "$(QUERY)" $(ARGS)

download:
	$(DTF) download $(PEER) $(FILE_ID) $(OUTPUT) $(ARGS)

test:
	PYTHONPATH=$(PYTHONPATH) $(PYTHON) -m unittest discover -s tests
