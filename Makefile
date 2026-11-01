.PHONY: install validate lint format test test-coverage build audit ci

install:
	npm ci

validate:
	npm run validate

lint:
	npm run lint

format:
	npm run format

test:
	npm test

test-coverage:
	npm run test:coverage

build:
	npm run build

audit:
	npm run audit

ci:
	npm run ci
