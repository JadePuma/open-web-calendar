.PHONY: activate-env
activate-env:
	source ENV/Scripts/activate

dev:
	watchmedo auto-restart --patterns="*.py,*.css,*.js" --recursive -- python3 app.py
